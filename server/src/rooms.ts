import { randomBytes, randomInt } from "node:crypto";
import type { CloseReason, ErrorCode, ServerMessage, SignalData } from "./protocol.ts";
import { SlidingWindowLimiter } from "./ratelimit.ts";

/** Transport-agnostic handle for one connected client. */
export interface Peer {
  readonly ip: string;
  send(msg: ServerMessage): void;
  /** Close the underlying connection (after any queued sends). */
  close(): void;
}

export interface RoomOptions {
  /** How long a room waits for a receiver before it expires. */
  ttlMs: number;
  /** Hard cap on a room's life, even while a transfer is running. */
  maxLifetimeMs: number;
  /** How long a dead nameplate is remembered (and not reused). */
  tombstoneMs: number;
  failedJoinLimit: number;
  failedJoinWindowMs: number;
  maxRooms: number;
  maxRoomsPerIp: number;
}

export const DEFAULT_ROOM_OPTIONS: RoomOptions = {
  ttlMs: 10 * 60_000,
  maxLifetimeMs: 12 * 60 * 60_000,
  tombstoneMs: 30 * 60_000,
  failedJoinLimit: 5,
  failedJoinWindowMs: 60_000,
  maxRooms: 10_000,
  maxRoomsPerIp: 10,
};

type Role = "sender" | "receiver";
type TombstoneReason = "expired" | "used" | "burned";

interface Room {
  nameplate: string;
  token: string;
  sender: Peer | null;
  receiver: Peer | null;
  senderIp: string;
  createdAt: number;
  idleTimer: NodeJS.Timeout | null;
  lifetimeTimer: NodeJS.Timeout;
}

export type Result<T = void> = { ok: true; value: T } | { ok: false; code: ErrorCode };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: ErrorCode): Result<never> => ({ ok: false, code });

/**
 * All room state lives here, in memory. A room is keyed by a short numeric
 * nameplate; the secret words of the code never reach the server.
 */
export class RoomManager {
  readonly opts: RoomOptions;
  private rooms = new Map<string, Room>();
  private tombstones = new Map<string, { reason: TombstoneReason; until: number }>();
  private membership = new Map<Peer, { room: Room; role: Role }>();
  readonly failedJoins: SlidingWindowLimiter;
  private pruneTimer: NodeJS.Timeout;

