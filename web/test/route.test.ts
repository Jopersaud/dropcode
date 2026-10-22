import { describe, expect, it } from "vitest";
import { describeRoute, readRoute } from "../src/route.ts";

/** Minimal stand-in for the slice of RTCPeerConnection that readRoute touches. */
const pcWith = (stats: Array<Record<string, unknown>>) =>
  ({ getStats: async () => new Map(stats.map((s) => [s.id as string, s])) }) as unknown as RTCPeerConnection;

const pair = (local: string, remote: string, extra: Record<string, unknown> = {}) => [
  { id: "p", type: "candidate-pair", state: "succeeded", localCandidateId: "l", remoteCandidateId: "r", ...extra },
  { id: "l", type: "local-candidate", candidateType: local },
  { id: "r", type: "remote-candidate", candidateType: remote },
];

describe("describeRoute", () => {
  it("flags a relay on either end as metered", () => {
    expect(describeRoute("relay", "host").kind).toBe("relay");
    expect(describeRoute("host", "relay").kind).toBe("relay");
    expect(describeRoute("relay", "relay").relayed).toBe(true);
  });

  it("calls host-to-host a local-network connection", () => {
    const r = describeRoute("host", "host");
    expect(r.kind).toBe("local");
    expect(r.relayed).toBe(false);
  });

  it("calls a hole-punched pair direct", () => {
    for (const [a, b] of [
      ["srflx", "srflx"],
      ["srflx", "host"],
      ["prflx", "srflx"],
    ]) {
      const r = describeRoute(a, b);
      expect(r.kind).toBe("direct");
      expect(r.relayed).toBe(false);
    }
  });

  it("does not claim a relay when the types are unknown", () => {
    const r = describeRoute(undefined, undefined);
    expect(r.kind).toBe("unknown");
    expect(r.relayed).toBe(false);
  });
});

describe("readRoute", () => {
  it("reads the nominated succeeded pair", async () => {
    expect((await readRoute(pcWith(pair("relay", "srflx", { nominated: true })))).kind).toBe("relay");
  });

  it("accepts Firefox's `selected` flag", async () => {
    expect((await readRoute(pcWith(pair("host", "host", { selected: true })))).kind).toBe("local");
  });

  it("falls back to any succeeded pair when none is marked", async () => {
    expect((await readRoute(pcWith(pair("srflx", "srflx")))).kind).toBe("direct");
  });

  it("ignores pairs that never succeeded", async () => {
    const stats = pair("relay", "relay");
    stats[0]!.state = "failed";
    expect((await readRoute(pcWith(stats))).kind).toBe("unknown");
  });

  it("reports unknown rather than throwing when getStats fails", async () => {
    const pc = {
      getStats: async () => {
        throw new Error("no stats");
      },
    } as unknown as RTCPeerConnection;
    expect((await readRoute(pc)).kind).toBe("unknown");
  });
});
