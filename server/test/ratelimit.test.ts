import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter, TokenBucket } from "../src/ratelimit.ts";

describe("SlidingWindowLimiter", () => {
  it("limits after N events and recovers once the window slides", () => {
    let now = 0;
    const l = new SlidingWindowLimiter(5, 60_000, () => now);
    for (let i = 0; i < 5; i++) {
      expect(l.isLimited("ip")).toBe(false);
      l.record("ip");
      now += 1000;
    }
    expect(l.isLimited("ip")).toBe(true);
    expect(l.isLimited("other")).toBe(false);
    now = 60_001; // first event (t=0) has left the window
    expect(l.isLimited("ip")).toBe(false);
    now = 200_000;
    l.prune();
    expect(l.size).toBe(0);
  });
});

describe("TokenBucket", () => {
  it("allows a burst and then refills", () => {
    let now = 0;
    const b = new TokenBucket(3, 1, () => now);
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
    now += 1000;
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });
});
