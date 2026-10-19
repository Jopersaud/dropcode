import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  CHUNK_SIZE,
  MAX_RANGES,
  PROTOCOL_VERSION,
  bitmapToRanges,
  chunkCount,
  missingRanges,
  parsePeerMessage,
  parseRanges,
  sanitizeName,
  validMime,
  type FileMeta,
  type PeerMessage,
  type Ranges,
} from "./peer-protocol.ts";
import { AuthError, authenticate, type AuthChannel, type Role } from "./auth.ts";
import { PeerLink } from "./rtc.ts";
import { Signaling, defaultSignalingUrl, type ServerMessage } from "./signaling.ts";
import { formatCode, parseCode, randomWords } from "./words.ts";

/** Largest file the browser receiver will buffer in memory. */
export const BROWSER_MAX_RECEIVE = 2 * 1024 ** 3;

export type Phase =
  | "connecting" // to the signaling server
  | "waiting" // sender: code shown, waiting for a receiver
  | "connecting-peer" // WebRTC negotiation
  | "authenticating"
  | "transferring"
  | "verifying"
  | "reconnecting" // peer link dropped; waiting to resume
  | "done"
  | "failed"
  | "cancelled";

export type ErrorCode =
  | "bad_code"
  | "not_found"
  | "expired"
  | "used"
  | "burned"
  | "room_full"
  | "rate_limited"
  | "peer_disconnected"
  | "cancelled_by_peer"
  | "hash_mismatch"
  | "auth_failed"
  | "too_large"
  | "connection_failed"
  | "signaling_failed"
  | "protocol";

export class TransferError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface Callbacks {
  onPhase(phase: Phase): void;
  /** Bytes confirmed transferred so far (including resumed bytes) out of total. */
  onProgress(done: number, total: number): void;
  onError(err: TransferError): void;
  onCode?(code: string, expiresAt: number): void;
  onMeta?(meta: FileMeta): void;
  onHashProgress?(done: number, total: number): void;
  onComplete?(result: { blob: Blob; name: string }): void;
  /** Sender only: someone connected with a wrong code (or a MITM was detected). */
  onAuthFailure?(attempt: number, max: number): void;
  /** Sender only: a receiver could not establish a peer connection; still waiting. */
  onPeerUnreachable?(): void;
}

export interface Options {
  signalingUrl?: string;
}

const SERVER_ERRORS: Record<string, ErrorCode> = {
  not_found: "not_found",
  expired: "expired",
  used: "used",
  burned: "burned",
  room_full: "room_full",
  rate_limited: "rate_limited",
  auth_failed: "auth_failed",
  auth_timeout: "auth_failed",
};

/** Async queue of control messages from one data channel. */
class ChannelReader {
  private queue: PeerMessage[] = [];
  private waiter: { resolve: (m: PeerMessage) => void; reject: (e: Error) => void } | null = null;
  private error: Error | null = null;

  push(m: PeerMessage) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(m);
    } else this.queue.push(m);
  }

  fail(e: Error) {
    this.error ??= e;
    this.waiter?.reject(e);
    this.waiter = null;
  }

  next(): Promise<PeerMessage> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => (this.waiter = { resolve, reject }));
  }

  async expect<T extends PeerMessage["t"]>(t: T): Promise<Extract<PeerMessage, { t: T }>> {
    const m = await this.next();
    if (m.t === "cancel") throw new TransferError("cancelled_by_peer");
    if (m.t !== t) throw new TransferError("protocol", `expected ${t}, got ${m.t}`);
    return m as Extract<PeerMessage, { t: T }>;
  }
}

