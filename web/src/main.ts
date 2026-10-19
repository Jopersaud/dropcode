import { RateMeter, formatBytes, formatDuration, percent } from "./progress.ts";
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
    else status.textContent = STATUS[p as Phase] ?? "";
    if (p === "transferring") this.meter.reset();
    if (p === "done") this.progress(this.total, this.total);
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
    $(`${this.prefix}-status`).textContent = "";
    $(`${this.prefix}-stats`).textContent = "";
    this.bar.style.width = "0";
    this.meter.reset();
  }
}

// ---------------------------------------------------------------- sending

const sendPanel = new Panel($("send"), "send");
const fileInput = $<HTMLInputElement>("send-file");
const dropZone = $("drop-zone");
let sender: Sender | null = null;
let expiryTimer = 0;

function startSend(file: File) {
  if (sender) return;
  sendPanel.reset();
  $("send-notice").hidden = true;
  $("send-name").textContent = file.name;
  $("send-size").textContent = formatBytes(file.size);
  $("send-code").textContent = "";
  let code = "";
  sender = new Sender(file, {
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
    },
    onHashProgress: (d, t) => {
      if (sendPanel.section.dataset.phase !== "waiting") return;
      $("send-status").textContent =
        d < t ? `Waiting for the receiver… (preparing file: ${Math.floor(percent(d, t))}%)` : "Waiting for the receiver…";
    },
    onProgress: (d, t) => sendPanel.progress(d, t),
    onAuthFailure: (n, max) =>
      notice(
        `Someone connected with the wrong code and was rejected (${n} of ${max} attempts; ` +
          `the code is disabled after ${max}). Still waiting for the real receiver.`,
      ),
    onPeerUnreachable: () =>
      notice("A receiver tried to connect but no direct connection could be made. Still waiting."),
    onError: (e) =>
      sendPanel.error(e, e.code === "expired" ? "This code expired before anyone used it. Start again for a new one." : undefined),
  });
  $("copy-code").onclick = () => copy(code, $("copy-code"));
  $("copy-link").onclick = () => copy(`${location.origin}/#${code}`, $("copy-link"));
  (window as unknown as { __sender: Sender }).__sender = sender;
  sender.start();
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
  const f = fileInput.files?.[0];
  if (f) startSend(f);
  fileInput.value = "";
});

// Drag and drop: the whole window accepts a drop while the send card is idle.
let dragDepth = 0;
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e) || sender) return;
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
    e.dataTransfer!.dropEffect = sender ? "none" : "copy";
  }
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const files = e.dataTransfer?.files;
  if (!files?.length || sender) return;
  if (files.length > 1) {
    $("send-status").textContent = "Drop one file at a time (zip folders or multiple files first).";
    return;
  }
  startSend(files[0]!);
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
  if (downloadLink.href) URL.revokeObjectURL(downloadLink.href);
  downloadLink.removeAttribute("href");
  let savedName = "";
  receiver = new Receiver(recvCode.value, {
    onPhase: (p) => recvPanel.phase(p, `Received ${savedName}. Checksum verified.`),
    onMeta: (m) => {
      savedName = m.name;
      $("receive-name").textContent = m.name;
      $("receive-size").textContent = formatBytes(m.size);
      recvPanel.section.dataset.hasMeta = "";
    },
    onProgress: (d, t) => recvPanel.progress(d, t),
    onError: (e) => recvPanel.error(e),
    onComplete: ({ blob, name }) => {
      downloadLink.href = URL.createObjectURL(blob);
      downloadLink.download = name;
      downloadLink.textContent = `Save ${name}`;
      downloadLink.click();
    },
  });
  (window as unknown as { __receiver: Receiver }).__receiver = receiver;
  receiver.start();
});

$("receive-cancel").addEventListener("click", () => receiver?.cancel());
$("receive-reset").addEventListener("click", () => {
  receiver = null;
  recvPanel.reset();
  recvCode.select();
});

// Share links look like https://host/#4-apple-river. The fragment never reaches the server.
if (location.hash.length > 1) {
  recvCode.value = decodeURIComponent(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);
}
