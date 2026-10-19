import wordlistText from "../../shared/wordlist.txt";

/** BIP-39 English list: 2048 words, so 11 bits per word. */
export const WORDS: readonly string[] = wordlistText.split("\n").filter(Boolean);
const WORD_SET = new Set(WORDS);
if (WORDS.length !== 2048) throw new Error("wordlist must have 2048 entries");

/** Two words chosen with crypto.getRandomValues (2048 is a power of two, so masking is unbiased). */
export function randomWords(): [string, string] {
  const r = crypto.getRandomValues(new Uint16Array(2));
  return [WORDS[r[0]! & 0x7ff]!, WORDS[r[1]! & 0x7ff]!];
}

export interface ParsedCode {
  nameplate: string;
  words: [string, string];
  /** Canonical form, used verbatim as the SPAKE2 password. */
  code: string;
}

/** Accepts "4-apple-river", " 4 Apple  River ", etc. Returns null if invalid. */
export function parseCode(input: string): ParsedCode | null {
  const parts = input.trim().toLowerCase().split(/[\s-]+/).filter(Boolean);
  if (parts.length !== 3) return null;
  const [nameplate, w1, w2] = parts as [string, string, string];
  if (!/^[1-9][0-9]{0,5}$/.test(nameplate)) return null;
  if (!WORD_SET.has(w1) || !WORD_SET.has(w2)) return null;
  return { nameplate, words: [w1, w2], code: `${nameplate}-${w1}-${w2}` };
}

export function formatCode(nameplate: string, words: [string, string]): string {
  return `${nameplate}-${words[0]}-${words[1]}`;
}