const send = (dc: RTCDataChannel, m: PeerMessage) => {
  debug(`-> ${m.t} (dc ${dc.id} ${dc.readyState})`);
  dc.send(JSON.stringify(m));
};
/** Diagnostics for the browser console. Never include codes, names or keys. */
const debug = (...args: unknown[]) => console.debug("[dropcode]", ...args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Backoff schedule for reconnecting to the signaling server (ms). */
const BACKOFF = [250, 500, 1000, 2000, 4000, 8000];

/**
 * Shared plumbing: signaling connection, peer links, phase tracking, terminal
 * states. A transfer survives losing either the signaling connection (as long
 * as the peer link is up) or the peer link (by reconnecting through
 * signaling and resuming), once the peers have authenticated each other.
 */
abstract class Transfer {
  protected sig: Signaling | null = null;
  protected iceServers: RTCIceServer[] = [];
  protected link: PeerLink | null = null;
  /** True while the current link has passed key confirmation. */
  protected linkAuthed = false;
  /** True once any session completed authentication: from then on, failures are resumable. */
  protected everAuthed = false;
  protected phase: Phase = "connecting";
  protected finished = false;
  /** The server destroyed the room after a completed transfer; don't reconnect. */
  protected roomDone = false;

  constructor(
    protected readonly cb: Callbacks,
    protected readonly opts: Options = {},
  ) {}

  protected setPhase(p: Phase) {
    if (this.finished) return;
    if (p !== this.phase) debug(`${this.constructor.name}: ${this.phase} -> ${p}`);
    this.phase = p;
    this.cb.onPhase(p);
  }

  /** Open a fresh signaling connection and wait for the server's hello. */
  protected async openSignaling(): Promise<Signaling> {
    this.sig?.close();
    const sig = new Signaling(this.opts.signalingUrl ?? defaultSignalingUrl());
    this.sig = sig;
    sig.onmessage = (m) => {
      if (this.sig === sig && !this.finished) this.onServer(m);
    };
    sig.onclose = () => {
      if (this.sig !== sig) return;
      this.sig = null;
      if (!this.finished && !this.roomDone) this.onSignalingLost();
    };
    const hello = await sig.hello.catch(() => {
      throw new TransferError("signaling_failed");
    });
    this.iceServers = hello.iceServers;
    return sig;
  }

  protected get linkHealthy(): boolean {
    return !!this.link && this.linkAuthed && this.link.dc?.readyState === "open";
  }

  protected abstract onServer(m: ServerMessage): void;
  protected abstract onSignalingLost(): void;

  protected serverError(code: string) {
    this.fail(new TransferError(SERVER_ERRORS[code] ?? "protocol", code));
  }

  protected onClosed(reason: string) {
    if (reason === "done") {
      // The other side already confirmed completion to the server; our own
      // result still comes over the data channel.
      this.roomDone = true;
      return;
    }
    if (this.finished) return;
    if (reason === "cancelled") this.fail(new TransferError("cancelled_by_peer"));
    else if (reason === "expired") this.fail(new TransferError("expired"));
    else if (reason === "burned") this.fail(new TransferError("burned"));
    else this.fail(new TransferError("peer_disconnected"));
  }

  protected fail(err: TransferError) {
    if (this.finished) return;
    debug(`${this.constructor.name} failed: ${err.code} (${err.message})`);
    this.cb.onError(err);
    this.setPhase("failed");
    this.finished = true;
    this.teardown();
  }

  protected succeed() {
    if (this.finished) return;
    this.setPhase("done");
    this.finished = true;
    // Give the final control message a moment to flush before tearing down.
    setTimeout(() => this.teardown(), 2000);
  }

  cancel(): void {
    if (this.finished) return;
    try {
      if (this.link?.dc?.readyState === "open") send(this.link.dc, { t: "cancel" });
    } catch {
      /* ignore */
    }
    this.sig?.send({ t: "cancel" });
    this.setPhase("cancelled");
    this.finished = true;
    setTimeout(() => this.teardown(), 300);
  }

  protected teardown() {
    this.dropLink();
    const sig = this.sig;
    this.sig = null;
    sig?.close();
  }

  protected dropLink() {
    this.link?.close();
    this.link = null;
    this.linkAuthed = false;
  }

  protected newLink(initiator: boolean): PeerLink {
    this.dropLink();
    const link = new PeerLink(this.iceServers, (data) => this.sig?.send({ t: "signal", data }), initiator);
    this.link = link;
    this.setPhase("connecting-peer");
    link.onfail = (reason) => {
      if (this.link !== link || this.finished) return;
      debug(`${this.constructor.name}: link failed in ${this.phase}: ${reason}`);
      this.onLinkFailed(reason);
    };
    return link;
  }

  protected abstract onLinkFailed(reason: string): void;

  /** Wire a data channel to a reader; binary frames go to onBinary. */
  protected attachReader(link: PeerLink, dc: RTCDataChannel, onBinary: (buf: ArrayBuffer) => void): ChannelReader {
    const rd = new ChannelReader();
    link.setMessageHandler((ev) => {
      if (typeof ev.data === "string") {
        const m = parsePeerMessage(ev.data);
        debug(`${this.constructor.name} <- ${m?.t ?? "invalid"} (link ${link.id})`);
        if (!m) rd.fail(new TransferError("protocol", "malformed peer message"));
        else if (m.t === "cancel") this.fail(new TransferError("cancelled_by_peer"));
        else rd.push(m);
      } else onBinary(ev.data as ArrayBuffer);
    });
    dc.addEventListener("close", () => rd.fail(new TransferError("peer_disconnected")));
    return rd;
  }

  /** Version check, then SPAKE2 + fingerprint-bound key confirmation over this data channel. */
  protected async handshake(link: PeerLink, dc: RTCDataChannel, rd: ChannelReader, role: Role, code: string) {
    // The sender (offerer) speaks first; the receiver answers only after hearing
    // it. Messages sent to the offerer before its channel has fully opened can
    // be dropped (observed in Chromium), and the sender's hello proves it is open.
    if (role === "sender") send(dc, { t: "hello", v: PROTOCOL_VERSION });
    const hello = await rd.expect("hello");
    if (role === "receiver") send(dc, { t: "hello", v: PROTOCOL_VERSION });
    if (hello.v !== PROTOCOL_VERSION) throw new TransferError("protocol", "version mismatch");
    this.setPhase("authenticating");
    const channel: AuthChannel = {
      send: (m) => send(dc, m),
      recv: async (t) => (await rd.expect(t)) as never,
    };
    try {
      await authenticate({
        role,
        code,
        localSdp: link.pc.localDescription!.sdp,
        remoteSdp: link.pc.remoteDescription!.sdp,
        channel,
      });
    } catch (e) {
      if (e instanceof TransferError && e.code === "cancelled_by_peer") throw e;
      throw new TransferError("auth_failed", e instanceof AuthError ? e.message : String(e));
    }
    if (this.link === link) {
      this.linkAuthed = true;
      this.everAuthed = true;
    }
  }

  /** Run one data-channel session; errors end the session (and maybe the transfer). */
  protected async runGuarded(link: PeerLink, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      if (this.link !== link || this.finished) return;
      const err = e instanceof TransferError ? e : new TransferError("protocol", String(e));
      debug(`${this.constructor.name}: session ended in ${this.phase}: ${err.code} (${err.message})`);
      if (err.code === "peer_disconnected") this.onLinkFailed("channel closed");
      else if (err.code === "auth_failed") this.onAuthFailed(link, err);
      else {
        // Spend the code. On a hash mismatch the sender does this after hearing
        // from the receiver, so the receiver's server message can't overtake
        // its own data-channel report.
        if (err.code === "protocol" || (err.code === "hash_mismatch" && this instanceof Sender))
          this.sig?.send({ t: "cancel" });
        this.fail(err);
      }
    }
  }

  protected onAuthFailed(_link: PeerLink, err: TransferError) {
    this.fail(err);
  }
}

