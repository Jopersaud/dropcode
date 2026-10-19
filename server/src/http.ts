import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { ServerConfig } from "./config.ts";
import { createSignaling, type SignalingOptions } from "./signaling.ts";

// Only these files are ever served; there is no path traversal surface.
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
    "connect-src 'self'; img-src 'self' blob: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export function createAppServer(cfg: ServerConfig, opts: SignalingOptions = {}) {
  const signaling = createSignaling(cfg, opts);
  const cache = new Map<string, Buffer>();

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    const entry = STATIC[path];
    if (!entry || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404, SECURITY_HEADERS).end("not found");
      return;
    }
    try {
      let body = cache.get(entry.file);
      if (!body) {
        body = await readFile(join(cfg.webRoot, entry.file));
        if (process.env.NODE_ENV === "production") cache.set(entry.file, body);
      }
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": entry.type, "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(500, SECURITY_HEADERS).end("web client not built; run `npm run build:web`");
    }
  });

  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") {
      socket.destroy();
      return;
    }
    signaling.handleUpgrade(req, socket, head);
  });

  return {
    server,
    signaling,
    close: () =>
      new Promise<void>((resolve) => {
        signaling.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
