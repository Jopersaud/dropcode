import { describe, expect, it } from "vitest";
import {
  bitmapToRanges,
  missingRanges,
  parsePeerMessage,
  parseRanges,
  sanitizeName,
  validMime,
} from "../src/peer-protocol.ts";

const sha = "a".repeat(64);

describe("peer message validation", () => {
  it("accepts and normalizes metadata", () => {
    const m = parsePeerMessage(
      JSON.stringify({ t: "meta", name: "../../etc/pass\u0000wd", size: 10, mime: "text/plain", sha256: sha, chunkSize: 65536 }),
    );
    expect(m).toEqual({ t: "meta", name: "passwd", size: 10, mime: "text/plain", sha256: sha, chunkSize: 65536 });
  });

  it.each([
    { t: "meta", name: "a", size: -1, mime: "x/y", sha256: sha, chunkSize: 65536 },
    { t: "meta", name: "a", size: 2 ** 41, mime: "x/y", sha256: sha, chunkSize: 65536 },
    { t: "meta", name: "a", size: 1.5, mime: "x/y", sha256: sha, chunkSize: 65536 },
    { t: "meta", name: "a", size: 1, mime: "x/y", sha256: "zz", chunkSize: 65536 },
    { t: "meta", name: "a", size: 1, mime: "x/y", sha256: sha, chunkSize: 1024 },
    { t: "meta", name: "a".repeat(2000), size: 1, mime: "x/y", sha256: sha, chunkSize: 65536 },
    { t: "meta", name: "a", size: 1, mime: "x/y", sha256: sha, chunkSize: 65536, extra: 1 },
    { t: "pake", msg: "not base64!" },
    { t: "nope" },
  ])("rejects %o", (m) => {
    expect(parsePeerMessage(JSON.stringify(m))).toBeNull();
  });

  it("caps names and mime types", () => {
    expect(new TextEncoder().encode(sanitizeName("é".repeat(300))).length).toBeLessThanOrEqual(255);
    expect(sanitizeName("...")).toBe("download");
    expect(sanitizeName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(validMime("text/html; charset=utf-8")).toBe("application/octet-stream");
    expect(validMime("image/png")).toBe("image/png");
  });
});

describe("ranges", () => {
  it("validates resume ranges", () => {
    expect(parseRanges([[0, 2], [5, 6]], 10)).toEqual([[0, 2], [5, 6]]);
    expect(parseRanges([[0, 11]], 10)).toBeNull();
    expect(parseRanges([[3, 3]], 10)).toBeNull();
    expect(parseRanges([[5, 6], [0, 2]], 10)).toBeNull();
    expect(parseRanges([[0, 2], [1, 3]], 10)).toBeNull();
    expect(parseRanges([["0", 2]], 10)).toBeNull();
  });

  it("computes missing ranges and compresses bitmaps", () => {
    expect(missingRanges([], 4)).toEqual([[0, 4]]);
    expect(missingRanges([[0, 2], [3, 4]], 6)).toEqual([[2, 3], [4, 6]]);
    expect(missingRanges([[0, 6]], 6)).toEqual([]);
    const has = new Set([0, 1, 2, 5, 7, 8]);
    expect(bitmapToRanges((i) => has.has(i), 9)).toEqual([[0, 3], [5, 6], [7, 9]]);
  });
});