export async function hashFile(file: Blob, onProgress?: (done: number, total: number) => void): Promise<string> {
  const h = sha256.create();
  const block = 4 * 1024 * 1024;
  for (let off = 0; off < file.size; off += block) {
    const buf = await file.slice(off, off + block).arrayBuffer();
    h.update(new Uint8Array(buf));
    onProgress?.(Math.min(off + block, file.size), file.size);
  }
  return bytesToHex(h.digest());
}

export class Sender extends Transfer {
  private words = randomWords();
  private code = "";
  private nameplate = "";
  private token = "";
  private meta: Promise<FileMeta>;
  private authFailures = 0;
  private reclaiming = false;
  /** Exposed for tests: chunks put on the wire, and what each session skipped. */
  chunksSent = 0;
  sessions: { skippedChunks: number }[] = [];

  constructor(
    private readonly file: File,
    cb: Callbacks,
    opts?: Options,
  ) {
    super(cb, opts);
    this.meta = hashFile(file, cb.onHashProgress).then((sha) => ({
      name: sanitizeName(file.name),
      size: file.size,
      mime: validMime(file.type),
      sha256: sha,
      chunkSize: CHUNK_SIZE,
    }));
    this.meta.catch(() => {});
  }

  async start(): Promise<void> {
    this.setPhase("connecting");
    try {
      const sig = await this.openSignaling();
      sig.send({ t: "create" });
    } catch (e) {
      this.fail(e instanceof TransferError ? e : new TransferError("signaling_failed"));
    }
  }

