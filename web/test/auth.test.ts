import { describe, expect, it } from "vitest";
import { AuthError, authenticate, sdpFingerprints, type AuthChannel } from "../src/auth.ts";
import { pakeStart } from "../src/pake.ts";

const enc = new TextEncoder();
const FP_S = "AA:".repeat(31) + "AA";
const FP_R = "BB:".repeat(31) + "BB";
const FP_M1 = "CC:".repeat(31) + "CC";
const FP_M2 = "DD:".repeat(31) + "DD";
const sdp = (fp: string) => `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 ${fp}\r\na=setup:actpass\r\n`;

/** Two connected in-memory AuthChannels, optionally with a tap that can rewrite messages. */
function pipe(tap?: (from: "sender" | "receiver", m: any) => any): [AuthChannel, AuthChannel] {
  const make = (me: "sender" | "receiver") => {
    const inbox: any[] = [];
    const waiters: ((m: any) => void)[] = [];
    return {
      deliver(m: any) {
        const w = waiters.shift();
        if (w) w(m);
        else inbox.push(m);
      },
      channel: (other: () => { deliver(m: any): void }): AuthChannel => ({
        send: (m) => other().deliver(tap ? tap(me, m) : m),
        recv: async (t) => {
          const m = inbox.shift() ?? (await new Promise((r) => waiters.push(r)));
          if (m.t !== t) throw new Error(`expected ${t}`);
          return m;
        },
      }),
    };
  };
  const s = make("sender");
  const r = make("receiver");
  return [s.channel(() => r), r.channel(() => s)];
}

async function handshake(opts: {
  senderCode: string;
  receiverCode: string;
  senderView?: [string, string]; // [local, remote] SDP as the sender sees them
  receiverView?: [string, string];
  tap?: Parameters<typeof pipe>[0];
}) {
  const [cs, cr] = pipe(opts.tap);
  const [sl, sr] = opts.senderView ?? [sdp(FP_S), sdp(FP_R)];
  const [rl, rr] = opts.receiverView ?? [sdp(FP_R), sdp(FP_S)];
  return Promise.allSettled([
    authenticate({ role: "sender", code: opts.senderCode, localSdp: sl, remoteSdp: sr, channel: cs, timeoutMs: 1000 }),
    authenticate({ role: "receiver", code: opts.receiverCode, localSdp: rl, remoteSdp: rr, channel: cr, timeoutMs: 1000 }),
  ]);
}

describe("SPAKE2 wasm", () => {
  it("agrees on a key for the same password and not for different ones", async () => {
    const id = [enc.encode("a"), enc.encode("b")] as const;
    const a = await pakeStart("A", enc.encode("7-zoo-yard"), ...id);
    const b = await pakeStart("B", enc.encode("7-zoo-yard"), ...id);
    const ka = a.finish(b.message);
    const kb = b.finish(a.message);
    expect(ka).toEqual(kb);
    expect(ka.length).toBe(32);

    const c = await pakeStart("A", enc.encode("7-zoo-yard"), ...id);
    const d = await pakeStart("B", enc.encode("7-zoo-yarn"), ...id);
    expect(c.finish(d.message)).not.toEqual(d.finish(c.message));
  });

  it("rejects reflected and malformed messages", async () => {
    const id = [enc.encode("a"), enc.encode("b")] as const;
    const a = await pakeStart("A", enc.encode("pw"), ...id);
    expect(() => a.finish(a.message)).toThrow();
    const b = await pakeStart("B", enc.encode("pw"), ...id);
    expect(() => b.finish(new Uint8Array(5))).toThrow();
  });
});

describe("authenticate", () => {
  it("succeeds when both sides use the same code and see the same fingerprints", async () => {
    const [s, r] = await handshake({ senderCode: "4-apple-river", receiverCode: "4-apple-river" });
    expect(s.status).toBe("fulfilled");
    expect(r.status).toBe("fulfilled");
  });

  it("fails confirmation on both sides with a wrong code", async () => {
    const [s, r] = await handshake({ senderCode: "4-apple-river", receiverCode: "4-apple-rival" });
    expect(s.status).toBe("rejected");
    expect(r.status).toBe("rejected");
    expect((s as PromiseRejectedResult).reason).toBeInstanceOf(AuthError);
    expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AuthError);
  });

  it("fails when the nameplate differs even if the words match", async () => {
    const [s, r] = await handshake({ senderCode: "4-apple-river", receiverCode: "5-apple-river" });
    expect([s.status, r.status]).toEqual(["rejected", "rejected"]);
  });

  it("detects a MITM that swapped DTLS fingerprints, even with the right code", async () => {
    // The attacker terminates DTLS with each side using its own certificates and
    // relays the SPAKE2 messages untouched. Each victim sees the attacker's
    // fingerprint as the remote one.
    const [s, r] = await handshake({
      senderCode: "4-apple-river",
      receiverCode: "4-apple-river",
      senderView: [sdp(FP_S), sdp(FP_M1)],
      receiverView: [sdp(FP_R), sdp(FP_M2)],
    });
    expect([s.status, r.status]).toEqual(["rejected", "rejected"]);
  });

  it("detects an extra fingerprint injected into one side's SDP", async () => {
    const [s, r] = await handshake({
      senderCode: "4-apple-river",
      receiverCode: "4-apple-river",
      receiverView: [sdp(FP_R), sdp(FP_S) + `a=fingerprint:sha-256 ${FP_M1}\r\n`],
    });
    expect([s.status, r.status]).toEqual(["rejected", "rejected"]);
  });

  it("fails if a relay tampers with the SPAKE2 messages", async () => {
    const [s, r] = await handshake({
      senderCode: "4-apple-river",
      receiverCode: "4-apple-river",
      tap: (_from, m) => {
        if (m.t !== "pake") return m;
        const raw = Uint8Array.from(atob(m.msg), (c) => c.charCodeAt(0));
        raw[5]! ^= 1;
        return { ...m, msg: btoa(String.fromCharCode(...raw)) };
      },
    });
    expect([s.status, r.status]).toEqual(["rejected", "rejected"]);
  });

  it("canonicalizes fingerprints", () => {
    const a = sdpFingerprints(`a=fingerprint:SHA-256 ab:cd\r\na=fingerprint:sha-256 AB:CD\n`);
    expect(a).toBe("sha-256 AB:CD");
    expect(() => sdpFingerprints("v=0\r\n")).toThrow();
  });
});
