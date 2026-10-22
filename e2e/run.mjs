// End-to-end scenarios. Usage: node e2e/run.mjs [scenario ...]
import { join } from "node:path";
import { mitmPageScript, startEvilServer } from "./evil-server.mjs";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { assert, cliBin, runCli, launch, makeFile, randomName, sha256File, startServer, tmp } from "./lib.mjs";
import { encodeQr } from "../web/src/qr.ts";

const SIZE = Number(process.env.E2E_SIZE ?? 50 * 1024 * 1024);

async function sendAndGetCode(page, url, filePath) {
  await page.goto(url);
  await page.setInputFiles("#send-file", filePath);
  await page.waitForSelector("#send-code:not([hidden])", { timeout: 15_000 });
  return (await page.textContent("#send-code")).trim();
}

async function startReceive(page, url, code) {
  await page.goto(url);
  await page.fill("#receive-code", code);
  await page.click("#receive-btn");
}

const waitPercent = (page, sel, min) =>
  page
    .waitForFunction(
      ([sel, min]) => Number(document.querySelector(sel)?.dataset.percent ?? 0) >= min,
      [sel, min],
      { timeout: 60_000, polling: 50 },
    )
    .catch(async (e) => {
      const state = await page.evaluate(() =>
        ["send", "receive"].map((id) => {
          const el = document.getElementById(id);
          return `${id}: phase=${el.dataset.phase} error=${el.dataset.error ?? ""} status="${document.getElementById(id + "-status").textContent}"`;
        }),
      );
      throw new Error(`${e.message}\n  page state: ${state.join("; ")}`);
    });

/** Start a transfer of a fresh random file and return both pages once bytes are flowing. */
async function midTransfer({ server, newPage }, size = 100 * 1024 * 1024, senderInit) {
  const file = await makeFile(randomName(), size);
  const sender = await newPage();
  if (senderInit) await sender.addInitScript(senderInit);
  const receiver = await newPage();
  const code = await sendAndGetCode(sender, server.url, file.path);
  await startReceive(receiver, server.url, code);
  await waitPercent(receiver, "#receive-stats", 3);
  return { file, sender, receiver, code };
}