  /** Phase to show while there is no usable peer link. */
  private get idlePhase(): Phase {
    return this.everAuthed ? "reconnecting" : "waiting";
  }

  protected onServer(m: ServerMessage) {
    switch (m.t) {
      case "created":
        this.nameplate = m.nameplate;
        this.token = m.token;
        this.code = formatCode(m.nameplate, this.words);
        this.cb.onCode?.(this.code, m.expiresAt);
        this.setPhase("waiting");
        break;
      case "reclaimed":
        if (m.receiverPresent && !this.linkHealthy) this.startLink();
        break;
      case "peer_joined":
        this.startLink();
        break;
      case "peer_left":
        if (!this.everAuthed) this.cb.onCode?.(this.code, m.expiresAt);
        // The receiver's signaling dropping doesn't matter while our link is up.
        if (this.link && !this.linkHealthy) this.onLinkFailed("peer left");
        break;
      case "signal":
        this.link?.handleSignal(m.data);
        break;
      case "closed":
        this.onClosed(m.reason);
        break;
      case "error":
        this.serverError(m.code);
        break;
    }
  }

  private startLink() {
    const link = this.newLink(true);
    link.onopen = (dc) => this.runGuarded(link, () => this.session(link, dc));
    link.start().catch(() => this.onLinkFailed("negotiation failed"));
  }

  /** Our signaling connection dropped: take the room back with our token. */
  protected onSignalingLost() {
    if (!this.nameplate) return this.fail(new TransferError("signaling_failed"));
    if (!this.linkHealthy) {
      this.dropLink();
      this.setPhase("reconnecting");
    }
    void this.reclaim();
  }

  private async reclaim() {
    if (this.reclaiming) return;
    this.reclaiming = true;
    try {
      for (const delay of BACKOFF) {
        await sleep(delay);
        if (this.finished) return;
        try {
          const sig = await this.openSignaling();
          sig.send({ t: "reclaim", nameplate: this.nameplate, token: this.token });
          return;
        } catch {
          /* try again */
        }
      }
      // Without signaling we can still finish over a healthy peer link.
      if (!this.linkHealthy) this.fail(new TransferError("signaling_failed"));
    } finally {
      this.reclaiming = false;
    }
  }

  protected override serverError(code: string) {
    // A failed reclaim is fatal only if we can't finish over the current link.
    if (this.linkHealthy && (code === "not_found" || code === "expired")) return;
    super.serverError(code);
  }

  protected onLinkFailed(reason: string) {
    const link = this.link;
    if (!link) return;
    if (this.phase === "authenticating") return this.rejectPeer(link);
    const neverConnected = this.phase === "connecting-peer";
    this.dropLink();
    if (neverConnected && !this.everAuthed) {
      // The receiver sees the failure itself; keep the code alive for a retry.
      this.cb.onPeerUnreachable?.();
      this.setPhase("waiting");
      return;
    }
    if (this.everAuthed) {
      // Resume when the receiver reconnects (it re-joins the room).
      this.setPhase("reconnecting");
      return;
    }
    this.fail(new TransferError(reason === "timeout" ? "connection_failed" : "peer_disconnected", reason));
  }

  protected override onAuthFailed(link: PeerLink) {
    this.rejectPeer(link);
  }

  /**
   * The receiver failed key confirmation. Drop it, tell the server (which
   * burns the room after 3 failures) and keep waiting for the real receiver.
   */
  private rejectPeer(link: PeerLink) {
    if (this.link !== link || this.finished) return;
    this.dropLink();
    this.authFailures++;
    this.sig?.send({ t: "auth_failed" });
    this.cb.onAuthFailure?.(this.authFailures, 3);
    this.setPhase(this.idlePhase);
  }

