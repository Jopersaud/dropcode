import { createHmac } from "node:crypto";
import type { IceServer } from "./protocol.ts";

export interface ServerConfig {
  port: number;
  host: string;
  /** "" (use socket address), "fly" (Fly-Client-IP) or "xff" (left-most X-Forwarded-For). */
  trustProxy: "" | "fly" | "xff";
  stunUrls: string[];
  turnUrls: string[];
  turnUser: string;
  turnPass: string;
  /** coturn `static-auth-secret`; when set, short-lived TURN credentials are minted per client. */
  turnSecret: string;
  turnCredentialTtlSec: number;
  webRoot: string;
  /** Override the 10-minute room TTL (mainly for tests). */
  roomTtlMs: number | undefined;
}

const list = (v: string | undefined, dflt: string[]) =>
  v === undefined ? dflt : v.split(",").map((s) => s.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv, webRoot: string): ServerConfig {
  const tp = (env.TRUST_PROXY ?? "").toLowerCase();
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    trustProxy: tp === "fly" ? "fly" : tp === "xff" || tp === "1" || tp === "true" ? "xff" : "",
    stunUrls: list(env.STUN_URLS, ["stun:stun.l.google.com:19302"]),
    turnUrls: list(env.TURN_URL, []),
    turnUser: env.TURN_USER ?? "",
    turnPass: env.TURN_PASS ?? "",
    turnSecret: env.TURN_SECRET ?? "",
    turnCredentialTtlSec: Number(env.TURN_CREDENTIAL_TTL ?? 3600),
    webRoot: env.WEB_ROOT ?? webRoot,
    roomTtlMs: env.ROOM_TTL_MS ? Number(env.ROOM_TTL_MS) : undefined,
  };
}

export function iceServersFor(cfg: ServerConfig, nowMs = Date.now()): IceServer[] {
  const servers: IceServer[] = [];
  if (cfg.stunUrls.length) servers.push({ urls: cfg.stunUrls });
  if (cfg.turnUrls.length) {
    if (cfg.turnSecret) {
      // coturn "TURN REST API" credentials: username = expiry timestamp,
      // password = base64(HMAC-SHA1(secret, username)).
      const username = `${Math.floor(nowMs / 1000) + cfg.turnCredentialTtlSec}:dropcode`;
      const credential = createHmac("sha1", cfg.turnSecret).update(username).digest("base64");
      servers.push({ urls: cfg.turnUrls, username, credential });
    } else {
      servers.push({ urls: cfg.turnUrls, username: cfg.turnUser, credential: cfg.turnPass });
    }
  }
  return servers;
}
