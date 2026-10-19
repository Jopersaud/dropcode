import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  CHUNK_SIZE,
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

const send = (dc: RTCDataChannel, m: PeerMessage) => dc.send(JSON.stringify(m));

/** Shared plumbing: signaling connection, phase tracking, terminal states. */
abstract class Transfer {
  protected sig!: Signaling;
  protected iceServers: RTCIceServer[] = [];
  protected link: PeerLink | null = null;
  protected phase: Phase = "connecting";
  protected finished = false;

  constructor(
    protected readonly cb: Callbacks,
    protected readonly opts: Options = {},
  ) {}

  protected setPhase(p: Phase) {
    if (this.finished) return;
    this.phase = p;
    this.cb.onPhase(p);
  }

  protected async connectSignaling(): Promise<void> {
    this.setPhase("connecting");
    this.sig = new Signaling(this.opts.signalingUrl ?? defaultSignalingUrl());
    this.sig.onmessage = (m) => this.onServer(m);
    this.sig.onclose = () => {
      if (!this.finished) this.fail(new TransferError("signaling_failed"));
    };
    const hello = await this.sig.hello.catch(() => {
      throw new TransferError("signaling_failed");
    });
    this.iceServers = hello.iceServers;
  }

  protected abstract onServer(m: ServerMessage): void;

  protected serverError(code: string) {
    this.fail(new TransferError(SERVER_ERRORS[code] ?? "protocol", code));
  }

  protected onClosed(reason: string) {
    if (this.finished) return;
    if (reason === "cancelled") this.fail(new TransferError("cancelled_by_peer"));
    else if (reason === "expired") this.fail(new TransferError("expired"));
    else if (reason === "sender_left") this.fail(new TransferError("peer_disconnected"));
    else if (reason === "burned") this.fail(new TransferError("burned"));
    else this.fail(new TransferError("peer_disconnected"));
  }

  protected fail(err: TransferError) {
    if (this.finished) return;
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
    this.link?.close();
    this.link = null;
    this.sig?.close();
  }

  protected newLink(initiator: boolean): PeerLink {
    this.link?.close();
    const link = new PeerLink(this.iceServers, this.sig, initiator);
    this.link = link;
    this.setPhase("connecting-peer");
    link.onfail = (reason) => {
      if (this.link !== link) return;
      this.onLinkFailed(reason);
    };
    return link;
  }

  protected onLinkFailed(reason: string) {
    this.fail(new TransferError(reason === "timeout" ? "connection_failed" : "peer_disconnected", reason));
  }

