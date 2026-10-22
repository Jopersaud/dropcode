import { describe, expect, it, vi } from "vitest";
import { loadConfig, iceServersFor } from "../src/config.ts";
import { CloudflareTurn, parseIceServers } from "../src/turn-cloudflare.ts";
import { turnProviderFor } from "../src/signaling.ts";

const BODY = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478"] },
    {
      urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
      username: "u1",
      credential: "c1",
    },
  ],
};

const ok = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 201 })) as unknown as typeof fetch;

const make = (fetchImpl: typeof fetch, now: () => number, ttlSec = 3600) =>
  new CloudflareTurn({ keyId: "key", apiToken: "token", ttlSec, fetchImpl, now });

describe("parseIceServers", () => {
  it("reads the documented array form", () => {
    expect(parseIceServers(BODY)).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
        username: "u1",
        credential: "c1",
      },
    ]);
  });

  it("accepts a single object and a bare string url", () => {
    const got = parseIceServers({ iceServers: { urls: "turn:t:3478", username: "u", credential: "c" } });
    expect(got).toEqual([{ urls: ["turn:t:3478"], username: "u", credential: "c" }]);
  });

  it("drops entries without usable urls and tolerates junk", () => {
    expect(parseIceServers({ iceServers: [{ urls: [] }, null, 7, { username: "u" }] })).toEqual([]);
    expect(parseIceServers(null)).toEqual([]);
    expect(parseIceServers({})).toEqual([]);
  });
});

describe("CloudflareTurn", () => {
  it("calls the documented endpoint with bearer auth and the requested ttl", async () => {
    const f = ok(BODY);
    await make(f, () => 0).iceServers();
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer token");
    expect(JSON.parse(init.body)).toEqual({ ttl: 3600 });
  });

  it("caches until shortly before expiry, then re-mints", async () => {
    const f = ok(BODY);
    let now = 0;
    const t = make(f, () => now);
    await t.iceServers();
    now = 3_000_000; // still inside ttl (3600s) minus the 300s refresh skew
    await t.iceServers();
    expect(f).toHaveBeenCalledTimes(1);
    now = 3_300_001; // past ttl - skew
    await t.iceServers();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("makes a single API call for a burst on a cold cache", async () => {
    const f = ok(BODY);
    const t = make(f, () => 0);
    await Promise.all([t.iceServers(), t.iceServers(), t.iceServers()]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("degrades to no TURN rather than rejecting when the API fails", async () => {
    const f = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(make(f, () => 0).iceServers()).resolves.toEqual([]);
  });

  it("rejects a 2xx response that carries no credentials", async () => {
    const f = ok({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] });
    await expect(make(f, () => 0).iceServers()).resolves.toEqual([]);
  });

  it("keeps serving stale credentials through an outage, and backs off", async () => {
    let fail = false;
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;
      if (fail) throw new Error("network down");
      return new Response(JSON.stringify(BODY), { status: 201 });
    }) as unknown as typeof fetch;
    let now = 0;
    const t = make(f, () => now);
    await t.iceServers();
    fail = true;
    now = 3_300_001; // cache went stale
    expect(await t.iceServers()).toEqual(parseIceServers(BODY)); // previous creds survive
    const after = calls;
    now += 1000; // inside the 30s retry backoff
    await t.iceServers();
    expect(calls).toBe(after);
  });
});

describe("wiring", () => {
  it("builds a provider only when both key id and token are set", () => {
    const base = { TURN_CLOUDFLARE_KEY_ID: "k", TURN_CLOUDFLARE_API_TOKEN: "t" };
    expect(turnProviderFor(loadConfig(base, "/web"))).not.toBeNull();
    expect(turnProviderFor(loadConfig({ TURN_CLOUDFLARE_KEY_ID: "k" }, "/web"))).toBeNull();
    expect(turnProviderFor(loadConfig({}, "/web"))).toBeNull();
  });

  it("appends minted servers after the configured ones", () => {
    const cfg = loadConfig({ TURN_URL: "turn:static:3478", TURN_USER: "u", TURN_PASS: "p" }, "/web");
    const minted = [{ urls: ["turn:turn.cloudflare.com:3478"], username: "mu", credential: "mc" }];
    const got = iceServersFor(cfg, 0, minted);
    expect(got.at(-1)).toEqual(minted[0]);
    expect(got.some((s) => s.username === "u")).toBe(true);
  });

  it("is unchanged when no provider mints anything", () => {
    const cfg = loadConfig({}, "/web");
    expect(iceServersFor(cfg, 0, [])).toEqual(iceServersFor(cfg, 0));
  });
});
