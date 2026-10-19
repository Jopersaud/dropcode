import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Mirror the esbuild loaders used for the web bundle: .txt as text, .wasm as bytes.
const loaders = {
  name: "dropcode-loaders",
  enforce: "pre" as const,
  load(id: string) {
    if (id.endsWith(".txt")) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
    if (id.endsWith(".wasm"))
      return `export default Uint8Array.from(atob(${JSON.stringify(readFileSync(id).toString("base64"))}), (c) => c.charCodeAt(0));`;
    return null;
  },
};

export default defineConfig({
  plugins: [loaders],
  test: {
    include: ["server/test/**/*.test.ts", "web/test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