  private async session(link: PeerLink, dc: RTCDataChannel) {
    const rd = this.attachReader(link, dc, () => rd.fail(new TransferError("protocol", "unexpected binary")));
    await this.handshake(link, dc, rd, "sender", this.code);
    this.sig?.send({ t: "authed" });

    const meta = await this.meta;
    send(dc, { t: "meta", ...meta });
    const total = chunkCount(meta.size);
    const resume = await rd.expect("resume");
    const have = parseRanges(resume.have, total);
    if (!have) throw new TransferError("protocol", "bad resume ranges");
    const missing = missingRanges(have, total);
    this.sessions.push({ skippedChunks: have.reduce((n, [a, b]) => n + b - a, 0) });

    this.setPhase("transferring");
    await this.stream(link, dc, meta, missing);
    send(dc, { t: "eof" });
    this.setPhase("verifying");

    const res = await rd.next();
    if (res.t === "ok") {
      this.sig?.send({ t: "done" });
      this.cb.onProgress(meta.size, meta.size);
      this.succeed();
    } else if (res.t === "hash_mismatch") throw new TransferError("hash_mismatch");
    else throw new TransferError("protocol", `unexpected ${res.t}`);
  }

  private async stream(link: PeerLink, dc: RTCDataChannel, meta: FileMeta, ranges: Ranges) {
    const total = chunkCount(meta.size);
    let missing = 0;
    for (const [a, b] of ranges) missing += b - a;
    const alreadyHad = total - missing;
    let sentBytes = Math.min(alreadyHad * CHUNK_SIZE, meta.size);
    const report = () => this.cb.onProgress(Math.max(0, sentBytes - dc.bufferedAmount), meta.size);
    const ticker = setInterval(report, 200);
    const BLOCK = 16; // chunks per file read
    try {
      for (const [a, b] of ranges) {
        for (let i = a; i < b; i += BLOCK) {
          const end = Math.min(i + BLOCK, b);
          const buf = await this.file
            .slice(i * CHUNK_SIZE, Math.min(end * CHUNK_SIZE, meta.size))
            .arrayBuffer();
          for (let j = i; j < end; j++) {
            if (this.finished || this.link !== link) throw new TransferError("peer_disconnected");
            await link.waitForDrain().catch(() => {
              throw new TransferError("peer_disconnected");
            });
            const off = (j - i) * CHUNK_SIZE;
            const view = new Uint8Array(buf, off, Math.min(CHUNK_SIZE, buf.byteLength - off));
            dc.send(view);
            this.chunksSent++;
            sentBytes += view.byteLength;
          }
        }
      }
    } finally {
      clearInterval(ticker);
      if (this.link === link) report();
    }
  }
}

export class Receiver extends Transfer {
  private parsed;
  private meta: FileMeta | null = null;
  private chunks: (Uint8Array | undefined)[] = [];
  private received = 0;
  private rejoining = false;

  constructor(code: string, cb: Callbacks, opts?: Options) {
    super(cb, opts);
    this.parsed = parseCode(code);
  }

  async start(): Promise<void> {
    if (!this.parsed) return this.fail(new TransferError("bad_code"));
    this.setPhase("connecting");
    try {
      await this.join();
    } catch (e) {
      this.fail(e instanceof TransferError ? e : new TransferError("signaling_failed"));
    }
  }

  private async join() {
    const sig = await this.openSignaling();
    sig.send({ t: "join", nameplate: this.parsed!.nameplate });
  }

  protected onServer(m: ServerMessage) {
    switch (m.t) {
      case "joined":
        if (!this.everAuthed) this.setPhase("connecting-peer");
        break;
      case "signal":
        if (m.data.kind === "offer") {
          const link = this.newLink(false);
          link.onopen = (dc) => this.runGuarded(link, () => this.session(link, dc));
        }
        this.link?.handleSignal(m.data);
        break;
      case "peer_left":
        // The sender's signaling dropped; it has a grace period to reclaim the room.
        break;
      case "closed":
        this.onClosed(m.reason);
        break;
      case "error":
        if (m.code === "room_full" && this.rejoining) return; // our old slot is still being released
        this.serverError(m.code);
        break;
    }
  }

  protected onSignalingLost() {
    if (this.linkHealthy) return; // not needed until the link fails
    if (this.everAuthed) void this.rejoin();
    else this.fail(new TransferError("signaling_failed"));
  }

