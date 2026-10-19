import { afterEach, describe, expect, it } from "vitest";
import { Client, sleep, startServer } from "./helpers.ts";

let servers: Awaited<ReturnType<typeof startServer>>[] = [];
let clients: Client[] = [];
afterEach(async () => {
  clients.forEach((c) => c.close());
  await Promise.all(servers.map((s) => s.app.close()));
  servers = [];
  clients = [];
});

async function setup(opts: Parameters<typeof startServer>[0] = {}) {
  const s = await startServer(opts);
  servers.push(s);
  const connect = async (ip?: string) => {
    const c = await Client.connect(s.url, ip);
    clients.push(c);
    return c;
  };
  return { ...s, connect };
}

async function createRoom(c: Client): Promise<string> {
  c.send({ t: "create" });
  const m = await c.next();
  expect(m.t).toBe("created");
  return m.nameplate;
}

describe("room lifecycle", () => {
  it("pairs a sender and receiver and relays signals both ways", async () => {
    const { connect } = await setup();
    const sender = await connect("10.0.0.1");
    const receiver = await connect("10.0.0.2");
    const nameplate = await createRoom(sender);
    expect(nameplate).toMatch(/^[1-9]\d*$/);

    receiver.send({ t: "join", nameplate });
    expect(await receiver.next()).toEqual({ t: "joined" });
    expect(await sender.next()).toEqual({ t: "peer_joined" });

    sender.send({ t: "signal", data: { kind: "offer", sdp: "v=0 offer" } });
    expect(await receiver.next()).toEqual({ t: "signal", data: { kind: "offer", sdp: "v=0 offer" } });
    receiver.send({ t: "signal", data: { kind: "answer", sdp: "v=0 answer" } });
    expect(await sender.next()).toEqual({ t: "signal", data: { kind: "answer", sdp: "v=0 answer" } });
  });

  it("destroys the room after done and treats the code as single-use", async () => {
    const { connect } = await setup();
    const sender = await connect();
    const receiver = await connect("10.0.0.2");
    const nameplate = await createRoom(sender);
    receiver.send({ t: "join", nameplate });
    await receiver.next();
    await sender.next();

    receiver.send({ t: "done" });
    expect(await receiver.next()).toEqual({ t: "closed", reason: "done" });
    expect(await sender.next()).toEqual({ t: "closed", reason: "done" });
    expect(await sender.closed).toBe(1000);
    expect(servers[0]!.app.signaling.rooms.hasRoom(nameplate)).toBe(false);

    const late = await connect("10.0.0.3");
    late.send({ t: "join", nameplate });
    expect(await late.next()).toEqual({ t: "error", code: "used" });
  });

  it("cancel closes the room for both sides", async () => {
    const { connect } = await setup();
    const sender = await connect();
    const receiver = await connect("10.0.0.2");
    const nameplate = await createRoom(sender);
    receiver.send({ t: "join", nameplate });
    await receiver.next();
    await sender.next();
    sender.send({ t: "cancel" });
    expect(await receiver.next()).toEqual({ t: "closed", reason: "cancelled" });
  });

  it("frees the receiver slot when the receiver disconnects", async () => {
    const { connect } = await setup();
    const sender = await connect();
    const r1 = await connect("10.0.0.2");
    const nameplate = await createRoom(sender);
    r1.send({ t: "join", nameplate });
    await r1.next();
    await sender.next();
    r1.close();
    expect(await sender.next()).toEqual({ t: "peer_left" });

    const r2 = await connect("10.0.0.3");
    r2.send({ t: "join", nameplate });
    expect(await r2.next()).toEqual({ t: "joined" });
    expect(await sender.next()).toEqual({ t: "peer_joined" });
  });

  it("destroys the room when the sender disconnects", async () => {
    const { connect } = await setup();
    const sender = await connect();
    const receiver = await connect("10.0.0.2");
    const nameplate = await createRoom(sender);
    receiver.send({ t: "join", nameplate });
    await receiver.next();
    sender.close();
    expect(await receiver.next()).toEqual({ t: "closed", reason: "sender_left" });
  });

  it("does not reuse a nameplate that is still alive", async () => {
    const { connect } = await setup();
    const seen = new Set<string>();
    for (let i = 0; i < 9; i++) {
      const c = await connect(`10.1.0.${i}`);
      seen.add(await createRoom(c));
    }
    expect(seen.size).toBe(9);
  });
});

describe("one sender, one receiver", () => {
  it("rejects a second receiver", async () => {
    const { connect } = await setup();
    const sender = await connect();
    const r1 = await connect("10.0.0.2");
    const r2 = await connect("10.0.0.3");
    const nameplate = await createRoom(sender);
    r1.send({ t: "join", nameplate });
    expect((await r1.next()).t).toBe("joined");
    r2.send({ t: "join", nameplate });
    expect(await r2.next()).toEqual({ t: "error", code: "room_full" });
  });

  it("rejects create/join on a connection that already has a role", async () => {
    const { connect } = await setup();
    const sender = await connect();
    const nameplate = await createRoom(sender);
    sender.send({ t: "create" });
    expect(await sender.next()).toEqual({ t: "error", code: "bad_state" });
    sender.send({ t: "join", nameplate });
    expect(await sender.next()).toEqual({ t: "error", code: "bad_state" });
  });

  it("refuses to relay before a peer is present", async () => {
    const { connect } = await setup();
    const sender = await connect();
    await createRoom(sender);
    sender.send({ t: "signal", data: { kind: "offer", sdp: "v=0" } });
    expect(await sender.next()).toEqual({ t: "error", code: "bad_state" });
    const stranger = await connect("10.0.0.9");
    stranger.send({ t: "signal", data: { kind: "offer", sdp: "v=0" } });
    expect(await stranger.next()).toEqual({ t: "error", code: "bad_state" });
  });

  it("limits active rooms per IP", async () => {
    const { connect } = await setup({ rooms: { maxRoomsPerIp: 2 } });
    for (let i = 0; i < 2; i++) await createRoom(await connect("10.9.9.9"));
    const c = await connect("10.9.9.9");
    c.send({ t: "create" });
    expect(await c.next()).toEqual({ t: "error", code: "too_many_rooms" });
  });
});

