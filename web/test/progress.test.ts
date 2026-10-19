import { describe, expect, it } from "vitest";
import { RateMeter, formatBytes, formatDuration, percent } from "../src/progress.ts";

describe("RateMeter", () => {
  it("computes rate and ETA over a sliding window", () => {
    let now = 0;
    const m = new RateMeter(3000, () => now);
    expect(m.rate).toBe(0);
    expect(m.eta(100)).toBeNull();
    for (let i = 0; i <= 10; i++) {
      now = i * 1000;
      m.update(i * 1_000_000);
    }
    expect(m.rate).toBeCloseTo(1_000_000);
    expect(m.eta(20_000_000)).toBeCloseTo(10);
  });
});

describe("formatting", () => {
  it("formats bytes, durations and percentages", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(52_428_800)).toBe("52 MB");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatDuration(null)).toBe("–");
    expect(formatDuration(4.2)).toBe("5s");
    expect(formatDuration(125)).toBe("2m 05s");
    expect(formatDuration(3 * 3600 + 60)).toBe("3h 01m");
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(0, 0)).toBe(100);
  });
});
