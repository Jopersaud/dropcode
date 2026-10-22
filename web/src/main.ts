import { loadNetMode, saveNetMode, isNetMode, type NetMode } from "./netmode.ts";
import { RateMeter, formatBytes, formatDuration, percent } from "./progress.ts";
import type { RouteInfo } from "./route.ts";
import { encodeQr, qrSvg } from "./qr.ts";
import { buildZip, isBundle, readZip, ZIP_MAX_BYTES, type ZipEntry } from "./zip.ts";
import { Receiver, Sender, type ErrorCode, type Phase, type TransferError } from "./transfer.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ERRORS: Record<ErrorCode, string> = {
  bad_code: "That doesn't look like a dropcode. Codes look like 4-apple-river.",
  not_found: "No transfer is waiting for that code. Check it and try again.",
  expired: "This code has expired. Ask the sender for a new one.",
  used: "This code was already used. Codes only work once.",
  burned: "Too many wrong attempts, so this code was disabled. Ask the sender for a new one.",
  room_full: "Someone else is already receiving with this code.",
  rate_limited: "Too many attempts from your network. Wait a minute and try again.",
  peer_disconnected: "The other side disconnected.",
  cancelled_by_peer: "The other side cancelled the transfer.",
  hash_mismatch: "The file arrived corrupted (checksum mismatch) and was discarded.",
  auth_failed: "Couldn't verify the other side. The code may be wrong, or someone may be interfering with the connection.",
  too_large: "This file is too large to receive in a browser (limit 2 GB). Use the dropcode CLI instead.",
  connection_failed: "Couldn't open a direct connection between you. A TURN relay may be needed on this network.",
  signaling_failed: "Lost the connection to the dropcode server.",
  protocol: "Something went wrong (protocol error).",
};

const STATUS: Partial<Record<Phase, string>> = {
  connecting: "Connecting to server…",
  waiting: "Waiting for the receiver…",
  "connecting-peer": "Connecting to peer…",
  authenticating: "Verifying the code with the other side…",
  verifying: "Verifying checksum…",
  reconnecting: "Connection lost, trying to reconnect…",
  cancelled: "Cancelled.",
};

/** Shared rendering of progress, status and errors for one card. */
class Panel {
  private meter = new RateMeter();
  private done = 0;
  private total = 0;
  private raf = 0;
  private bar: HTMLElement;
  private barWrap: HTMLElement;

  constructor(
    readonly section: HTMLElement,
    private readonly prefix: "send" | "receive",
  ) {
    this.bar = $(`${prefix}-bar`);
    this.barWrap = this.bar.parentElement!;
  }

  phase(p: Phase | "idle", doneText?: string) {
    this.section.dataset.phase = p;
    const status = $(`${this.prefix}-status`);
    if (p === "done") status.textContent = doneText ?? "Done.";
    else if (p === "reconnecting" && this.prefix === "send")
      status.textContent = "Connection to the receiver lost. Keep this page open: the transfer resumes where it left off when they reconnect.";
    else if (p === "reconnecting")
      status.textContent = "Connection lost. Reconnecting; the transfer will resume where it left off…";
    else status.textContent = STATUS[p as Phase] ?? "";
    if (p === "transferring") this.meter.reset();
    if (p === "done") this.progress(this.total, this.total);
  }

  route(r: RouteInfo) {
    const el = $(`${this.prefix}-route`);
    el.textContent = r.label;
    el.title = r.detail;
    el.dataset.kind = r.kind;
    el.hidden = false;
  }

  error(e: TransferError, override?: string) {
    this.section.dataset.error = e.code;
    const el = $(`${this.prefix}-error`);
    el.textContent = override ?? ERRORS[e.code] ?? e.message;
    el.hidden = false;
  }