describe("TTL", () => {
  it("expires an unclaimed room", async () => {
    const { connect } = await setup({ rooms: { ttlMs: 150 } });
    const sender = await connect();
    const nameplate = await createRoom(sender);
    expect(await sender.next(1000)).toEqual({ t: "closed", reason: "expired" });
    const r = await connect("10.0.0.2");
    r.send({ t: "join", nameplate });
    expect(await r.next()).toEqual({ t: "error", code: "expired" });
  });

  it("does not expire while paired, and re-arms when the receiver leaves", async () => {
    const { connect } = await setup({ rooms: { ttlMs: 150 } });
    const sender = await connect();
    const r = await connect("10.0.0.2");
    const nameplate = await createRoom(sender);
    r.send({ t: "join", nameplate });
    await r.next();
    await sender.next();
    await sleep(300);
    expect(servers[0]!.app.signaling.rooms.hasRoom(nameplate)).toBe(true);
    r.close();
    expect(await sender.next()).toEqual({ t: "peer_left" });
    expect(await sender.next(1000)).toEqual({ t: "closed", reason: "expired" });
  });

  it("enforces a hard maximum lifetime", async () => {
    const { connect } = await setup({ rooms: { ttlMs: 10_000, maxLifetimeMs: 200 } });
    const sender = await connect();
    const r = await connect("10.0.0.2");
    const nameplate = await createRoom(sender);
    r.send({ t: "join", nameplate });
    await r.next();
    await sender.next();
    expect(await r.next(1000)).toEqual({ t: "closed", reason: "expired" });
  });
});

describe("rate limiting", () => {
  it("blocks an IP after 5 failed joins per minute, without affecting other IPs", async () => {
    const { connect } = await setup();
    const sender = await connect("10.0.0.1");
    const nameplate = await createRoom(sender);
    const attacker = await connect("10.6.6.6");
    // Nameplates are allocated from 1-9 first, so 9xxxxx is reliably unused.
    for (let i = 0; i < 5; i++) {
      attacker.send({ t: "join", nameplate: String(900000 + i) });
      expect(await attacker.next()).toEqual({ t: "error", code: "not_found" });
    }
    attacker.send({ t: "join", nameplate });
    expect(await attacker.next()).toEqual({ t: "error", code: "rate_limited" });

    // A fresh connection from the same IP is still limited.
    const again = await connect("10.6.6.6");
    again.send({ t: "join", nameplate });
    expect(await again.next()).toEqual({ t: "error", code: "rate_limited" });

    // A legitimate receiver elsewhere is unaffected.
    const legit = await connect("10.0.0.2");
    legit.send({ t: "join", nameplate });
    expect(await legit.next()).toEqual({ t: "joined" });
  });

  it("counts joins to a full room as failures", async () => {
    const { connect } = await setup({ rooms: { failedJoinLimit: 2 } });
    const sender = await connect();
    const nameplate = await createRoom(sender);
    const r = await connect("10.0.0.2");
    r.send({ t: "join", nameplate });
    await r.next();
    const prober = await connect("10.6.6.7");
    for (let i = 0; i < 2; i++) {
      prober.send({ t: "join", nameplate });
      expect(await prober.next()).toEqual({ t: "error", code: "room_full" });
    }
    prober.send({ t: "join", nameplate });
    expect(await prober.next()).toEqual({ t: "error", code: "rate_limited" });
  });

  it("disconnects clients that flood messages", async () => {
    const { connect } = await setup({ messagesPerSec: 5 });
    const c = await connect();
    for (let i = 0; i < 50; i++) c.send({ t: "ping" });
    expect(await c.closed).toBe(1008);
  });

  it("caps concurrent connections per IP", async () => {
    const { connect, url } = await setup({ maxConnectionsPerIp: 2 });
    await connect("10.5.5.5");
    await connect("10.5.5.5");
    const third = new Client(url, "10.5.5.5");
    clients.push(third);
    await expect(third.closed).resolves.toBeTypeOf("number");
  });
});

describe("message validation", () => {
  it("closes the connection on malformed messages", async () => {
    const { connect } = await setup();
    const c = await connect();
    c.send("{not json");
    expect(await c.next()).toEqual({ t: "error", code: "bad_message" });
    expect(await c.closed).toBe(1008);
  });

  it("closes the connection on oversized frames", async () => {
    const { connect } = await setup();
    const c = await connect();
    c.send("x".repeat(64 * 1024));
    expect(await c.closed).toBe(1009);
  });

  it("closes the connection on binary frames", async () => {
    const { connect } = await setup();
    const c = await connect();
    c.ws.send(Buffer.from([1, 2, 3]));
    expect(await c.next()).toEqual({ t: "error", code: "bad_message" });
  });
});

describe("http", () => {
  it("serves a health check and 404s unknown paths", async () => {
    const { httpUrl } = await setup();
    expect((await fetch(`${httpUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${httpUrl}/../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${httpUrl}/server/src/index.ts`)).status).toBe(404);
  });
});
