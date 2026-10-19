import type { SignalData } from "./signaling.ts";

export const BUFFER_LOW = 1 << 20;
export const BUFFER_HIGH = 4 << 20;
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * One WebRTC connection attempt. The sender is always the offerer and
 * creates the single ordered, reliable data channel.
 */
let nextId = 1;

export class PeerLink {
  readonly id = nextId++;
  readonly pc: RTCPeerConnection;
  dc: RTCDataChannel | null = null;
  private pending: RTCIceCandidateInit[] = [];
  private closed = false;
  private timer: number;
  private disconnectTimer: number | undefined;
  /** Messages that arrive before a handler is attached (the peer may send before our "open" fires). */
  private early: MessageEvent[] = [];
  private handler: ((ev: MessageEvent) => void) | null = null;
  onopen: (dc: RTCDataChannel) => void = () => {};
  /** Fired at most once, when the link can no longer be used. */
  onfail: (reason: string) => void = () => {};

  constructor(
    config: RTCConfiguration,
    private readonly sendSignal: (data: SignalData) => void,
    private readonly initiator: boolean,
  ) {
    this.pc = new RTCPeerConnection(config);
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) this.signal({ kind: "candidate", candidate: ev.candidate.toJSON() });
      else this.signal({ kind: "end-of-candidates" });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "failed") this.fail("connection failed");
      else if (s === "disconnected") {
        // Transient blips are common on network changes; give ICE a moment.
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = window.setTimeout(() => {
          if (this.pc.connectionState === "disconnected") this.fail("connection lost");
        }, 5000);
      }
    };
    this.pc.ondatachannel = (ev) => {
      if (this.initiator || this.dc) {
        ev.channel.close();
        return;
      }
      this.setupChannel(ev.channel);
    };
    this.timer = window.setTimeout(() => {
      if (!this.dc || this.dc.readyState !== "open") this.fail("timeout");
    }, CONNECT_TIMEOUT_MS);
  }

  async start(): Promise<void> {
    if (!this.initiator) return;
    this.setupChannel(this.pc.createDataChannel("dropcode", { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    this.signal({ kind: "offer", sdp: this.pc.localDescription!.sdp });
  }

  async handleSignal(data: SignalData): Promise<void> {
    if (this.closed) return;
    try {
      if (data.kind === "offer" && !this.initiator) {
        await this.pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
        await this.flushCandidates();
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.signal({ kind: "answer", sdp: this.pc.localDescription!.sdp });
      } else if (data.kind === "answer" && this.initiator) {
        await this.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
        await this.flushCandidates();
      } else if (data.kind === "candidate") {
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.candidate);
        else if (this.pending.length < 256) this.pending.push(data.candidate);
      }
    } catch {
      this.fail("negotiation failed");
    }
  }

  private async flushCandidates() {
    const list = this.pending;
    this.pending = [];
    for (const c of list) await this.pc.addIceCandidate(c).catch(() => {});
  }

  private setupChannel(dc: RTCDataChannel) {
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = BUFFER_LOW;
    dc.onmessage = (ev) => {
      if (this.handler) this.handler(ev);
      else if (this.early.length < 64) this.early.push(ev);
    };
    dc.onopen = () => {
      clearTimeout(this.timer);
      this.onopen(dc);
    };
    dc.onclose = () => this.fail("channel closed");
    dc.onerror = () => this.fail("channel error");
  }

  /** Route data-channel messages to `fn`, first replaying any that arrived early. */
  setMessageHandler(fn: (ev: MessageEvent) => void): void {
    this.handler = fn;
    for (const ev of this.early.splice(0)) fn(ev);
  }

  private signal(data: SignalData) {
    if (!this.closed) this.sendSignal(data);
  }

  /** Resolves once the send buffer has drained below the high-water mark. */
  waitForDrain(): Promise<void> {
    const dc = this.dc;
    if (!dc || dc.readyState !== "open") return Promise.reject(new Error("channel closed"));
    if (dc.bufferedAmount <= BUFFER_HIGH) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => {
        dc.removeEventListener("bufferedamountlow", onLow);
        dc.removeEventListener("close", onClose);
      };
      const onLow = () => {
        done();
        resolve();
      };
      const onClose = () => {
        done();
        reject(new Error("channel closed"));
      };
      dc.addEventListener("bufferedamountlow", onLow);
      dc.addEventListener("close", onClose);
    });
  }

  private fail(reason: string) {
    if (this.closed) return;
    this.close();
    this.onfail(reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.disconnectTimer);
    if (this.dc) {
      this.dc.onclose = null;
      this.dc.onerror = null;
      this.dc.close();
    }
    this.pc.close();
  }
}
