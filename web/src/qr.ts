// A QR encoder, byte mode, versions 1-10, error-correction levels L and M.
//
// Only what is needed to put a share link on screen: a URL is bytes, and
// version 10 at level L holds 271 of them, which is far more than any dropcode
// link. Capping at 10 keeps the block tables short; anything longer is refused
// so the caller can fall back to showing the link instead of a broken symbol.

export type EccLevel = "L" | "M";

export interface QrCode {
  /** Modules per side. */
  size: number;
  /** True where the module is dark. Row-major, `size * size` long. */
  modules: boolean[];
  version: number;
}

// ------------------------------------------------------------ GF(256)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = x << 1;
    if (x & 0x100) x ^= 0x11d; // the QR field's primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

function polyMul(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j]! ^= mul(a[i]!, b[j]!);
  }
  return out;
}

/** Generator polynomial for `degree` error-correction codewords. */
function rsGenerator(degree: number): Uint8Array {
  let poly: Uint8Array = Uint8Array.of(1);
  for (let i = 0; i < degree; i++) poly = polyMul(poly, Uint8Array.of(1, EXP[i]!));
  return poly;
}

/** Remainder of data·x^eccLen divided by the generator: the ECC codewords. */
function rsEncode(data: Uint8Array, eccLen: number): Uint8Array {
  const gen = rsGenerator(eccLen);
  const buf = new Uint8Array(data.length + eccLen);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j]! ^= mul(gen[j]!, factor);
  }
  return buf.slice(data.length);
}

// ------------------------------------------------------------ tables

/**
 * Per version (1-10) and level: ECC codewords per block, then the block groups
 * as [count, dataCodewords] pairs. Straight from the spec's table 13-22.
 */
const BLOCKS: Record<EccLevel, Array<[number, Array<[number, number]>]>> = {
  L: [
    [7, [[1, 19]]], [10, [[1, 34]]], [15, [[1, 55]]], [20, [[1, 80]]], [26, [[1, 108]]],
    [18, [[2, 68]]], [20, [[2, 78]]], [24, [[2, 97]]], [30, [[2, 116]]], [18, [[2, 68], [2, 69]]],
  ],
  M: [
    [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
    [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]],
    [26, [[4, 43], [1, 44]]],
  ],
};

/** Alignment-pattern centre coordinates per version (1-10). */
const ALIGN: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

/** Pre-computed 18-bit version information, only needed from version 7. */
const VERSION_INFO: Record<number, number> = {
  7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3,
};

const ECC_BITS: Record<EccLevel, number> = { L: 0b01, M: 0b00 };

export const MAX_VERSION = 10;

const dataCapacity = (version: number, ecc: EccLevel) => {
  const [, groups] = BLOCKS[ecc][version - 1]!;
  return groups.reduce((n, [count, data]) => n + count * data, 0);
};

// ------------------------------------------------------------ encoding

class BitBuffer {
  readonly bits: number[] = [];
  put(value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** Byte-mode payload: mode, character count, data, terminator and padding. */
function encodeData(bytes: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
  const capacity = dataCapacity(version, ecc);
  const buf = new BitBuffer();
  buf.put(0b0100, 4); // byte mode
  buf.put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) buf.put(b, 8);

  const capacityBits = capacity * 8;
  buf.put(0, Math.min(4, capacityBits - buf.bits.length)); // terminator
  while (buf.bits.length % 8 !== 0) buf.bits.push(0);

  const out = new Uint8Array(capacity);
  for (let i = 0; i < buf.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | buf.bits[i + j]!;
    out[i / 8] = byte;
  }
  for (let i = buf.bits.length / 8, pad = 0; i < capacity; i++, pad++) {
    out[i] = pad % 2 === 0 ? 0xec : 0x11; // the spec's alternating pad bytes
  }
  return out;
}

/** Split into blocks, add ECC to each, then interleave as the spec requires. */
function interleave(data: Uint8Array, version: number, ecc: EccLevel): Uint8Array {
  const [eccLen, groups] = BLOCKS[ecc][version - 1]!;
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(at, at + size);
      at += size;
      dataBlocks.push(block);
      eccBlocks.push(rsEncode(block, eccLen));
    }
  }

  const out: number[] = [];
  const widest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < widest; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]!);
  }
  for (let i = 0; i < eccLen; i++) {
    for (const b of eccBlocks) out.push(b[i]!);
  }
  return Uint8Array.from(out);
}

// ------------------------------------------------------------ matrix

type Grid = { size: number; cells: Int8Array; fixed: Uint8Array };

const idx = (g: Grid, r: number, c: number) => r * g.size + c;

function set(g: Grid, r: number, c: number, dark: boolean, fixed = true) {
  g.cells[idx(g, r, c)] = dark ? 1 : 0;
  if (fixed) g.fixed[idx(g, r, c)] = 1;
}

function placeFinder(g: Grid, row: number, col: number) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= g.size || cc < 0 || cc >= g.size) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(g, rr, cc, inRing || inCore);
    }
  }
}