  protected onLinkFailed(reason: string) {
    if (!this.link) return;
    const phase = this.phase;
    this.dropLink();
    if (this.everAuthed) {
      this.setPhase("reconnecting");
      void this.rejoin();
      return;
    }
    if (phase === "authenticating") this.fail(new TransferError("auth_failed", reason));
    else this.fail(new TransferError(reason === "timeout" ? "connection_failed" : "peer_disconnected", reason));
  }

  /** Re-join the room with the same code; the sender re-offers and we resume. */
  private async rejoin() {
    if (this.rejoining) return;
    this.rejoining = true;
    try {
      for (const delay of [...BACKOFF, 8000, 8000, 8000, 8000]) {
        if (this.finished || this.linkHealthy) return;
        // Drop our old slot first so the server sends the sender a fresh peer_joined.
        const old = this.sig;
        this.sig = null;
        old?.close();
        await sleep(delay);
        if (this.finished) return;
        try {
          await this.join();
          // Give the sender time to offer; a new link resets this loop.
          await sleep(10_000);
          if (this.link || this.finished) return;
        } catch {
          /* server unreachable; retry */
        }
      }
      this.fail(new TransferError("peer_disconnected"));
    } finally {
      this.rejoining = false;
    }
  }

  private async session(link: PeerLink, dc: RTCDataChannel) {
    // Chunks arrive in ascending order over the missing ranges; track position.
    let ranges: Ranges = [];
    let rangeIdx = 0;
    let next = 0;
    const advance = () => {
      next++;
      while (rangeIdx < ranges.length && next >= ranges[rangeIdx]![1]) {
        rangeIdx++;
        if (rangeIdx < ranges.length) next = ranges[rangeIdx]![0];
      }
    };
    const onBinary = (buf: ArrayBuffer) => {
      const meta = this.meta;
      if (!meta || rangeIdx >= ranges.length || this.link !== link)
        return rd.fail(new TransferError("protocol", "unexpected chunk"));
      const total = chunkCount(meta.size);
      const want = next === total - 1 ? meta.size - next * CHUNK_SIZE : CHUNK_SIZE;
      if (buf.byteLength !== want) return rd.fail(new TransferError("protocol", "bad chunk size"));
      if (!this.chunks[next]) {
        this.chunks[next] = new Uint8Array(buf);
        this.received += buf.byteLength;
      }
      advance();
      this.cb.onProgress(this.received, meta.size);
    };
    const rd = this.attachReader(link, dc, onBinary);

    await this.handshake(link, dc, rd, "receiver", this.parsed!.code);

    const meta = await rd.expect("meta");
    const { t: _t, ...fm } = meta;
    if (this.meta && (this.meta.sha256 !== fm.sha256 || this.meta.size !== fm.size))
      throw new TransferError("protocol", "file changed between sessions");
    if (fm.size > BROWSER_MAX_RECEIVE) throw new TransferError("too_large");
    if (!this.meta) {
      this.meta = fm;
      this.chunks = new Array(chunkCount(fm.size));
      this.cb.onMeta?.(fm);
    }
    const total = chunkCount(fm.size);
    // Report what we already hold so the sender skips it.
    const have = bitmapToRanges((i) => this.chunks[i] !== undefined, total).slice(0, MAX_RANGES);
    ranges = missingRanges(have, total);
    rangeIdx = 0;
    next = ranges.length ? ranges[0]![0] : 0;
    send(dc, { t: "resume", have });
    this.setPhase("transferring");
    this.cb.onProgress(this.received, fm.size);

    await rd.expect("eof");
    if (rangeIdx < ranges.length) throw new TransferError("protocol", "eof before all chunks");
    this.setPhase("verifying");
    const h = sha256.create();
    for (let i = 0; i < total; i++) {
      h.update(this.chunks[i]!);
      if (i % 256 === 255) await new Promise((r) => setTimeout(r, 0));
    }
    if (bytesToHex(h.digest()) !== fm.sha256) {
      send(dc, { t: "hash_mismatch" });
      throw new TransferError("hash_mismatch");
    }
    send(dc, { t: "ok" });
    this.sig?.send({ t: "done" });
    const blob = new Blob(this.chunks as BlobPart[], { type: fm.mime });
    this.chunks = [];
    this.cb.onComplete?.({ blob, name: fm.name });
    this.succeed();
  }
}