/** Wait until a card shows an error, then check it is the expected one. */
async function expectError(page, card, code, timeout = 20_000) {
  await page.waitForSelector(`#${card}[data-error]`, { timeout }).catch(async (e) => {
    throw new Error(`no error on #${card} (phase=${await page.getAttribute(`#${card}`, "data-phase")}): ${e.message}`);
  });
  const got = await page.getAttribute(`#${card}`, "data-error");
  assert(got === code, `#${card} error: expected ${code}, got ${got}`);
}

async function resumeScenario(ctx, breakIt, { expectResume = true } = {}) {
  const size = 64 * 1024 * 1024;
  const { file, sender, receiver } = await midTransfer(ctx, size);
  const dl = receiver.waitForEvent("download", { timeout: 120_000 });
  dl.catch(() => {});
  await waitPercent(receiver, "#receive-stats", 30);
  const before = Number(await receiver.getAttribute("#receive-stats", "data-percent"));
  await breakIt({ sender, receiver });
  if (expectResume) {
    await receiver.waitForSelector('#receive[data-phase="reconnecting"]', { timeout: 15_000 });
    console.log(`  broke at ${before}%; receiver: "${await receiver.textContent("#receive-status")}"`);
  }
  const out = join(tmp, `received-${file.path.split("/").pop()}`);
  await (await dl).saveAs(out);
  assert((await sha256File(out)) === file.sha256, "hash matches after interruption");
  await sender.waitForSelector('#send[data-phase="done"]', { timeout: 10_000 });
  const { sessions, chunksSent } = await sender.evaluate(() => ({
    sessions: window.__sender.sessions,
    chunksSent: window.__sender.chunksSent,
  }));
  const total = Math.ceil(size / 65536);
  console.log(`  sessions: ${JSON.stringify(sessions)}; chunks sent ${chunksSent} for ${total} chunks`);
  if (expectResume) {
    assert(sessions.length === 2, "exactly one resumed session");
    assert(sessions[1].skippedChunks >= Math.floor((total * before) / 100) - 1, "resumed session skipped what the receiver had");
    // At most the in-flight send buffer (4 MiB = 64 chunks) plus a little is resent.
    assert(chunksSent <= total + 128, `resent too much: ${chunksSent - total} extra chunks`);
  } else {
    assert(sessions.length === 1 && chunksSent === total, "transfer continued on the same link");
  }
}

async function freshDir(name) {
  const dir = join(tmp, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

/** The local and remote candidate types of the browser's selected ICE pair. */
async function iceRoute(page, who) {
  return page.evaluate(async (who) => {
    const pc = window[who].link.pc;
    const stats = [...(await pc.getStats()).values()];
    const pair = stats.find((s) => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
    const get = (id) => stats.find((s) => s.id === id);
    return pair ? `${get(pair.localCandidateId).candidateType}->${get(pair.remoteCandidateId).candidateType}` : "none";
  }, who);
}

async function checkRoute(page, who) {
  const route = await iceRoute(page, who);
  console.log(`  ICE route (${who.slice(2)}): ${route}`);
  if (process.env.E2E_EXPECT_RELAY) assert(route.startsWith("relay->"), `expected a TURN relay route, got ${route}`);
}

const wrongCode = (code) => code.replace(/-[a-z]+$/, code.endsWith("-abandon") ? "-zoo" : "-abandon");

const scenarios = {
  async basic({ server, newPage }) {
    const file = await makeFile(randomName(), SIZE);
    const sender = await newPage();
    const receiver = await newPage();
    const code = await sendAndGetCode(sender, server.url, file.path);
    assert(/^[1-9]\d*-[a-z]+-[a-z]+$/.test(code), `code format: ${code}`);
    const t0 = Date.now();
    const dl = receiver.waitForEvent("download", { timeout: 120_000 });
    dl.catch(() => {});
    await startReceive(receiver, server.url, code);
    // Progress UI shows percent, speed and ETA while bytes flow.
    await waitPercent(receiver, "#receive-stats", 20);
    await checkRoute(receiver, "__receiver");
    await checkRoute(sender, "__sender");
    const stats = await receiver.textContent("#receive-stats");
    const sstats = await sender.textContent("#send-stats");
    assert(/%.*of.*\/s.*left/.test(stats), `receiver stats: ${stats}`);
    assert(/%.*of/.test(sstats), `sender stats: ${sstats}`);
    console.log(`  receiver progress: "${stats}"`);
    const download = await dl;
    const out = join(tmp, `received-${file.path.split("/").pop()}`);
    await download.saveAs(out);
    const secs = (Date.now() - t0) / 1000;
    const got = await sha256File(out);
    assert(got === file.sha256, `hash mismatch ${got} != ${file.sha256}`);
    assert(download.suggestedFilename() === file.path.split("/").pop(), "file name preserved");
    await sender.waitForSelector('#send[data-phase="done"]', { timeout: 10_000 });
    await receiver.waitForSelector('#receive[data-phase="done"]', { timeout: 10_000 });
    console.log(`  ${(SIZE / 1048576).toFixed(0)} MB in ${secs.toFixed(1)}s, sha256 ${got.slice(0, 16)}… matches`);

    // The code is single-use.
    const late = await newPage();
    await startReceive(late, server.url, code);
    await expectError(late, "receive", "used", 10_000);
    console.log("  reusing the code fails with 'used'");
  },

  // The share link is offered as a scannable QR code, so a phone can join
  // without anyone typing a URL. The rendered symbol must match what the
  // encoder produces for that exact link.
  async qr({ server, newPage }) {
    const file = await makeFile(randomName(), 1024);
    const sender = await newPage();
    const code = await sendAndGetCode(sender, server.url, file.path);

    await sender.waitForSelector("#qr:not([hidden])", { timeout: 10_000 });
    const got = await sender.$eval("#qr-box svg", (svg) => ({
      viewBox: svg.getAttribute("viewBox"),
      label: svg.getAttribute("aria-label"),
      darks: (svg.querySelector("path").getAttribute("d").match(/M/g) ?? []).length,
    }));

    const link = `${server.url}/#${code}`;
    assert(got.label.includes(link), `QR labelled for ${link}, got ${got.label}`);
    const expected = encodeQr(link, "M");
    assert(expected !== null, "link should be encodable");
    const span = expected.size + 8; // the four-module quiet zone on each side
    assert(got.viewBox === `0 0 ${span} ${span}`, `viewBox ${got.viewBox} != 0 0 ${span} ${span}`);
    const darkCount = expected.modules.filter(Boolean).length;
    assert(got.darks === darkCount, `rendered ${got.darks} dark modules, encoder says ${darkCount}`);
    console.log(`  QR v${expected.version} (${expected.size}x${expected.size}) matches the encoder for the share link`);
  },

  // Several files are bundled into a stored zip on the wire and expanded again
  // in the receiving browser, which must hand back the original files byte for byte.
  async multifile({ server, newPage }) {
    const files = [
      await makeFile("multi-a.bin", 3 * 1024 * 1024),
      await makeFile("multi-b.bin", 1024 * 1024),
      await makeFile("multi-c.bin", 1),
    ];
    const sender = await newPage();
    const receiver = await newPage();
    await sender.goto(server.url);
    await sender.setInputFiles("#send-file", files.map((f) => f.path));
    await sender.waitForSelector("#send-code:not([hidden])", { timeout: 30_000 });
    const code = (await sender.textContent("#send-code")).trim();

    // The sender lists what it is about to send.
    const listed = await sender.$$eval("#send-files .file-name", (n) => n.map((e) => e.textContent));
    assert(listed.length === 3, `sender listed ${listed.length} files`);

    await startReceive(receiver, server.url, code);
    await receiver.waitForSelector("#receive-bundle:not([hidden])", { timeout: 120_000 });
    const names = await receiver.$$eval("#receive-files .file-name", (n) => n.map((e) => e.textContent));
    assert(names.join(",") === "multi-a.bin,multi-b.bin,multi-c.bin", `received names: ${names}`);

    // Save each expanded file and compare against what was sent.
    for (const [i, f] of files.entries()) {
      const dl = receiver.waitForEvent("download", { timeout: 30_000 });
      await receiver.click(`#receive-files li:nth-child(${i + 1}) button`);
      const download = await dl;
      assert(download.suggestedFilename() === f.path.split("/").pop(), `name ${download.suggestedFilename()}`);
      const out = join(tmp, `received-multi-${i}.bin`);
      await download.saveAs(out);
      const got = await sha256File(out);
      assert(got === f.sha256, `file ${i} hash ${got} != ${f.sha256}`);
    }
    console.log(`  3 files expanded in the browser, all hashes match`);

    // The archive itself is still available for whoever would rather have one file.
    const zdl = receiver.waitForEvent("download", { timeout: 30_000 });
    await receiver.click("#save-zip");
    const zip = await zdl;
    assert(zip.suggestedFilename() === "dropcode-3-files.zip", `zip name ${zip.suggestedFilename()}`);
    console.log("  'Save as .zip' offers the bundle intact");
  },

  async dragdrop({ server, newPage }) {
    const sender = await newPage();
    const receiver = await newPage();
    await sender.goto(server.url);
    const dt = await sender.evaluateHandle(() => {
      const bytes = new Uint8Array(3 * 1024 * 1024 + 123);
      for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "dropped.bin", { type: "application/octet-stream" }));
      return dt;
    });
    await sender.dispatchEvent("#drop-zone", "dragenter", { dataTransfer: dt });
    assert(await sender.evaluate(() => document.body.classList.contains("dragging")), "drop zone highlights");
    await sender.dispatchEvent("#drop-zone", "drop", { dataTransfer: dt });
    await sender.waitForSelector("#send-code:not(:empty)");
    const code = (await sender.textContent("#send-code")).trim();
    const expected = await sender.evaluate(async () => {
      const f = window.__sender.file;
      const d = await crypto.subtle.digest("SHA-256", await f.arrayBuffer());
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    });
    const dl = receiver.waitForEvent("download");
    await startReceive(receiver, server.url, code);
    const out = join(tmp, "received-dropped.bin");
    await (await dl).saveAs(out);
    assert((await sha256File(out)) === expected, "dropped file hash matches");
  },

  async errors({ server, newPage }) {
    const p = await newPage();
    await startReceive(p, server.url, "not a code");
    await expectError(p, "receive", "bad_code");
    console.log(`  bad code: "${await p.textContent("#receive-error")}"`);
    await p.click("#receive-reset");
    await p.fill("#receive-code", "987654-apple-river");
    await p.click("#receive-btn");
    await expectError(p, "receive", "not_found");
    console.log(`  unknown code: "${await p.textContent("#receive-error")}"`);
  },

  async expired({ newPage }) {
    const short = await startServer({ ROOM_TTL_MS: "1500" });
    try {
      const file = await makeFile(randomName(), 1024);
      const sender = await newPage();
      const code = await sendAndGetCode(sender, short.url, file.path);
      await expectError(sender, "send", "expired", 5000);
      const r = await newPage();
      await startReceive(r, short.url, code);
      await expectError(r, "receive", "expired");
      console.log(`  expired: "${await r.textContent("#receive-error")}"`);
    } finally {
      short.stop();
    }
  },

  async "sender-cancel"(ctx) {
    const { sender, receiver } = await midTransfer(ctx);
    await sender.click("#send-cancel");
    await sender.waitForSelector('#send[data-phase="cancelled"]');
    await expectError(receiver, "receive", "cancelled_by_peer", 10_000);
  },

  async "receiver-cancel"(ctx) {
    const { sender, receiver } = await midTransfer(ctx);
    await receiver.click("#receive-cancel");
    await receiver.waitForSelector('#receive[data-phase="cancelled"]');
    await expectError(sender, "send", "cancelled_by_peer", 10_000);
  },

  async "peer-disconnect"(ctx) {
    // The receiver vanishes for good (tab closed). The sender keeps the code
    // alive so the receiver could come back and resume, and says so.
    const { sender, receiver } = await midTransfer(ctx);
    await receiver.context().close();
    await sender.waitForSelector('#send[data-phase="reconnecting"]', { timeout: 20_000 });
    console.log(`  sender sees: "${await sender.textContent("#send-status")}"`);
    // A receiver that comes back without its buffered chunks restarts from zero.
    await sender.click("#send-cancel");
  },

  async "resume-link"(ctx) {
    // Simulate the peer connection dying mid-transfer.
    await resumeScenario(ctx, async ({ receiver }) => {
      await receiver.evaluate(() => window.__receiver.link.dc.close());
    });
  },

  async "resume-sender-signaling"(ctx) {
    // The sender's WebSocket drops; the transfer keeps going over WebRTC and
    // the sender reclaims its room in the background.
    await resumeScenario(ctx, async ({ sender }) => {
      await sender.evaluate(() => window.__sender.sig.ws.close());
    }, { expectResume: false });
    assert(ctx.server.logs.some((l) => l.includes('"room_reclaimed"')), "sender reclaimed its room");
  },

  async "resume-receiver-signaling"(ctx) {
    await resumeScenario(ctx, async ({ receiver }) => {
      await receiver.evaluate(() => window.__receiver.sig.ws.close());
    }, { expectResume: false });
  },

  async "resume-both"(ctx) {
    // Sender loses signaling and the link at once (e.g. switched networks):
    // it reclaims the room, the receiver re-joins, and the transfer resumes.
    await resumeScenario(ctx, async ({ sender }) => {
      await sender.evaluate(() => {
        window.__sender.sig.ws.close();
        window.__sender.link.dc.close();
      });
    });
    assert(ctx.server.logs.some((l) => l.includes('"room_reclaimed"')), "sender reclaimed its room");
  },

  async "hash-mismatch"(ctx) {
    // Corrupt one byte of the 10th binary frame the sender puts on the wire.
    const corrupt = () => {
      const orig = RTCDataChannel.prototype.send;
      let n = 0;
      RTCDataChannel.prototype.send = function (data) {
        if (typeof data !== "string" && ++n === 10) {
          const copy = new Uint8Array(data.byteLength);
          copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          copy[100] ^= 0xff;
          return orig.call(this, copy);
        }
        return orig.call(this, data);
      };
    };
    const { sender, receiver } = await midTransfer(ctx, 8 * 1024 * 1024, corrupt).catch(async (e) => {
      throw e;
    });
    await expectError(receiver, "receive", "hash_mismatch", 20_000);
    await expectError(sender, "send", "hash_mismatch", 10_000);
    assert(!(await receiver.getAttribute("#download-link", "href")), "no download offered");
  },

  async "wrong-code"({ server, newPage }) {
    const file = await makeFile(randomName(), 2 * 1024 * 1024);
    const sender = await newPage();
    const code = await sendAndGetCode(sender, server.url, file.path);
    const bad = await newPage();
    await startReceive(bad, server.url, wrongCode(code));
    await expectError(bad, "receive", "auth_failed", 20_000);
    await sender.waitForSelector("#send-notice:not([hidden])");
    console.log(`  wrong code -> receiver: "${await bad.textContent("#receive-error")}"`);
    console.log(`  sender notice: "${await sender.textContent("#send-notice")}"`);
    const ph = await sender.getAttribute("#send", "data-phase");
    assert(ph === "waiting", `sender still waiting (phase=${ph}, error=${await sender.getAttribute("#send", "data-error")} ${await sender.textContent("#send-error")})`);
    assert((await bad.textContent("body")).indexOf(file.path.split("/").pop()) < 0, "file name not revealed");

    const good = await newPage();
    const dl = good.waitForEvent("download");
    await startReceive(good, server.url, code);
    const out = join(tmp, "received-after-wrong.bin");
    await (await dl).saveAs(out);
    assert((await sha256File(out)) === file.sha256, "hash matches after a failed attempt");
  },

  async mitm({ newPage }) {
    // Control experiment: the same hostile server relaying honestly works.
    const honest = await startEvilServer("honest");
    try {
      const file = await makeFile(randomName(), 1024 * 1024);
      const s = await newPage();
      const r = await newPage();
      const code = await sendAndGetCode(s, honest.url, file.path);
      const dl = r.waitForEvent("download");
      await startReceive(r, honest.url, code);
      const out = join(tmp, "received-honest.bin");
      await (await dl).saveAs(out);
      assert((await sha256File(out)) === file.sha256, "honest relay transfer works");
      console.log("  control: transfer through the honest relay succeeded");
    } finally {
      honest.stop();
    }

    const evil = await startEvilServer("mitm");
    try {
      const file = await makeFile(randomName(), 1024 * 1024);
      const mitm = await newPage();
      await mitm.goto(evil.url + "/nothing-here");
      await mitm.evaluate(mitmPageScript);
      const sender = await newPage();
      const receiver = await newPage();
      // The attacker controls signaling but not the code: victims use the right one.
      const code = await sendAndGetCode(sender, evil.url, file.path);
      await startReceive(receiver, evil.url, code);
      await expectError(receiver, "receive", "auth_failed");
      await sender.waitForSelector("#send-notice:not([hidden])", { timeout: 20_000 });
      const seen = await mitm.evaluate(() => window.__seen);
      console.log(`  MITM relayed: ${[...new Set(seen)].join(", ")}`);
      assert(seen.includes("S->R:pake") && seen.includes("R->S:pake"), "MITM really sat in the data path");
      assert(!seen.some((t) => /meta|binary/.test(t)), "no metadata or file data passed the MITM");
      assert(evil.state.senderReports.includes("auth_failed"), "sender reported the failure");
      assert(!(await receiver.textContent("body")).includes(file.path.split("/").pop()), "file name not leaked");
      console.log("  both victims rejected the connection; no file data or name leaked");
    } finally {
      evil.stop();
    }
  },

  async "cli-to-web"({ server, newPage }) {
    const file = await makeFile(randomName(), SIZE);
    const cli = runCli(["send", "-server", server.url, file.path]);
    const code = await cli.firstLine;
    assert(/^[1-9]\d*-[a-z]+-[a-z]+$/.test(code), `cli code: ${code}`);
    const receiver = await newPage();
    const dl = receiver.waitForEvent("download", { timeout: 120_000 });
    const t0 = Date.now();
    await startReceive(receiver, server.url, code);
    await waitPercent(receiver, "#receive-stats", 10);
    await checkRoute(receiver, "__receiver");
    const download = await dl;
    const out = join(tmp, "received-from-cli.bin");
    await download.saveAs(out);
    assert((await sha256File(out)) === file.sha256, "hash matches (CLI -> browser)");
    assert(download.suggestedFilename() === file.path.split("/").pop(), "name preserved");
    const res = await cli.exited;
    assert(res.code === 0, `cli exit ${res.code}: ${res.stderr}`);
    console.log(`  CLI -> browser: ${(SIZE / 1048576).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s, hash matches`);
  },

  async "web-to-cli"({ server, newPage }) {
    const file = await makeFile(randomName(), SIZE);
    const sender = await newPage();
    const code = await sendAndGetCode(sender, server.url, file.path);
    const dir = await freshDir("cli-out");
    const t0 = Date.now();
    const cli = runCli(["receive", "-q", "-server", server.url, "-o", dir, code]);
    await waitPercent(sender, "#send-stats", 10);
    await checkRoute(sender, "__sender");
    const res = await cli.exited;
    assert(res.code === 0, `cli exit ${res.code}: ${res.stderr}`);
    const out = res.stdout.trim();
    assert(out === join(dir, file.path.split("/").pop()), `saved as ${out}`);
    assert((await sha256File(out)) === file.sha256, "hash matches (browser -> CLI)");
    await sender.waitForSelector('#send[data-phase="done"]', { timeout: 10_000 });
    assert(readdirSync(dir).length === 1, `no leftovers: ${readdirSync(dir)}`);
    console.log(`  browser -> CLI: ${(SIZE / 1048576).toFixed(0)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s, hash matches`);
  },

  async "cli-to-cli"({ server }) {
    const file = await makeFile(randomName(), 20 * 1024 * 1024);
    const send = runCli(["send", "-q", "-server", server.url, file.path]);
    const code = await send.firstLine;
    const dir = await freshDir("cli-cli");
    const res = await runCli(["receive", "-q", "-server", server.url, "-o", dir, code]).exited;
    assert(res.code === 0, `receive exit ${res.code}: ${res.stderr}`);
    assert((await sha256File(res.stdout.trim())) === file.sha256, "hash matches (CLI -> CLI)");
    assert((await send.exited).code === 0, "sender exit 0");
  },

  async "cli-wrong-code"({ server, newPage }) {
    const file = await makeFile(randomName(), 1024 * 1024);
    const sender = await newPage();
    const code = await sendAndGetCode(sender, server.url, file.path);
    const dir = await freshDir("cli-wrong");
    const res = await runCli(["receive", "-q", "-server", server.url, "-o", dir, wrongCode(code)]).exited;
    assert(res.code === 1 && /couldn't verify/.test(res.stderr), `cli: ${res.code} ${res.stderr}`);
    await sender.waitForSelector("#send-notice:not([hidden])", { timeout: 10_000 });
    assert(readdirSync(dir).length === 0, "nothing written for a wrong code");
    console.log(`  CLI with wrong code: "${res.stderr.trim().split("\n").pop()}"`);
    // And the real code still works afterwards.
    const ok = await runCli(["receive", "-q", "-server", server.url, "-o", dir, code]).exited;
    assert(ok.code === 0 && (await sha256File(ok.stdout.trim())) === file.sha256, "real code works after a failed attempt");
  },

  async "cli-resume"({ server, newPage }) {
    // Kill the CLI receiver mid-transfer (no chance to clean up), then run it
    // again: it resumes from its .dropcode-part file and the browser sender
    // skips what is already on disk.
    const size = 160 * 1024 * 1024;
    const file = await makeFile(randomName(), size);
    const sender = await newPage();
    const code = await sendAndGetCode(sender, server.url, file.path);
    const dir = await freshDir("cli-resume");
    const name = file.path.split("/").pop();
    const first = runCli(["receive", "-q", "-server", server.url, "-o", dir, code]);
    const sidecar = join(dir, `${name}.dropcode-part.json`);
    const t0 = Date.now();
    while (!existsSync(sidecar) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 50));
    assert(existsSync(sidecar), "checkpoint written");
    first.proc.kill("SIGKILL");
    await first.exited;
    await sender.waitForSelector('#send[data-phase="reconnecting"]', { timeout: 20_000 });
    console.log(`  receiver killed; sender: "${await sender.textContent("#send-status")}"`);

    const second = runCli(["receive", "-server", server.url, "-o", dir, code]);
    const res = await second.exited;
    assert(res.code === 0, `second run exit ${res.code}: ${res.stderr}`);
    assert(/resuming: \d+ of \d+ bytes/.test(res.stderr), "CLI reported resuming");
    assert((await sha256File(res.stdout.trim())) === file.sha256, "hash matches after resume");
    const sessions = await sender.evaluate(() => window.__sender.sessions);
    console.log(`  sender sessions: ${JSON.stringify(sessions)}`);
    assert(sessions.length === 2 && sessions[1].skippedChunks > 0, "second session skipped chunks on disk");
    assert(readdirSync(dir).length === 1, `part files cleaned up: ${readdirSync(dir)}`);
  },

  async "cli-sender-resume"({ server, newPage }) {
    // CLI sender, browser receiver whose peer connection dies mid-transfer.
    const size = 64 * 1024 * 1024;
    const file = await makeFile(randomName(), size);
    const cli = runCli(["send", "-q", "-server", server.url, file.path]);
    const code = await cli.firstLine;
    const receiver = await newPage();
    const dl = receiver.waitForEvent("download", { timeout: 120_000 });
    dl.catch(() => {});
    await startReceive(receiver, server.url, code);
    await waitPercent(receiver, "#receive-stats", 30);
    await receiver.evaluate(() => window.__receiver.link.dc.close());
    await receiver.waitForSelector('#receive[data-phase="reconnecting"]', { timeout: 15_000 });
    const out = join(tmp, "received-cli-resume.bin");
    await (await dl).saveAs(out);
    assert((await sha256File(out)) === file.sha256, "hash matches after resume");
    const res = await cli.exited;
    assert(res.code === 0, `cli exit ${res.code}: ${res.stderr}`);
  },

  async burn({ server, newPage }) {
    const file = await makeFile(randomName(), 1024);
    const sender = await newPage();
    const code = await sendAndGetCode(sender, server.url, file.path);
    for (let i = 0; i < 3; i++) {
      const bad = await newPage();
      await startReceive(bad, server.url, wrongCode(code));
      await expectError(bad, "receive", "auth_failed", 20_000);
      await bad.context().close();
    }
    await expectError(sender, "send", "burned", 10_000);
    const good = await newPage();
    await startReceive(good, server.url, code);
    await expectError(good, "receive", "burned");
    console.log(`  after 3 failures: "${await good.textContent("#receive-error")}"`);
  },
};

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(scenarios);
const { browser, newPage } = await launch();
const logs = [];
let failed = 0;
try {
  for (const name of names) {
    const fn = scenarios[name];
    if (!fn) throw new Error(`unknown scenario ${name}`);
    process.stdout.write(`- ${name}\n`);
    // A fresh server per scenario: all browsers share 127.0.0.1, so per-IP rate
    // limits would otherwise leak between scenarios.
    const server = process.env.E2E_SERVER_URL
      ? { url: process.env.E2E_SERVER_URL, logs: [], stop() {} }
      : await startServer();
    try {
      await fn({ server, newPage });
      console.log(`  PASS`);
    } catch (e) {
      failed++;
      console.log(`  FAIL: ${e.stack ?? e}`);
    } finally {
      server.stop();
      logs.push(...server.logs);
    }
  }
} finally {
  await browser.close();
}
// Server logs must never contain codes or file names.
const leaked = logs.filter((l) => /e2e-[0-9a-f]{8}|-[a-z]+-[a-z]+|dropped\.bin/.test(l));
if (leaked.length) {
  failed++;
  console.log("FAIL: sensitive data in server logs:", leaked);
}
console.log(`server log lines checked for leaks: ${logs.length}`);
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