function buildFunctionPatterns(version: number): Grid {
  const size = version * 4 + 17;
  const g: Grid = { size, cells: new Int8Array(size * size).fill(-1), fixed: new Uint8Array(size * size) };

  placeFinder(g, 0, 0);
  placeFinder(g, 0, size - 7);
  placeFinder(g, size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0; // timing patterns
    set(g, 6, i, dark);
    set(g, i, 6, dark);
  }

  const centres = ALIGN[version - 1]!;
  for (const r of centres) {
    for (const c of centres) {
      // The three finder corners have no alignment pattern.
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(g, r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  set(g, size - 8, 8, true); // the always-dark module

  // Reserve the format areas; the values are written after masking.
  for (let i = 0; i < 9; i++) {
    if (i !== 6) set(g, 8, i, false);
    if (i !== 6) set(g, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(g, 8, size - 1 - i, false);
    if (i < 7) set(g, size - 1 - i, 8, false);
  }

  if (version >= 7) {
    const info = VERSION_INFO[version]!;
    for (let i = 0; i < 18; i++) {
      const dark = ((info >> i) & 1) === 1;
      set(g, Math.floor(i / 3), size - 11 + (i % 3), dark);
      set(g, size - 11 + (i % 3), Math.floor(i / 3), dark);
    }
  }
  return g;
}

/** Walk the zigzag, two columns at a time from the bottom right, skipping column 6. */
function placeData(g: Grid, codewords: Uint8Array) {
  let bit = 0;
  let upward = true;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is not data
    for (let step = 0; step < g.size; step++) {
      const row = upward ? g.size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (g.fixed[idx(g, row, col)]) continue;
        const byte = codewords[bit >> 3] ?? 0;
        set(g, row, col, ((byte >> (7 - (bit & 7))) & 1) === 1, false);
        bit++;
      }
    }
    upward = !upward;
  }
}

const maskFn = (mask: number, r: number, c: number): boolean => {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
};

function applyMask(g: Grid, mask: number) {
  for (let r = 0; r < g.size; r++) {
    for (let c = 0; c < g.size; c++) {
      if (g.fixed[idx(g, r, c)]) continue;
      if (maskFn(mask, r, c)) g.cells[idx(g, r, c)] = g.cells[idx(g, r, c)]! ^ 1;
    }
  }
}

/**
 * The fifteen format modules, in bit order, for each of the two copies. Both
 * carry bit 14 first and walk away from the top-left finder. The second copy's
 * vertical run is seven modules, not eight: the eighth is the always-dark
 * module, which is not part of the format.
 */
function formatPositions(size: number): [number, number][][] {
  const copy1: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const copy2: [number, number][] = [];
  for (let i = 0; i < 7; i++) copy2.push([size - 1 - i, 8]);
  for (let i = 0; i < 8; i++) copy2.push([8, size - 8 + i]);
  return [copy1, copy2];
}

function writeFormat(g: Grid, ecc: EccLevel, mask: number) {
  const data = (ECC_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537); // BCH(15,5)
  const bits = ((data << 10) | rem) ^ 0x5412;

  for (const copy of formatPositions(g.size)) {
    copy.forEach(([r, c], k) => set(g, r, c, ((bits >>> (14 - k)) & 1) === 1));
  }
}

/** The spec's four penalty rules; the lowest-scoring mask wins. */
function penalty(g: Grid): number {
  const n = g.size;
  const at = (r: number, c: number) => g.cells[idx(g, r, c)] === 1;
  let score = 0;

  for (let i = 0; i < n; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      let prev = horizontal ? at(i, 0) : at(0, i);
      for (let j = 1; j < n; j++) {
        const cur = horizontal ? at(i, j) : at(j, i);
        if (cur === prev) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
          prev = cur;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // The 1:1:3:1:1 finder-like run, which must be penalised in both orientations.
  const A = [true, false, true, true, true, false, true, false, false, false, false];
  const B = [false, false, false, false, true, false, true, true, true, false, true];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j + 11 <= n; j++) {
      let rowA = true, rowB = true, colA = true, colB = true;
      for (let k = 0; k < 11; k++) {
        const h = at(i, j + k);
        const v = at(j + k, i);
        if (h !== A[k]) rowA = false;
        if (h !== B[k]) rowB = false;
        if (v !== A[k]) colA = false;
        if (v !== B[k]) colB = false;
      }
      if (rowA) score += 40;
      if (rowB) score += 40;
      if (colA) score += 40;
      if (colB) score += 40;
    }
  }

  let dark = 0;
  for (let i = 0; i < n * n; i++) if (g.cells[i] === 1) dark++;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

// ------------------------------------------------------------ public

/** Smallest version that fits `byteLength`, or null if it does not fit at all. */
export function versionFor(byteLength: number, ecc: EccLevel): number | null {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const header = 4 + (v < 10 ? 8 : 16);
    if (dataCapacity(v, ecc) * 8 >= header + byteLength * 8) return v;
  }
  return null;
}

/**
 * Encode `text` as a QR symbol. Returns null when it is too long for version 10,
 * so callers can fall back rather than render something unscannable.
 */
export function encodeQr(text: string, ecc: EccLevel = "M", forceMask?: number): QrCode | null {
  const bytes = new TextEncoder().encode(text);
  const version = versionFor(bytes.length, ecc);
  if (version === null) return null;

  const codewords = interleave(encodeData(bytes, version, ecc), version, ecc);

  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let mask = forceMask ?? 0; mask < 8; mask++) {
    const g = buildFunctionPatterns(version);
    placeData(g, codewords);
    applyMask(g, mask);
    writeFormat(g, ecc, mask);
    const score = penalty(g);
    if (score < bestScore) {
      bestScore = score;
      best = g;
    }
    if (forceMask !== undefined) break;
  }

  const g = best!;
  return { size: g.size, version, modules: Array.from(g.cells, (v) => v === 1) };
}

/**
 * Render as inline SVG. One path of 1x1 squares on a light background, with the
 * quiet zone the spec requires — scanners need it, so it is not optional.
 */
export function qrSvg(qr: QrCode, { quiet = 4, title = "" } = {}): SVGSVGElement {
  const span = qr.size + quiet * 2;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${span} ${span}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  if (title) svg.setAttribute("aria-label", title);

  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", String(span));
  bg.setAttribute("height", String(span));
  bg.setAttribute("fill", "#fff");
  svg.append(bg);

  let d = "";
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r * qr.size + c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000");
  svg.append(path);
  return svg;
}