  constructor(opts: Partial<RoomOptions> = {}) {
    this.opts = { ...DEFAULT_ROOM_OPTIONS, ...opts };
    this.failedJoins = new SlidingWindowLimiter(this.opts.failedJoinLimit, this.opts.failedJoinWindowMs);
    this.pruneTimer = setInterval(() => this.prune(), 30_000);
    this.pruneTimer.unref?.();
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  hasRoom(nameplate: string): boolean {
    return this.rooms.has(nameplate);
  }

  roleOf(peer: Peer): Role | null {
    return this.membership.get(peer)?.role ?? null;
  }

  create(peer: Peer): Result<{ nameplate: string; token: string; expiresAt: number }> {
    if (this.membership.has(peer)) return fail("bad_state");
    if (this.rooms.size >= this.opts.maxRooms) return fail("server_full");
    let perIp = 0;
    for (const r of this.rooms.values()) if (r.senderIp === peer.ip) perIp++;
    if (perIp >= this.opts.maxRoomsPerIp) return fail("too_many_rooms");

    const nameplate = this.allocateNameplate();
    if (!nameplate) return fail("server_full");
    const room: Room = {
      nameplate,
      token: randomBytes(18).toString("base64url"),
      sender: peer,
      receiver: null,
      senderIp: peer.ip,
      createdAt: Date.now(),
      idleTimer: null,
      lifetimeTimer: setTimeout(() => this.expire(room), this.opts.maxLifetimeMs),
    };
    room.lifetimeTimer.unref?.();
    this.rooms.set(nameplate, room);
    this.membership.set(peer, { room, role: "sender" });
    const expiresAt = this.armIdle(room);
    return ok({ nameplate, token: room.token, expiresAt });
  }

  join(peer: Peer, nameplate: string): Result {
    if (this.membership.has(peer)) return fail("bad_state");
    if (this.failedJoins.isLimited(peer.ip)) return fail("rate_limited");

    const room = this.rooms.get(nameplate);
    let code: ErrorCode | null = null;
    if (!room) code = this.tombstones.get(nameplate)?.reason ?? "not_found";
    else if (room.receiver || !room.sender) code = "room_full";
    if (code) {
      this.failedJoins.record(peer.ip);
      return fail(code);
    }

    room!.receiver = peer;
    this.membership.set(peer, { room: room!, role: "receiver" });
    this.disarmIdle(room!);
    room!.sender!.send({ t: "peer_joined" });
    return ok(undefined);
  }

  relay(peer: Peer, data: SignalData): Result {
    const m = this.membership.get(peer);
    if (!m) return fail("bad_state");
    const other = m.role === "sender" ? m.room.receiver : m.room.sender;
    if (!other) return fail("bad_state");
    other.send({ t: "signal", data });
    return ok(undefined);
  }

  /** Either side reports a completed transfer: the code is now spent. */
  done(peer: Peer): Result {
    const m = this.membership.get(peer);
    if (!m) return fail("bad_state");
    this.destroy(m.room, "done", "used");
    return ok(undefined);
  }

  cancel(peer: Peer): Result {
    const m = this.membership.get(peer);
    if (!m) return fail("bad_state");
    this.destroy(m.room, "cancelled", "used");
    return ok(undefined);
  }

  /** Connection closed without an explicit done/cancel. */
  disconnect(peer: Peer): void {
    const m = this.membership.get(peer);
    if (!m) return;
    this.membership.delete(peer);
    const { room, role } = m;
    if (role === "receiver") {
      if (room.receiver !== peer) return;
      room.receiver = null;
      room.sender?.send({ t: "peer_left" });
      this.armIdle(room);
    } else {
      room.sender = null;
      this.destroy(room, "sender_left", "expired");
    }
  }

  /** Stop all timers; used by tests and graceful shutdown. */
  shutdown(): void {
    clearInterval(this.pruneTimer);
    for (const room of [...this.rooms.values()]) this.destroy(room, "expired", "expired");
  }

  private armIdle(room: Room): number {
    this.disarmIdle(room);
    room.idleTimer = setTimeout(() => this.expire(room), this.opts.ttlMs);
    room.idleTimer.unref?.();
    return Date.now() + this.opts.ttlMs;
  }

  private disarmIdle(room: Room): void {
    if (room.idleTimer) clearTimeout(room.idleTimer);
    room.idleTimer = null;
  }

  private expire(room: Room): void {
    if (this.rooms.get(room.nameplate) !== room) return;
    this.destroy(room, "expired", "expired");
  }

  private destroy(room: Room, reason: CloseReason, tomb: TombstoneReason): void {
    if (this.rooms.get(room.nameplate) !== room) return;
    this.rooms.delete(room.nameplate);
    this.disarmIdle(room);
    clearTimeout(room.lifetimeTimer);
    this.tombstones.set(room.nameplate, { reason: tomb, until: Date.now() + this.opts.tombstoneMs });
    for (const p of [room.sender, room.receiver]) {
      if (!p) continue;
      this.membership.delete(p);
      p.send({ t: "closed", reason });
      p.close();
    }
  }

  private allocateNameplate(): string | null {
    // Prefer short nameplates, picked at random within a tier so they are not
    // predictable. Nameplates that recently died are not reused.
    this.pruneTombstones();
    for (let digits = 1; digits <= 6; digits++) {
      const lo = digits === 1 ? 1 : 10 ** (digits - 1);
      const hi = 10 ** digits;
      for (let i = 0; i < 32; i++) {
        const n = String(randomInt(lo, hi));
        if (!this.rooms.has(n) && !this.tombstones.has(n)) return n;
      }
    }
    return null;
  }

  private pruneTombstones(): void {
    const now = Date.now();
    for (const [k, v] of this.tombstones) if (v.until <= now) this.tombstones.delete(k);
  }

  private prune(): void {
    this.pruneTombstones();
    this.failedJoins.prune();
  }
}
