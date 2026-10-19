// Thin WebSocket client for the signaling server. Message shapes mirror
// server/src/protocol.ts.

export type SignalData =
  | { kind: "offer" | "answer"; sdp: string }
  | { kind: "candidate"; candidate: RTCIceCandidateInit }
  | { kind: "end-of-candidates" };

export type ServerMessage =
  | { t: "hello"; iceServers: RTCIceServer[]; ttlMs: number }
  | { t: "created"; nameplate: string; token: string; expiresAt: number }
  | { t: "reclaimed"; receiverPresent: boolean }
  | { t: "joined" }
  | { t: "peer_joined" }
  | { t: "peer_left"; expiresAt: number }
  | { t: "signal"; data: SignalData }
  | { t: "closed"; reason: string }
  | { t: "error"; code: string }
  | { t: "pong" };

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

export function defaultSignalingUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

export class Signaling {
  private ws: WebSocket;
  private pingTimer: number | undefined;
  onmessage: (m: ServerMessage) => void = () => {};
  /** Fired when the socket closes for any reason. */
  onclose: () => void = () => {};
  readonly hello: Promise<Extract<ServerMessage, { t: "hello" }>>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    let resolveHello!: (m: Extract<ServerMessage, { t: "hello" }>) => void;
    let rejectHello!: (e: Error) => void;
    this.hello = new Promise((res, rej) => {
      resolveHello = res;
      rejectHello = rej;
    });
    this.ws.onmessage = (ev) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.t === "hello") resolveHello(m);
      else if (m.t !== "pong") this.onmessage(m);
    };
    this.ws.onclose = () => {
      clearInterval(this.pingTimer);
      rejectHello(new Error("signaling connection failed"));
      this.onclose();
    };
    this.ws.onopen = () => {
      this.pingTimer = window.setInterval(() => this.send({ t: "ping" }), 20_000);
    };
  }

  send(m: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    clearInterval(this.pingTimer);
    this.onclose = () => {};
    this.ws.close();
  }
}
