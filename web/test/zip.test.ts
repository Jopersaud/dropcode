import { describe, expect, it } from "vitest";
import { BUNDLE_MARKER, buildZip, crc32, isBundle, readZip, uniqueNames, zipSafeName } from "../src/zip.ts";

const file = (name: string, body: string | Uint8Array) =>
  new File([body], name, { type: "application/octet-stream" });

const text = async (b: Blob) => new TextDecoder().decode(new Uint8Array(await b.arrayBuffer()));

describe("crc32", () => {
  it("matches the standard check value", () => {
    // The CRC-32/ISO-HDLC check vector: "123456789" -> 0xcbf43926.
    expect(crc32(new TextEncoder().encode("123456789")) >>> 0).toBe(0xcbf43926);
  });

  it("is resumable across blocks", () => {
    const all = new TextEncoder().encode("hello world");
    const a = crc32(all.slice(0, 5));
    expect(crc32(all.slice(5), a)).toBe(crc32(all));
  });

  it("hashes empty input to zero", () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("names", () => {
  it("strips path components so entries cannot escape extraction", () => {
    expect(zipSafeName("../../etc/passwd")).toBe("passwd");
    expect(zipSafeName("a\\b\\c.txt")).toBe("c.txt");
    expect(zipSafeName("/abs/path.png")).toBe("path.png");
  });

  it("never yields an empty name", () => {
    expect(zipSafeName("")).toBe("file");
    expect(zipSafeName("...")).toBe("file");
    expect(zipSafeName("/")).toBe("file");
  });

  it("disambiguates duplicates while keeping extensions", () => {
    expect(uniqueNames(["a.txt", "a.txt", "a.txt"])).toEqual(["a.txt", "a (1).txt", "a (2).txt"]);
    expect(uniqueNames(["x", "x"])).toEqual(["x", "x (1)"]);
    expect(uniqueNames(["P.png", "p.png"])).toEqual(["P.png", "p (1).png"]); // case-insensitive
  });
});

describe("buildZip / readZip round-trip", () => {
  it("restores every file's name and exact bytes", async () => {
    const files = [file("one.txt", "hello"), file("two.bin", new Uint8Array([0, 1, 2, 255])), file("three.txt", "")];
    const { blob, entries } = await buildZip(files);
    expect(entries).toEqual([
      { name: "one.txt", size: 5 },
      { name: "two.bin", size: 4 },
      { name: "three.txt", size: 0 },
    ]);

    const read = await readZip(blob);
    expect(read).not.toBeNull();
    expect(read!.map((e) => e.name)).toEqual(["one.txt", "two.bin", "three.txt"]);
    expect(read!.map((e) => e.size)).toEqual([5, 4, 0]);
    expect(await text(read![0]!.blob())).toBe("hello");
    expect(new Uint8Array(await read![1]!.blob().arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(await text(read![2]!.blob())).toBe("");
  });

  it("survives unicode names and larger bodies spanning CRC blocks", async () => {
    const big = new Uint8Array(5 * 1024 * 1024).map((_, i) => i & 0xff);
    const { blob } = await buildZip([file("café ☕.txt", "naïve"), file("big.bin", big)]);
    const read = await readZip(blob);
    expect(read!.map((e) => e.name)).toEqual(["café ☕.txt", "big.bin"]);
    expect(await text(read![0]!.blob())).toBe("naïve");
    // Compare by checksum: toEqual on five million elements is pathologically slow.
    const got = new Uint8Array(await read![1]!.blob().arrayBuffer());
    expect(got.byteLength).toBe(big.byteLength);
    expect(crc32(got)).toBe(crc32(big));
  });

  it("sanitizes path-bearing names on the way in", async () => {
    const { blob } = await buildZip([file("../evil.sh", "x")]);
    expect((await readZip(blob))![0]!.name).toBe("evil.sh");
  });

  it("marks its output as a dropcode bundle", async () => {
    const { blob } = await buildZip([file("a", "a")]);
    expect(await isBundle(blob)).toBe(true);
    expect(await text(blob.slice(blob.size - BUNDLE_MARKER.length))).toBe(BUNDLE_MARKER);
  });

  it("handles a single file and reports total progress monotonically", async () => {
    const seen: number[] = [];
    const { blob } = await buildZip([file("solo.txt", "abc")], (done, total) => {
      expect(total).toBe(3);
      seen.push(done);
    });
    expect(seen.at(-1)).toBe(3);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(await text((await readZip(blob))![0]!.blob())).toBe("abc");
  });
});

describe("readZip rejects what it cannot serve", () => {
  it("returns null for non-zip input", async () => {
    expect(await readZip(new Blob(["not a zip at all"]))).toBeNull();
    expect(await readZip(new Blob([]))).toBeNull();
  });

  it("returns null for a truncated archive", async () => {
    const { blob } = await buildZip([file("a.txt", "hello there")]);
    expect(await readZip(blob.slice(0, blob.size - 8))).toBeNull(); // EOCD chopped
    expect(await readZip(blob.slice(0, 40))).toBeNull();
  });

  it("does not claim a foreign zip is a bundle", async () => {
    const { blob } = await buildZip([file("a.txt", "x")]);
    const foreign = blob.slice(0, blob.size - BUNDLE_MARKER.length); // same bytes, marker removed
    expect(await isBundle(foreign)).toBe(false);
    expect(await isBundle(new Blob(["zzz"]))).toBe(false);
  });
});