  /** Wire a data channel to a reader; binary frames go to onBinary. */
  protected attachReader(dc: RTCDataChannel, onBinary: (buf: ArrayBuffer) => void): ChannelReader {
    const rd = new ChannelReader();
    dc.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const m = parsePeerMessage(ev.data);
        if (!m) rd.fail(new TransferError("protocol", "malformed peer message"));
        else if (m.t === "cancel") this.fail(new TransferError("cancelled_by_peer"));
        else rd.push(m);
      } else onBinary(ev.data as ArrayBuffer);
    };
    dc.addEventListener("close", () => rd.fail(new TransferError("peer_disconnected")));
    return rd;
  }

  /** Run one data-channel session, mapping any error to a terminal state. */
  protected async runGuarded(link: PeerLink, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      if (this.link !== link || this.finished) return;
      const err = e instanceof TransferError ? e : new TransferError("protocol", String(e));
      if (err.code === "peer_disconnected") this.onLinkFailed("channel closed");
      else {
        if (err.code === "hash_mismatch" || err.code === "protocol") this.sig.send({ t: "cancel" });
        this.fail(err);
      }
    }
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
  private meta: Promise<FileMeta>;
  /** Exposed for tests: chunks actually put on the wire across all sessions. */
  chunksSent = 0;

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
    try {
      await this.connectSignaling();
      this.sig.send({ t: "create" });
    } catch (e) {
      this.fail(e instanceof TransferError ? e : new TransferError("signaling_failed"));
    }
  }

  protected onServer(m: ServerMessage) {
    switch (m.t) {
      case "created":
        this.code = formatCode(m.nameplate, this.words);
        this.cb.onCode?.(this.code, m.expiresAt);
        this.setPhase("waiting");
        break;
      case "peer_joined": {
        const link = this.newLink(true);
        link.onopen = (dc) => this.runGuarded(link, () => this.session(link, dc));
        link.start().catch(() => this.onLinkFailed("negotiation failed"));
        break;
      }
      case "peer_left":
        if (this.link) this.onLinkFailed("peer left");
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

  private async session(link: PeerLink, dc: RTCDataChannel) {
    const rd = this.attachReader(dc, () => rd.fail(new TransferError("protocol", "unexpected binary")));
    send(dc, { t: "hello", v: PROTOCOL_VERSION });
    const hello = await rd.expect("hello");
    if (hello.v !== PROTOCOL_VERSION) throw new TransferError("protocol", "version mismatch");

    const meta = await this.meta;
    send(dc, { t: "meta", ...meta });
    const total = chunkCount(meta.size);
    const resume = await rd.expect("resume");
    const have = parseRanges(resume.have, total);
    if (!have) throw new TransferError("protocol", "bad resume ranges");

    this.setPhase("transferring");
    await this.stream(link, dc, meta, missingRanges(have, total));
    send(dc, { t: "eof" });
    this.setPhase("verifying");

    const res = await rd.next();
    if (res.t === "ok") {
      this.sig.send({ t: "done" });
      this.cb.onProgress(meta.size, meta.size);
      this.succeed();
    } else if (res.t === "hash_mismatch") throw new TransferError("hash_mismatch");
    else if (res.t === "cancel") throw new TransferError("cancelled_by_peer");
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
      report();
    }
  }
}

export class Receiver extends Transfer {
  private parsed;
  private meta: FileMeta | null = null;
  private chunks: (Uint8Array | undefined)[] = [];
  private received = 0;

  constructor(code: string, cb: Callbacks, opts?: Options) {
    super(cb, opts);
    this.parsed = parseCode(code);
  }

  async start(): Promise<void> {
    if (!this.parsed) return this.fail(new TransferError("bad_code"));
    try {
      await this.connectSignaling();
      this.sig.send({ t: "join", nameplate: this.parsed.nameplate });
    } catch (e) {
      this.fail(e instanceof TransferError ? e : new TransferError("signaling_failed"));
    }
  }

  protected onServer(m: ServerMessage) {
    switch (m.t) {
      case "joined":
        this.setPhase("connecting-peer");
        break;
      case "signal":
        if (m.data.kind === "offer") {
          const link = this.newLink(false);
          link.onopen = (dc) => this.runGuarded(link, () => this.session(link, dc));
        }
        this.link?.handleSignal(m.data);
        break;
      case "closed":
        if (m.reason === "done" && this.phase === "done") return;
        this.onClosed(m.reason);
        break;
      case "error":
        this.serverError(m.code);
        break;
    }
  }

  private async session(_link: PeerLink, dc: RTCDataChannel) {
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
      if (!meta || rangeIdx >= ranges.length) return rd.fail(new TransferError("protocol", "unexpected chunk"));
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
    const rd = this.attachReader(dc, onBinary);

    send(dc, { t: "hello", v: PROTOCOL_VERSION });
    const hello = await rd.expect("hello");
    if (hello.v !== PROTOCOL_VERSION) throw new TransferError("protocol", "version mismatch");

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
    const have = bitmapToRanges((i) => this.chunks[i] !== undefined, total);
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
    const blob = new Blob(this.chunks as BlobPart[], { type: fm.mime });
    this.chunks = [];
    this.cb.onComplete?.({ blob, name: fm.name });
    this.succeed();
  }
}
