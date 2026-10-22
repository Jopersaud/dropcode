// Cloudflare Realtime TURN mints credentials from its own REST API rather than
// from coturn's `static-auth-secret` HMAC scheme, so they have to be fetched over
// the network instead of computed. One set is shared by every client and cached
// until shortly before it expires.
import { log } from "./log.ts";
import type { IceServer } from "./protocol.ts";

const API_BASE = "https://rtc.live.cloudflare.com/v1/turn/keys";

/** Re-mint this long before the credentials expire, so `hello` never waits. */
const REFRESH_SKEW_MS = 300_000;
/** Don't hammer the API while it is failing; serve STUN-only until this passes. */
const RETRY_AFTER_MS = 30_000;
const MINT_TIMEOUT_MS = 10_000;

export interface CloudflareTurnOptions {
  keyId: string;
  apiToken: string;
  /** Requested credential lifetime, seconds. */
  ttlSec: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class CloudflareTurn {
  private cached: IceServer[] = [];
  private freshUntilMs = 0;
  private inflight: Promise<IceServer[]> | null = null;

  constructor(private readonly opts: CloudflareTurnOptions) {}

  /**
   * Current ICE servers, minting them if the cached set is stale. Never rejects:
   * a failed mint degrades the transfer to STUN-only rather than breaking the
   * connection, which matches what the server does when no TURN is configured.
   */
  async iceServers(): Promise<IceServer[]> {
    const now = (this.opts.now ?? Date.now)();
    if (now < this.freshUntilMs) return this.cached;
    // Single-flight: a burst of connections on a cold cache makes one API call.
    this.inflight ??= this.mint(now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async mint(now: number): Promise<IceServer[]> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      const res = await doFetch(
        `${API_BASE}/${encodeURIComponent(this.opts.keyId)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.opts.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ ttl: this.opts.ttlSec }),
          signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const servers = parseIceServers(await res.json());
      if (!servers.some((s) => s.credential)) throw new Error("no TURN credentials in response");
      this.cached = servers;
      this.freshUntilMs = now + Math.max(this.opts.ttlSec * 1000 - REFRESH_SKEW_MS, 60_000);
      log("turn_minted", { urls: servers.flatMap((s) => s.urls).length });
      return servers;
    } catch (err) {
      // The token and key id are secrets; log only the failure shape.
      log("turn_mint_failed", { err: err instanceof Error ? err.message : String(err) });
      // Keep any previous credentials: they may outlive a transient API outage.
      this.freshUntilMs = now + RETRY_AFTER_MS;
      return this.cached;
    }
  }
}

/**
 * Accepts both the documented `iceServers: [...]` array and the older single
 * `iceServers: {...}` object, and drops anything without usable URLs.
 */
export function parseIceServers(body: unknown): IceServer[] {
  const raw = (body as { iceServers?: unknown } | null)?.iceServers;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: IceServer[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { urls, username, credential } = entry as Record<string, unknown>;
    const list = typeof urls === "string" ? [urls] : Array.isArray(urls) ? urls.filter((u) => typeof u === "string") : [];
    if (!list.length) continue;
    const server: IceServer = { urls: list as string[] };
    if (typeof username === "string") server.username = username;
    if (typeof credential === "string") server.credential = credential;
    out.push(server);
  }
  return out;
}
