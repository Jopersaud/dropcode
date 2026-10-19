// End-to-end scenarios. Usage: node e2e/run.mjs [scenario ...]
import { join } from "node:path";
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
  page.waitForFunction(
    ([sel, min]) => Number(document.querySelector(sel)?.dataset.percent ?? 0) >= min,
    [sel, min],
    { timeout: 60_000, polling: 50 },
  );

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

const scenarios = {
  async basic({ server, newPage }) {
    const file = await makeFile(randomName(), SIZE);
    const sender = await newPage();
    const receiver = await newPage();
    const code = await sendAndGetCode(sender, server.url, file.path);
    assert(/^[1-9]\d*-[a-z]+-[a-z]+$/.test(code), `code format: ${code}`);
    const t0 = Date.now();
    const dl = receiver.waitForEvent("download", { timeout: 120_000 });
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
    await late.waitForSelector('#receive[data-error="used"]', { timeout: 10_000 });
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
    await p.waitForSelector('#receive[data-error="bad_code"]');
    console.log(`  bad code: "${await p.textContent("#receive-error")}"`);
    await p.click("#receive-reset");
    await p.fill("#receive-code", "987654-apple-river");
    await p.click("#receive-btn");
    await p.waitForSelector('#receive[data-error="not_found"]');
    console.log(`  unknown code: "${await p.textContent("#receive-error")}"`);
  },

  async expired({ newPage }) {
    const short = await startServer({ ROOM_TTL_MS: "1500" });
    try {
      const file = await makeFile(randomName(), 1024);
      const sender = await newPage();
      const code = await sendAndGetCode(sender, short.url, file.path);
      await sender.waitForSelector('#send[data-error="expired"]', { timeout: 5000 });
      const r = await newPage();
      await startReceive(r, short.url, code);
      await r.waitForSelector('#receive[data-error="expired"]');
      console.log(`  expired: "${await r.textContent("#receive-error")}"`);
    } finally {
      short.stop();
    }
  },

  async "sender-cancel"(ctx) {
    const { sender, receiver } = await midTransfer(ctx);
    await sender.click("#send-cancel");
    await sender.waitForSelector('#send[data-phase="cancelled"]');
    await receiver.waitForSelector('#receive[data-error="cancelled_by_peer"]', { timeout: 10_000 });
  },

  async "receiver-cancel"(ctx) {
    const { sender, receiver } = await midTransfer(ctx);
    await receiver.click("#receive-cancel");
    await receiver.waitForSelector('#receive[data-phase="cancelled"]');
    await sender.waitForSelector('#send[data-error="cancelled_by_peer"]', { timeout: 10_000 });
  },

  async "peer-disconnect"(ctx) {
    const { sender, receiver } = await midTransfer(ctx);
    await receiver.context().close();
    await sender.waitForSelector('#send[data-error="peer_disconnected"]', { timeout: 20_000 });
    console.log(`  sender sees: "${await sender.textContent("#send-error")}"`);
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
    await receiver.waitForSelector('#receive[data-error="hash_mismatch"]', { timeout: 20_000 });
    await sender.waitForSelector('#send[data-error="hash_mismatch"]', { timeout: 10_000 });
    assert(!(await receiver.getAttribute("#download-link", "href")), "no download offered");
  },
};

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(scenarios);
const server = await startServer();
const { browser, newPage } = await launch();
let failed = 0;
try {
  for (const name of names) {
    const fn = scenarios[name];
    if (!fn) throw new Error(`unknown scenario ${name}`);
    process.stdout.write(`- ${name}\n`);
    try {
      await fn({ server, newPage });
      console.log(`  PASS`);
    } catch (e) {
      failed++;
      console.log(`  FAIL: ${e.stack ?? e}`);
    }
  }
} finally {
  await browser.close();
  server.stop();
}
// Server logs must never contain codes or file names.
const leaked = server.logs.filter((l) => /e2e-[0-9a-f]{8}|-[a-z]+-[a-z]+/.test(l));
if (leaked.length) {
  failed++;
  console.log("FAIL: sensitive data in server logs:", leaked);
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
