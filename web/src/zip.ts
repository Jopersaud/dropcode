// A minimal ZIP container, stored (uncompressed) only.
//
// Compression is deliberately absent. Storing entries means an archive can be
// assembled as a composite Blob without reading any file into memory, and an
// entry can be extracted with a single blob.slice() — no decompression, no
// second copy. That keeps both sides flat in memory, which matters because the
// browser receiver already holds the whole transfer.

/** Written into the end-of-central-directory comment so we only auto-expand our own bundles. */
export const BUNDLE_MARKER = "dropcode-bundle/1";

/** ZIP's 32-bit fields cap an archive, and its entries, at 4 GiB. */
export const ZIP_MAX_BYTES = 0xffffffff;

export interface ZipEntry {
  name: string;
  size: number;
  /** The entry's bytes, sliced lazily out of the archive. */
  blob(): Blob;
}

const enc = new TextEncoder();
/** Copy into a plain ArrayBuffer so the result is usable as a BlobPart. */
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(enc.encode(s));
const dec = new TextDecoder();

// ---------------------------------------------------------------- crc32

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = ~seed >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** CRC a blob without holding more than one block of it at a time. */
export async function crc32Blob(blob: Blob, onProgress?: (done: number) => void): Promise<number> {
  const BLOCK = 4 * 1024 * 1024;
  let crc = 0;
  for (let off = 0; off < blob.size; off += BLOCK) {
    const buf = await blob.slice(off, off + BLOCK).arrayBuffer();
    crc = crc32(new Uint8Array(buf), crc);
    onProgress?.(Math.min(off + BLOCK, blob.size));
  }
  return crc;
}

// ---------------------------------------------------------------- writing

const u8 = (n: number) => n & 0xff;

function bytes(...parts: Array<[number, 1 | 2 | 4]>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, [, w]) => n + w, 0));
  let i = 0;
  for (const [v, width] of parts) {
    for (let b = 0; b < width; b++) out[i++] = u8(v >>> (8 * b)); // little-endian
  }
  return out;
}

/**
 * Names are stored UTF-8 with general-purpose bit 11 set, and stripped of path
 * separators so an archive can never place a file outside its extraction root.
 */
export function zipSafeName(raw: string): string {
  const name = raw.replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+$/, "");
  return clean || "file";
}

/** Give every entry a distinct name; ZIP allows duplicates but extraction tools cope badly. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = zipSafeName(raw);
    const key = name.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n === 0) return name;
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    return `${stem} (${n})${ext}`;
  });
}

export interface BuildZipResult {
  blob: Blob;
  entries: { name: string; size: number }[];
}

/**
 * Assemble `files` into a stored archive. The returned Blob references the
 * source files rather than copying them, so this is cheap in memory; the only
 * full read is the CRC pass, which `onProgress` reports against `totalBytes`.
 */
export async function buildZip(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<BuildZipResult> {
  const names = uniqueNames(files.map((f) => f.name));
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > ZIP_MAX_BYTES) throw new RangeError("bundle too large for a 32-bit zip");

  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  const entries: { name: string; size: number }[] = [];
  let offset = 0;
  let hashed = 0;

  for (const [i, file] of files.entries()) {
    const name = utf8(names[i]!);
    const crc = await crc32Blob(file, (done) => onProgress?.(hashed + done, total));
    hashed += file.size;
    onProgress?.(hashed, total);

    // Local file header: store method, no data descriptor, UTF-8 name flag.
    const local = bytes(
      [0x04034b50, 4], [20, 2], [0x0800, 2], [0, 2],
      [0, 2], [0, 2], // dos time/date: zeroed, we have no trustworthy local clock to promise
      [crc, 4], [file.size, 4], [file.size, 4],
      [name.length, 2], [0, 2],
    );
    parts.push(local, name, file);

    central.push(
      bytes(
        [0x02014b50, 4], [20, 2], [20, 2], [0x0800, 2], [0, 2],
        [0, 2], [0, 2],
        [crc, 4], [file.size, 4], [file.size, 4],
        [name.length, 2], [0, 2], [0, 2], [0, 2], [0, 2], [0, 4],
        [offset, 4],
      ),
      name,
    );
    offset += local.length + name.length + file.size;
    entries.push({ name: names[i]!, size: file.size });
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const comment = utf8(BUNDLE_MARKER);
  parts.push(
    ...central,
    bytes(
      [0x06054b50, 4], [0, 2], [0, 2],
      [files.length, 2], [files.length, 2],
      [centralSize, 4], [offset, 4], [comment.length, 2],
    ),
    comment,
  );

  return { blob: new Blob(parts, { type: "application/zip" }), entries };
}

// ---------------------------------------------------------------- reading

const EOCD_SIG = 0x06054b50;
const EOCD_MIN = 22;

/**
 * Parse the central directory. Returns null for anything that is not a stored
 * archive we can read, so callers fall back to treating the payload as one file.
 */
export async function readZip(blob: Blob): Promise<ZipEntry[] | null> {
  if (blob.size < EOCD_MIN || blob.size > ZIP_MAX_BYTES) return null;
  // The EOCD sits at the end, after a comment of up to 64 KiB.
  const tailLen = Math.min(blob.size, EOCD_MIN + 0xffff);
  const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - EOCD_MIN; i >= 0; i--) {
    if (tail.getUint32(i, true) !== EOCD_SIG) continue;
    // The signature can occur inside file data by chance, and a truncated
    // archive keeps its signature while losing bytes, so require the declared
    // comment length to account for exactly what follows.
    const absEnd = blob.size - tailLen + i + EOCD_MIN;
    if (absEnd + tail.getUint16(i + 20, true) !== blob.size) continue;
    eocd = i;
    break;
  }
  if (eocd < 0) return null;

  const count = tail.getUint16(eocd + 10, true);
  const centralSize = tail.getUint32(eocd + 12, true);
  const centralOff = tail.getUint32(eocd + 16, true);
  if (centralOff + centralSize > blob.size) return null;

  const cd = new DataView(await blob.slice(centralOff, centralOff + centralSize).arrayBuffer());
  const out: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== 0x02014b50) return null;
    const method = cd.getUint16(p + 10, true);
    const size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const localOff = cd.getUint32(p + 42, true);
    if (method !== 0) return null; // stored only; see the note at the top
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    if (localOff + 30 > blob.size) return null;

    // The local header repeats the name/extra lengths, which may differ from the
    // central copy, so the data offset has to come from the local header itself.
    const lh = new DataView(await blob.slice(localOff, localOff + 30).arrayBuffer());
    if (lh.getUint32(0, true) !== 0x04034b50) return null;
    const dataAt = localOff + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    if (dataAt + size > blob.size) return null;

    out.push({ name: zipSafeName(name), size, blob: () => blob.slice(dataAt, dataAt + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** True when this archive was produced by buildZip, so expanding it is expected. */
export async function isBundle(blob: Blob): Promise<boolean> {
  if (blob.size < EOCD_MIN) return false;
  const marker = utf8(BUNDLE_MARKER);
  if (blob.size < marker.length) return false;
  const tail = new Uint8Array(await blob.slice(blob.size - marker.length).arrayBuffer());
  return tail.every((b, i) => b === marker[i]);
}
