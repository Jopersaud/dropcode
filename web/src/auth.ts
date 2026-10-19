// Peer authentication: SPAKE2 keyed by the full code, followed by key
// confirmation that binds both peers' DTLS certificate fingerprints.
//
// A signaling server that swaps SDP fingerprints to sit in the middle of the
// DTLS connection necessarily makes each peer see a different
// (sender fingerprint, receiver fingerprint) pair. Each confirmation MAC is
// computed over the pair as *that* peer sees it, so a MITM can only make the
// MACs verify by knowing the code, i.e. by guessing it online.
//
// Wire format (data channel, JSON):  {t:"pake", msg:b64}  then  {t:"confirm", mac:b64}
//   K        = SPAKE2-Ed25519(password = code, idA = ID_SENDER, idB = ID_RECEIVER)
//   T        = "dropcode-v1 confirm\n" || fp(sender) || "\n" || fp(receiver)
//   k_role   = HKDF-SHA256(ikm = K, salt = "", info = "dropcode-v1 confirm " || role, L = 32)
//   mac_role = HMAC-SHA256(k_role, T)

import { pakeStart } from "./pake.ts";

const enc = new TextEncoder();
export const ID_SENDER = enc.encode("dropcode-sender");
export const ID_RECEIVER = enc.encode("dropcode-receiver");
export type Role = "sender" | "receiver";

/**
 * Canonical fingerprint set of the DTLS certificate(s) an SDP announces:
 * lower-case algorithm, upper-case hex, de-duplicated, sorted, comma-joined.
 */
export function sdpFingerprints(sdp: string): string {
  const set = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/.exec(line);
    if (m) set.add(`${m[1]!.toLowerCase()} ${m[2]!.toUpperCase()}`);
  }
  if (set.size === 0) throw new Error("SDP has no DTLS fingerprint");
  return [...set].sort().join(",");
}

export function transcript(fpSender: string, fpReceiver: string): Uint8Array {
  return enc.encode(`dropcode-v1 confirm\n${fpSender}\n${fpReceiver}`);
}

async function macKey(K: Uint8Array, role: Role): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", K as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(`dropcode-v1 confirm ${role}`) },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Transport for the handshake: send a message, receive the next one of a type. */
export interface AuthChannel {
  send(m: { t: "pake"; msg: string } | { t: "confirm"; mac: string }): void;
  recv<T extends "pake" | "confirm">(t: T): Promise<T extends "pake" ? { msg: string } : { mac: string }>;
}

export class AuthError extends Error {}

/**
 * Run the handshake. Resolves on success; throws AuthError if the peer used a
 * different code or the fingerprints do not match (possible MITM).
 */
export async function authenticate(opts: {
  role: Role;
  code: string;
  localSdp: string;
  remoteSdp: string;
  channel: AuthChannel;
  timeoutMs?: number;
}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AuthError("handshake timed out")), opts.timeoutMs ?? 20_000);
  });
  try {
    await Promise.race([handshake(opts), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function handshake(opts: { role: Role; code: string; localSdp: string; remoteSdp: string; channel: AuthChannel }) {
  const { role, channel } = opts;
  const local = sdpFingerprints(opts.localSdp);
  const remote = sdpFingerprints(opts.remoteSdp);
  const T = role === "sender" ? transcript(local, remote) : transcript(remote, local);

  const state = await pakeStart(role === "sender" ? "A" : "B", enc.encode(opts.code), ID_SENDER, ID_RECEIVER);
  channel.send({ t: "pake", msg: b64(state.message) });
  const peer = await channel.recv("pake");
  let K: Uint8Array;
  try {
    K = state.finish(unb64(peer.msg));
  } catch {
    throw new AuthError("PAKE failed");
  }

  const mine = await macKey(K, role);
  const theirs = await macKey(K, role === "sender" ? "receiver" : "sender");
  K.fill(0);
  const myMac = new Uint8Array(await crypto.subtle.sign("HMAC", mine, T as BufferSource));
  channel.send({ t: "confirm", mac: b64(myMac) });
  const { mac } = await channel.recv("confirm");
  let peerMac: Uint8Array;
  try {
    peerMac = unb64(mac);
  } catch {
    throw new AuthError("bad confirmation encoding");
  }
  // WebCrypto's HMAC verify compares in constant time.
  if (!(await crypto.subtle.verify("HMAC", theirs, peerMac as BufferSource, T as BufferSource))) {
    throw new AuthError("key confirmation failed");
  }
}