  progress(done: number, total: number) {
    this.done = done;
    this.total = total;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.render());
  }

  private render() {
    this.raf = 0;
    const { done, total } = this;
    this.meter.update(done);
    const p = percent(done, total);
    this.bar.style.width = `${p}%`;
    this.barWrap.setAttribute("aria-valuenow", String(Math.floor(p)));
    const parts = [`${p.toFixed(p < 100 ? 1 : 0)}%`, `${formatBytes(done)} of ${formatBytes(total)}`];
    if (done < total) {
      const rate = this.meter.rate;
      if (rate > 0) parts.push(`${formatBytes(rate)}/s`, `${formatDuration(this.meter.eta(total))} left`);
    }
    $(`${this.prefix}-stats`).textContent = parts.join(" · ");
    $(`${this.prefix}-stats`).dataset.percent = String(p);
  }

  reset() {
    this.section.dataset.phase = "idle";
    delete this.section.dataset.error;
    delete this.section.dataset.hasMeta;
    $(`${this.prefix}-error`).hidden = true;
    $(`${this.prefix}-route`).hidden = true;
    $(`${this.prefix}-status`).textContent = "";
    $(`${this.prefix}-stats`).textContent = "";
    this.bar.style.width = "0";
    this.meter.reset();
  }
}

// -------------------------------------------------------------- net mode

const LOCAL_MODE_FAILURE =
  "Couldn't connect. \"Same network only\" is on, so both devices must be on this network. " +
  "Switch to \"Any network\" to let the transfer cross networks.";

let netMode: NetMode = loadNetMode();

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="net-mode"]')) {
  input.checked = input.value === netMode;
  input.addEventListener("change", () => {
    if (!input.checked || !isNetMode(input.value)) return;
    netMode = input.value;
    saveNetMode(netMode);
  });
}

/**
 * A relay-only server cannot honour "same network only", so the choice is taken
 * away rather than silently ignored. The policy arrives with the server's hello,
 * which is why this runs on the first transfer rather than at load.
 */
function applyServerPolicy(policy: "all" | "relay") {
  if (policy !== "relay") return;
  const note = $("net-mode-note");
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name="net-mode"]')) {
    if (input.value === "local") input.disabled = true;
    if (input.value === "any") input.checked = true;
  }
  netMode = "any";
  note.textContent = "This server requires every transfer to go through a relay, so same-network mode is unavailable.";
  note.hidden = false;
}

// ---------------------------------------------------------------- sending

const sendPanel = new Panel($("send"), "send");
const fileInput = $<HTMLInputElement>("send-file");
const dropZone = $("drop-zone");
let sender: Sender | null = null;
let expiryTimer = 0;

/** Guards the async bundling window, during which `sender` is not yet set. */
let preparing = false;

/** Return the card to idle so another selection can be made. */
function abortSelection(message: string) {
  sendPanel.section.dataset.phase = "idle";
  $("send-files").hidden = true;
  $("qr").hidden = true;
  $("send-status").textContent = message;
}

function listSelection(files: File[]) {
  const list = $("send-files");
  list.replaceChildren(
    ...files.map((f) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = f.name;
      const size = document.createElement("span");
      size.className = "file-size";
      size.textContent = formatBytes(f.size);
      li.append(name, size);
      return li;
    }),
  );
  list.hidden = files.length < 2;
}

async function startSend(files: File[]) {
  if (sender || preparing || !files.length) return;
  preparing = true;
  try {
    await beginSend(files);
  } finally {
    preparing = false;
  }
}

/**
 * More than one file is bundled into a stored zip, which the receiver expands
 * again. One file is sent exactly as before, with no wrapper.
 */
