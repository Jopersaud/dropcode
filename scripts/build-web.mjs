// Bundle the web client into web/dist (served by the signaling server).
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "web", "dist");
await mkdir(out, { recursive: true });
await build({
  entryPoints: [join(root, "web", "src", "main.ts")],
  bundle: true,
  format: "esm",
  target: ["chrome110", "firefox115", "safari16"],
  outfile: join(out, "app.js"),
  minify: process.argv.includes("--minify"),
  sourcemap: false,
  loader: { ".txt": "text", ".wasm": "binary" },
  legalComments: "none",
  logLevel: "warning",
});
await copyFile(join(root, "web", "index.html"), join(out, "index.html"));
await copyFile(join(root, "web", "style.css"), join(out, "style.css"));
console.log("built web/dist");
