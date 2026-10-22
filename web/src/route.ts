// How the file bytes actually travelled. A TURN relay is the fallback when no
// direct path exists; it is also the only path that costs the server operator
// bandwidth, so it is worth showing rather than hiding.

export type RouteKind = "local" | "direct" | "relay" | "unknown";

export interface RouteInfo {
  kind: RouteKind;
  label: string;
  detail: string;
  /** True when bytes flow through a TURN relay (metered on most providers). */
  relayed: boolean;
}

/**
 * Classify a connection from the ICE candidate types of its selected pair.
 * "host" on both ends means the peers reached each other without leaving the
 * local network; "relay" on either end means a TURN server is in the path.
 */
export function describeRoute(local: string | undefined, remote: string | undefined): RouteInfo {
  if (!local || !remote) {
    return { kind: "unknown", label: "Connected", detail: "Route unknown.", relayed: false };
  }
  if (local === "relay" || remote === "relay") {
    return {
      kind: "relay",
      label: "Via relay",
      detail: "No direct path was available, so the data went through a TURN relay.",
      relayed: true,
    };
  }
  if (local === "host" && remote === "host") {
    return {
      kind: "local",
      label: "Direct · local network",
      detail: "The data went straight between the two devices on your network.",
      relayed: false,
    };
  }
  return {
    kind: "direct",
    label: "Direct",
    detail: "The data went peer to peer, without a relay.",
    relayed: false,
  };
}

/** Read the selected candidate pair, mirroring what the e2e suite asserts on. */
export async function readRoute(pc: RTCPeerConnection): Promise<RouteInfo> {
  try {
    const stats = [...(await pc.getStats()).values()] as Array<Record<string, unknown>>;
    const pairs = stats.filter((s) => s.type === "candidate-pair" && s.state === "succeeded");
    // Firefox reports `selected`; Chromium nominates. Fall back to any succeeded pair.
    const pair = pairs.find((s) => s.nominated) ?? pairs.find((s) => s.selected) ?? pairs[0];
    if (!pair) return describeRoute(undefined, undefined);
    const typeOf = (id: unknown) =>
      stats.find((s) => s.id === id)?.candidateType as string | undefined;
    return describeRoute(typeOf(pair.localCandidateId), typeOf(pair.remoteCandidateId));
  } catch {
    return describeRoute(undefined, undefined);
  }
}
