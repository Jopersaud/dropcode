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
    const download = await dl;
    const out = join(tmp, `received-${file.path.split("/").pop()}`);
    await download.saveAs(out);
    const secs = (Date.now() - t0) / 1000;
    const got = await sha256File(out);
    assert(got === file.sha256, `hash mismatch ${got} != ${file.sha256}`);
    assert(download.suggestedFilename() === file.path.split("/").pop(), "file name preserved");
    await sender.waitForSelector('#send[data-phase="done"]', { timeout: 10_000 });
    console.log(`  ${(SIZE / 1048576).toFixed(0)} MB in ${secs.toFixed(1)}s, sha256 ${got.slice(0, 16)}… matches`);

    // The code is single-use.
    const late = await newPage();
    await startReceive(late, server.url, code);
    await late.waitForSelector('#receive[data-error="used"]', { timeout: 10_000 });
    console.log("  reusing the code fails with 'used'");
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