async function beginSend(files: File[]) {
  sendPanel.reset();
  $("send-notice").hidden = true;
  listSelection(files);
  const total = files.reduce((n, f) => n + f.size, 0);
  $("send-name").textContent = files.length === 1 ? files[0]!.name : `${files.length} files`;
  $("send-size").textContent = formatBytes(total);
  $("send-code").textContent = "";

  let file = files[0]!;
  if (files.length > 1) {
    if (total > ZIP_MAX_BYTES) {
      abortSelection(`That selection is ${formatBytes(total)}; a bundle is limited to 4 GB. Send fewer files.`);
      return;
    }
    try {
      // Leave the idle phase so the drop zone gives way to the selection.
      sendPanel.section.dataset.phase = "connecting";
      $("send-status").textContent = `Preparing ${files.length} files…`;
      const { blob } = await buildZip(files, (d, t) => {
        $("send-status").textContent = `Preparing ${files.length} files… ${Math.floor(percent(d, t))}%`;
      });
      file = new File([blob], `dropcode-${files.length}-files.zip`, { type: "application/zip" });
    } catch {
      abortSelection("Couldn't prepare those files for sending.");
      return;
    }
  }

  let code = "";
  sender = new Sender(file, {
    onRoute: (r) => sendPanel.route(r),
    onServerPolicy: applyServerPolicy,
    onPhase: (p) => {
      sendPanel.phase(p, "Sent! The receiver has the file and its checksum matched.");
      if (p !== "waiting") clearInterval(expiryTimer);
    },
    onCode: (c, expiresAt) => {
      code = c;
      $("send-code").textContent = c;
      const tick = () => {
        const left = Math.max(0, (expiresAt - Date.now()) / 1000);
        $("send-expiry").textContent = `Code expires in ${formatDuration(left)}.`;
      };
      tick();
      clearInterval(expiryTimer);
      expiryTimer = window.setInterval(tick, 1000);
      showQr(`${location.origin}/#${c}`);
    },
    onHashProgress: (d, t) => {
      if (sendPanel.section.dataset.phase !== "waiting") return;
      const what = files.length > 1 ? `${files.length} files` : "file";
      $("send-status").textContent =
        d < t ? `Waiting for the receiver… (preparing ${what}: ${Math.floor(percent(d, t))}%)` : "Waiting for the receiver…";
    },
    onProgress: (d, t) => sendPanel.progress(d, t),
    onAuthFailure: (n, max) =>
      notice(
        `Someone connected with the wrong code and was rejected (${n} of ${max} attempts; ` +
          `the code is disabled after ${max}). Still waiting for the real receiver.`,
      ),
    onPeerUnreachable: () => notice(peerUnreachableText()),
    onError: (e) => sendPanel.error(e, sendErrorText(e.code)),
  }, { netMode });
  $("copy-code").onclick = () => copy(code, $("copy-code"));
  $("copy-link").onclick = () => copy(`${location.origin}/#${code}`, $("copy-link"));
  (window as unknown as { __sender: Sender }).__sender = sender;
  sender.start();
}

/** The same symptom has two very different causes, so name the likely one. */
function peerUnreachableText(): string {
  return netMode === "local"
    ? '"Same network only" is on, so a receiver on another network can never connect. ' +
        'Switch to "Any network" and send a new code.'
    : "A receiver tried to connect but no direct path could be opened between your networks — " +
        "theirs or yours likely needs a TURN relay. Still waiting.";
}

function sendErrorText(code: ErrorCode): string | undefined {
  if (code === "expired") return "This code expired before anyone used it. Start again for a new one.";
  if (code === "connection_failed" && netMode === "local") return LOCAL_MODE_FAILURE;
  return undefined;
}

/**
 * Show the share link as a QR code so the other device can scan instead of
 * typing. A link too long to encode simply leaves the code and buttons to do
 * the job rather than showing a symbol that will not scan.
 */
function showQr(link: string) {
  const box = $("qr-box");
  const qr = encodeQr(link, "M");
  if (!qr) {
    $("qr").hidden = true;
    return;
  }
  box.replaceChildren(qrSvg(qr, { title: `QR code for ${link}` }));
  $("qr").hidden = false;
}

function notice(text: string) {
  const el = $("send-notice");
  el.textContent = text;
  el.hidden = false;
}

async function copy(text: string, btn: HTMLElement) {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = label), 1500);
}

fileInput.addEventListener("change", () => {
  const picked = [...(fileInput.files ?? [])];
  if (picked.length) void startSend(picked);
  fileInput.value = "";
});

// Drag and drop: the whole window accepts a drop while the send card is idle.
let dragDepth = 0;
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e) || sender || preparing) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("dragging");
  }
});
window.addEventListener("dragover", (e) => {
  if (hasFiles(e)) {
    e.preventDefault();
    e.dataTransfer!.dropEffect = sender || preparing ? "none" : "copy";
  }
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const files = e.dataTransfer?.files;
  if (!files?.length || sender || preparing) return;
  void startSend([...files]);
});
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

$("send-cancel").addEventListener("click", () => sender?.cancel());
$("send-reset").addEventListener("click", () => {
  sender = null;
  $("send-files").hidden = true;
  $("qr").hidden = true;
  clearInterval(expiryTimer);
  sendPanel.reset();
});

