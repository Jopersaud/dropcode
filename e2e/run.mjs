// End-to-end scenarios. Usage: node e2e/run.mjs [scenario ...]
import { join } from "node:path";
import { mitmPageScript, startEvilServer } from "./evil-server.mjs";
import { assert, launch, makeFile, randomName, sha256File, startServer, tmp } from "./lib.mjs";

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
    const server = await startServer();
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
