import { describe, expect, it } from "vitest";
import { encodeQr, MAX_VERSION, qrSvg, versionFor } from "../src/qr.ts";

/**
 * Golden matrices captured from this encoder and verified, module for module,
 * against the independent `qrcode-generator` reference implementation, and
 * decoded back by `jsQR`. They pin the data encoding, Reed-Solomon codewords,
 * interleaving, module placement, masking and format information all at once.
 */
const GOLDEN_A = [
  "#######.##.#..#######",
  "#.....#..##...#.....#",
  "#.###.#..####.#.###.#",
  "#.###.#.###...#.###.#",
  "#.###.#.###.#.#.###.#",
  "#.....#.####..#.....#",
  "#######.#.#.#.#######",
  "........#.###........",
  "#...#.###..#.#####..#",
  "..#.#...#..##..#.#.##",
  "####.##...##..#####..",
  "###....#.#...##.#.##.",
  "###.#####...###...###",
  "........#.#.###...###",
  "#######.##..##.....#.",
  "#.....#..####..#.#.#.",
  "#.###.#.####..#######",
  "#.###.#..#.##..#.#.##",
  "#.###.#....#..#####..",
  "#.....#..#...##.#.#..",
  "#######.#.#.###...#.#",
];

const GOLDEN_URL = [
  "#######...#.##.#..##..#######",
  "#.....#.#.#..###.##.#.#.....#",
  "#.###.#.....##.....##.#.###.#",
  "#.###.#.###.#.######..#.###.#",
  "#.###.#..#......#..#..#.###.#",
  "#.....#.##.##..##.....#.....#",
  "#######.#.#.#.#.#.#.#.#######",
  ".........###..###.#..........",
  "#####.####.#...#.##.##.#.#.#.",
  ".##.##....#.###.####.####...#",
  "..#.#.#.#.#..###.....##.#....",
  ".##.........##..#....#.#...#.",
  ".#..###.###.#.####.##....##..",
  ".......###......#.##.####.#.#",
  "###..##.#.###..##.#...###.#..",
  "....#...#..#..##......#.#..#.",
  "..##..#...##.....#..#.....#..",
  "###.......#.###.#..#..#####.#",
  "#...#.#.#.#..###..#..#.#.##..",
  "#.#..#.###..##....#...#.#..#.",
  "#..#.####...#.####.######.###",
  "........##......#..##...#####",
  "#######.##.##..##.###.#.###..",
  "#.....#...##..###.#.#...##.#.",
  "#.###.#.#..#.....#..#####.#..",
  "#.###.#.##..###..##.#....####",
  "#.###.#.###..####...#.###..#.",
  "#.....#.##..##.##.###..#.#.#.",
  "#######.##..#.##.#...#.#..#..",
];

const render = (qr: { size: number; modules: boolean[] }) =>
  Array.from({ length: qr.size }, (_, r) =>
    Array.from({ length: qr.size }, (_, c) => (qr.modules[r * qr.size + c] ? "#" : ".")).join(""),
  );

describe("encodeQr", () => {
  it("reproduces a reference-verified version 1 symbol", () => {
    const qr = encodeQr("A", "M", 4)!;
    expect(qr.version).toBe(1);
    expect(qr.size).toBe(21);
    expect(render(qr)).toEqual(GOLDEN_A);
  });

  it("reproduces a reference-verified version 3 symbol", () => {
    const qr = encodeQr("http://localhost:8080/#4-apple-river", "L", 2)!;
    expect(qr.version).toBe(3);
    expect(render(qr)).toEqual(GOLDEN_URL);
  });

  it("places the three finder patterns and the dark module", () => {
    const qr = encodeQr("https://example.com/#1-zebra-mountain", "M")!;
    const n = qr.size;
    const dark = (r: number, c: number) => qr.modules[r * n + c];
    for (const [br, bc] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6;
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          expect(dark(br + r, bc + c)).toBe(ring || core);
        }
      }
    }
    expect(dark(n - 8, 8)).toBe(true); // the always-dark module
    for (let i = 8; i < n - 8; i++) {
      expect(dark(6, i)).toBe(i % 2 === 0); // timing patterns
      expect(dark(i, 6)).toBe(i % 2 === 0);
    }
  });

  it("round-trips every mask to a valid symbol of the same size", () => {
    const sizes = new Set<number>();
    for (let m = 0; m < 8; m++) sizes.add(encodeQr("mask check", "M", m)!.size);
    expect(sizes.size).toBe(1);
  });

  it("grows the version with the payload and gives up past the limit", () => {
    expect(encodeQr("x", "M")!.version).toBe(1);
    expect(encodeQr("x".repeat(100), "M")!.version).toBeGreaterThan(3);
    expect(encodeQr("x".repeat(500), "M")).toBeNull();
    expect(encodeQr("x".repeat(500), "L")).toBeNull();
  });

  it("encodes an empty string and multi-byte characters", () => {
    expect(encodeQr("", "M")).not.toBeNull();
    // "é" is two UTF-8 bytes, so capacity is counted in bytes, not characters.
    expect(versionFor(new TextEncoder().encode("é".repeat(10)).length, "M")).toBe(versionFor(20, "M"));
  });
});

describe("versionFor", () => {
  it("matches the published byte-mode capacities", () => {
    // Version 1 holds 17 bytes at L and 14 at M: the data codewords less the
    // four-bit mode indicator and eight-bit character count.
    expect(versionFor(17, "L")).toBe(1);
    expect(versionFor(18, "L")).toBe(2);
    expect(versionFor(14, "M")).toBe(1);
    expect(versionFor(15, "M")).toBe(2);
    expect(versionFor(1, "M")).toBe(1);
  });

  it("returns null beyond the supported versions", () => {
    expect(versionFor(10_000, "L")).toBeNull();
    expect(MAX_VERSION).toBe(10);
  });

  it("gives level L more room than level M", () => {
    expect(versionFor(100, "L")!).toBeLessThanOrEqual(versionFor(100, "M")!);
  });
});
