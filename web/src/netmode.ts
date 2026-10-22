// How far a transfer is allowed to reach.
//
// "local" offers no ICE servers at all, so only host candidates are gathered and
// the peers can only meet if they can already reach each other directly — same
// Wi-Fi, same LAN. That can never engage a TURN relay, so it never costs the
// operator bandwidth. "any" uses whatever the server offered (STUN, and TURN as
// a last resort), which works between networks but may be relayed.

export type NetMode = "local" | "any";

export const DEFAULT_NET_MODE: NetMode = "any";

const STORAGE_KEY = "dropcode.netmode";

/**
 * A server running with ICE_TRANSPORT_POLICY=relay requires every connection to
 * be relayed, which is exactly what "local" refuses to do; the modes cannot both
 * be honoured, so the server's policy wins.
 */
export function lanModeAvailable(policy: RTCIceTransportPolicy): boolean {
  return policy !== "relay";
}

export function iceConfigFor(
  mode: NetMode,
  iceServers: RTCIceServer[],
  policy: RTCIceTransportPolicy,
): RTCConfiguration {
  if (mode === "local" && lanModeAvailable(policy)) {
    return { iceServers: [], iceTransportPolicy: "all" };
  }
  return { iceServers, iceTransportPolicy: policy };
}

export function isNetMode(v: unknown): v is NetMode {
  return v === "local" || v === "any";
}

/** Reading storage throws in some privacy modes; fall back to the default. */
export function loadNetMode(store: Pick<Storage, "getItem"> | undefined = safeStorage()): NetMode {
  try {
    const v = store?.getItem(STORAGE_KEY);
    return isNetMode(v) ? v : DEFAULT_NET_MODE;
  } catch {
    return DEFAULT_NET_MODE;
  }
}

export function saveNetMode(mode: NetMode, store: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    store?.setItem(STORAGE_KEY, mode);
  } catch {
    // A remembered preference is a convenience; losing it is not an error.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
