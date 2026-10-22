import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { createAppServer } from "./http.ts";
import { log } from "./log.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(process.env, join(here, "..", "..", "web", "dist"));
const app = createAppServer(cfg, cfg.roomTtlMs ? { rooms: { ttlMs: cfg.roomTtlMs } } : {});

app.server.listen(cfg.port, cfg.host, () => {
  const addr = app.server.address();
  log("listening", {
    port: typeof addr === "object" && addr ? addr.port : cfg.port,
    turn: cfg.turnUrls.length > 0 || app.turn !== null,
    turnProvider: app.turn ? "cloudflare" : cfg.turnUrls.length ? "static" : "none",
    relayOnly: cfg.iceTransportPolicy === "relay",
  });
  // Prime the credential cache so a bad key id or token is reported at startup
  // rather than on the first transfer, and the first client isn't kept waiting.
  void app.turn?.iceServers();
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("shutdown");
    app.close().then(() => process.exit(0));
  });
}
