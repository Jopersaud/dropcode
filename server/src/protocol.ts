// Wire protocol between browser/CLI clients and the signaling server.
// Everything a client sends is untrusted: parseClientMessage() is the only
// way raw input turns into a typed message.

export const MAX_MESSAGE_BYTES = 32 * 1024;
export const MAX_SDP_BYTES = 16 * 1024;
export const MAX_CANDIDATE_BYTES = 1024;
export const NAMEPLATE_RE = /^[1-9][0-9]{0,5}$/;
export const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;

export type SignalData =
  | { kind: "offer" | "answer"; sdp: string }
  | {
      kind: "candidate";
      candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };
    }
  | { kind: "end-of-candidates" };

export type ClientMessage =
  | { t: "create" }
  | { t: "reclaim"; nameplate: string; token: string }
  | { t: "join"; nameplate: string }
  | { t: "signal"; data: SignalData }
  | { t: "authed" }
  | { t: "auth_failed" }
  | { t: "done" }
  | { t: "cancel" }
  | { t: "ping" };

export type ErrorCode =
  | "bad_message"
  | "bad_state"
  | "not_found"
  | "expired"
  | "used"
  | "burned"
  | "room_full"
  | "rate_limited"
  | "auth_failed"
  | "auth_timeout"
  | "too_many_rooms"
  | "server_full";

export type CloseReason = "done" | "cancelled" | "expired" | "burned" | "sender_left";

export type ServerMessage =
  | { t: "hello"; iceServers: IceServer[]; ttlMs: number }
  | { t: "created"; nameplate: string; token: string; expiresAt: number }
  | { t: "reclaimed"; receiverPresent: boolean }
  | { t: "joined" }
  | { t: "peer_joined" }
  | { t: "peer_left" }
  | { t: "signal"; data: SignalData }
  | { t: "closed"; reason: CloseReason }
  | { t: "error"; code: ErrorCode }
  | { t: "pong" };

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasOnlyKeys = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).every((k) => keys.includes(k));

const isStr = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length <= max;

function parseSignal(d: unknown): SignalData | null {
  if (!isObj(d)) return null;
  switch (d.kind) {
    case "offer":
    case "answer":
      if (!hasOnlyKeys(d, ["kind", "sdp"]) || !isStr(d.sdp, MAX_SDP_BYTES) || d.sdp.length === 0)
        return null;
      return { kind: d.kind, sdp: d.sdp };
    case "candidate": {
      if (!hasOnlyKeys(d, ["kind", "candidate"]) || !isObj(d.candidate)) return null;
      const c = d.candidate;
      if (!hasOnlyKeys(c, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])) return null;
      if (!isStr(c.candidate, MAX_CANDIDATE_BYTES)) return null;
      const sdpMid = c.sdpMid ?? null;
      const sdpMLineIndex = c.sdpMLineIndex ?? null;
      if (sdpMid !== null && !isStr(sdpMid, 64)) return null;
      if (
        sdpMLineIndex !== null &&
        !(Number.isInteger(sdpMLineIndex) && (sdpMLineIndex as number) >= 0 && (sdpMLineIndex as number) < 64)
      )
        return null;
      if (c.usernameFragment !== undefined && c.usernameFragment !== null && !isStr(c.usernameFragment, 256))
        return null;
      return {
        kind: "candidate",
        candidate: { candidate: c.candidate, sdpMid, sdpMLineIndex: sdpMLineIndex as number | null },
      };
    }
    case "end-of-candidates":
      return hasOnlyKeys(d, ["kind"]) ? { kind: "end-of-candidates" } : null;
    default:
      return null;
  }
}

/** Parse and validate a raw WebSocket frame. Returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || typeof m.t !== "string") return null;
  switch (m.t) {
    case "create":
    case "authed":
    case "auth_failed":
    case "done":
    case "cancel":
    case "ping":
      return hasOnlyKeys(m, ["t"]) ? ({ t: m.t } as ClientMessage) : null;
    case "join":
      if (!hasOnlyKeys(m, ["t", "nameplate"]) || typeof m.nameplate !== "string") return null;
      return NAMEPLATE_RE.test(m.nameplate) ? { t: "join", nameplate: m.nameplate } : null;
    case "reclaim":
      if (!hasOnlyKeys(m, ["t", "nameplate", "token"])) return null;
      if (typeof m.nameplate !== "string" || !NAMEPLATE_RE.test(m.nameplate)) return null;
      if (typeof m.token !== "string" || !TOKEN_RE.test(m.token)) return null;
      return { t: "reclaim", nameplate: m.nameplate, token: m.token };
    case "signal": {
      if (!hasOnlyKeys(m, ["t", "data"])) return null;
      const data = parseSignal(m.data);
      return data ? { t: "signal", data } : null;
    }
    default:
      return null;
  }
}