// -------------------------------------------------------------- receiving

const recvPanel = new Panel($("receive"), "receive");
const recvForm = $<HTMLFormElement>("receive-form");
const recvCode = $<HTMLInputElement>("receive-code");
const downloadLink = $<HTMLAnchorElement>("download-link");
let receiver: Receiver | null = null;

recvForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (receiver) return;
  recvPanel.reset();
  $("receive-bundle").hidden = true;
  $("receive-files").replaceChildren();
  if (downloadLink.href) URL.revokeObjectURL(downloadLink.href);
  downloadLink.removeAttribute("href");
  let savedName = "";
  receiver = new Receiver(recvCode.value, {
    onRoute: (r) => recvPanel.route(r),
    onServerPolicy: applyServerPolicy,
    onPhase: (p) => recvPanel.phase(p, `Received ${savedName}. Checksum verified.`),
    onMeta: (m) => {
      savedName = m.name;
      $("receive-name").textContent = m.name;
      $("receive-size").textContent = formatBytes(m.size);
      recvPanel.section.dataset.hasMeta = "";
    },
    onProgress: (d, t) => recvPanel.progress(d, t),
    onError: (e) =>
      recvPanel.error(e, e.code === "connection_failed" && netMode === "local" ? LOCAL_MODE_FAILURE : undefined),
    onComplete: ({ blob, name }) => void deliver(blob, name),
  }, { netMode });
  (window as unknown as { __receiver: Receiver }).__receiver = receiver;
  receiver.start();
});


// ------------------------------------------------------------ delivery

/** Enough to let a phone's share sheet offer "Save to Photos" rather than a generic file. */
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", heic: "image/heic", avif: "image/avif",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
  pdf: "application/pdf", txt: "text/plain", json: "application/json", zip: "application/zip",
};

const mimeFor = (name: string) =>
  MIME_BY_EXT[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

/** Hand a blob to the browser as a download, revoking the URL once it has been taken. */
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * A bundle is expanded in the browser so the receiver gets real files rather
 * than an archive to deal with; the archive itself stays available for anyone
 * who would rather have the one file.
 */
async function deliver(blob: Blob, name: string) {
  const entries = (await isBundle(blob)) ? await readZip(blob) : null;
  if (!entries?.length) {
    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.download = name;
    downloadLink.textContent = `Save ${name}`;
    downloadLink.click();
    return;
  }
  showBundle(entries, blob, name);
}

function showBundle(entries: ZipEntry[], archive: Blob, archiveName: string) {
  const total = entries.reduce((n, e) => n + e.size, 0);
  $("receive-bundle-hint").textContent =
    `${entries.length} files received (${formatBytes(total)}). Checksum verified.`;

  $("receive-files").replaceChildren(
    ...entries.map((e) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = e.name;
      const size = document.createElement("span");
      size.className = "file-size";
      size.textContent = formatBytes(e.size);
      const save = document.createElement("button");
      save.type = "button";
      save.className = "secondary small";
      save.textContent = "Save";
      save.onclick = () => download(e.blob(), e.name);
      li.append(name, size, save);
      return li;
    }),
  );

  // Built synchronously from lazy slices, so the click gesture survives into
  // navigator.share(), which Safari requires.
  const asFiles = () => entries.map((e) => new File([e.blob()], e.name, { type: mimeFor(e.name) }));

  $("save-all").onclick = async () => {
    const files = asFiles();
    if (navigator.canShare?.({ files })) {
      try {
        await navigator.share({ files });
        return;
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return; // the user dismissed the sheet
      }
    }
    // Browsers throttle rapid programmatic downloads; space them out.
    for (const f of files) {
      download(f, f.name);
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  $("save-zip").onclick = () => download(archive, archiveName);
  $("receive-bundle").hidden = false;
}

$("receive-cancel").addEventListener("click", () => receiver?.cancel());
$("receive-reset").addEventListener("click", () => {
  receiver = null;
  $("receive-bundle").hidden = true;
  $("receive-files").replaceChildren();
  recvPanel.reset();
  recvCode.select();
});

// Share links look like https://host/#4-apple-river. The fragment never reaches the server.
if (location.hash.length > 1) {
  recvCode.value = decodeURIComponent(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);
}
