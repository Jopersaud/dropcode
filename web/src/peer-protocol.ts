// Messages exchanged directly between peers over the WebRTC data channel.
// Control messages are JSON text frames; file data travels as binary frames
// of exactly CHUNK_SIZE bytes (the final chunk may be shorter), in ascending
// index order, skipping chunks the receiver already has. Because the channel
// is ordered and reliable, chunk indices are implicit.

export const PROTOCOL_VERSION = 1;
export const CHUNK_SIZE = 64 * 1024;
export const MAX_CONTROL_BYTES = 64 * 1024;
export const MAX_NAME_BYTES = 255;
export const MAX_MIME_LENGTH = 100;
/** 1 TiB. The browser receiver applies its own, smaller, memory-based cap. */
export const MAX_FILE_SIZE = 2 ** 40;
export const MAX_RANGES = 4096;

export interface FileMeta {
  name: string;
  size: number;
  mime: string;
  sha256: string;
  chunkSize: number;
}

/** Half-open [start, end) chunk-index ranges. */
export type Ranges = [number, number][];

export type PeerMessage =
  | { t: "hello"; v: number }
  | { t: "pake"; msg: string }
  | { t: "confirm"; mac: string }
  | ({ t: "meta" } & FileMeta)
  | { t: "resume"; have: Ranges }
  | { t: "eof" }
  | { t: "ok" }
  | { t: "hash_mismatch" }
  | { t: "cancel" };

export const chunkCount = (size: number, chunkSize = CHUNK_SIZE) => Math.ceil(size / chunkSize);

const enc = new TextEncoder();
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).every((k) => keys.includes(k));
const B64_RE = /^[A-Za-z0-9+/]{1,1024}={0,2}$/;

/**
 * Make a received file name safe to offer as a download name: no path
 * components, no control characters, bounded length.
 */
export function sanitizeName(raw: string): string {
  let name = raw.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  name = name.split(/[\\/]/).pop() ?? "";
  name = name.replace(/^[.\s]+/, "").replace(/[\s.]+$/, "").replace(/[<>:"|?*]/g, "_");
  while (enc.encode(name).length > MAX_NAME_BYTES) name = name.slice(0, -1);
  return name || "download";
}

export function validMime(m: unknown): string {
  return typeof m === "string" && m.length <= MAX_MIME_LENGTH && /^[\w.+-]+\/[\w.+-]+$/.test(m)
    ? m
    : "application/octet-stream";
}

export function parseRanges(v: unknown, total: number): Ranges | null {
  if (!Array.isArray(v) || v.length > MAX_RANGES) return null;
  const out: Ranges = [];
  let prevEnd = 0;
  for (const r of v) {
    if (!Array.isArray(r) || r.length !== 2) return null;
    const [a, b] = r;
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    if (a < prevEnd || b <= a || b > total) return null; // sorted, non-overlapping, in bounds
    out.push([a, b]);
    prevEnd = b;
  }
  return out;
}

export function parsePeerMessage(raw: string): PeerMessage | null {
  if (raw.length > MAX_CONTROL_BYTES) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || typeof m.t !== "string") return null;
  switch (m.t) {
    case "hello":
      return onlyKeys(m, ["t", "v"]) && Number.isInteger(m.v) ? { t: "hello", v: m.v as number } : null;
    case "pake":
      return onlyKeys(m, ["t", "msg"]) && typeof m.msg === "string" && B64_RE.test(m.msg)
        ? { t: "pake", msg: m.msg }
        : null;
    case "confirm":
      return onlyKeys(m, ["t", "mac"]) && typeof m.mac === "string" && B64_RE.test(m.mac)
        ? { t: "confirm", mac: m.mac }
        : null;
    case "meta": {
      if (!onlyKeys(m, ["t", "name", "size", "mime", "sha256", "chunkSize"])) return null;
      if (typeof m.name !== "string" || m.name.length > 4 * MAX_NAME_BYTES) return null;
      if (!Number.isSafeInteger(m.size) || (m.size as number) < 0 || (m.size as number) > MAX_FILE_SIZE)
        return null;
      if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) return null;
      if (m.chunkSize !== CHUNK_SIZE) return null;
      return {
        t: "meta",
        name: sanitizeName(m.name),
        size: m.size as number,
        mime: validMime(m.mime),
        sha256: m.sha256,
        chunkSize: CHUNK_SIZE,
      };
    }
    case "resume":
      // Range bounds are checked against the file once meta is known.
      if (!onlyKeys(m, ["t", "have"]) || !Array.isArray(m.have) || m.have.length > MAX_RANGES) return null;
      return { t: "resume", have: m.have as Ranges };
    case "eof":
    case "ok":
    case "hash_mismatch":
    case "cancel":
      return onlyKeys(m, ["t"]) ? ({ t: m.t } as PeerMessage) : null;
    default:
      return null;
  }
}

/** Complement of `have` within [0, total). */
export function missingRanges(have: Ranges, total: number): Ranges {
  const out: Ranges = [];
  let cur = 0;
  for (const [a, b] of have) {
    if (a > cur) out.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (cur < total) out.push([cur, total]);
  return out;
}

/** Compress a presence bitmap into sorted ranges. */
export function bitmapToRanges(has: (i: number) => boolean, total: number): Ranges {
  const out: Ranges = [];
  let start = -1;
  for (let i = 0; i < total; i++) {
    if (has(i)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, total]);
  return out;
}
