// Helpers for end-to-end tests: start the real server, drive two isolated
// Chromium contexts (separate profiles, like two different machines).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const tmp = process.env.E2E_TMP ?? join(tmpdir(), "dropcode-e2e");

export async function startServer(env = {}) {
  const proc = spawn(process.execPath, [join(root, "server/dist/index.js")], {
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const logs = [];
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        logs.push(line);
        try {
          const m = JSON.parse(line);
          if (m.event === "listening") resolve(m.port);
        } catch {}
      }
    });
    proc.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  return { url: `http://127.0.0.1:${port}`, logs, stop: () => proc.kill("SIGTERM") };
}

export async function makeFile(name, size) {
  await mkdir(tmp, { recursive: true });
  const path = join(tmp, name);
  const out = createWriteStream(path);
  const h = createHash("sha256");
  let left = size;
  while (left > 0) {
    const n = Math.min(left, 1 << 20);
    const b = randomBytes(n);
    h.update(b);
    if (!out.write(b)) await new Promise((r) => out.once("drain", r));
    left -= n;
  }
  await new Promise((r) => out.end(r));
  return { path, sha256: h.digest("hex"), size };
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

export async function launch() {
  const browser = await chromium.launch({
    args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
  });
  let n = 0;
  const newPage = async () => {
    const label = `page${++n}`;
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error("[pageerror]", e.message));
    if (process.env.E2E_DEBUG) page.on("console", (m) => console.log(`  [${label}] ${m.text()}`));
    return page;
  };
  return { browser, newPage };
}

export const randomName = () => `e2e-${randomBytes(4).toString("hex")}.bin`;

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
