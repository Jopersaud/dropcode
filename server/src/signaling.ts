import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { iceServersFor, type ServerConfig } from "./config.ts";
import { log } from "./log.ts";
import { MAX_MESSAGE_BYTES, parseClientMessage, type ServerMessage } from "./protocol.ts";
import { TokenBucket } from "./ratelimit.ts";
import { RoomManager, type Peer, type RoomOptions } from "./rooms.ts";

export interface SignalingOptions {
  rooms?: Partial<RoomOptions>;
  maxConnectionsPerIp?: number;
  /** Messages per second a single connection may send (burst = 4x). */
  messagesPerSec?: number;
  heartbeatMs?: number;
}

export function clientIp(req: IncomingMessage, trustProxy: ServerConfig["trustProxy"]): string {
  if (trustProxy === "fly") {
    const h = req.headers["fly-client-ip"];
    if (typeof h === "string" && h) return h.trim();
  } else if (trustProxy === "xff") {
    const h = req.headers["x-forwarded-for"];
    const first = (Array.isArray(h) ? h[0] : h)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function createSignaling(cfg: ServerConfig, opts: SignalingOptions = {}) {
  const rooms = new RoomManager(opts.rooms);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const perIp = new Map<string, number>();
  const maxPerIp = opts.maxConnectionsPerIp ?? 20;
  const rate = opts.messagesPerSec ?? 50;
  const alive = new WeakMap<WebSocket, boolean>();

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.heartbeatMs ?? 30_000);
  heartbeat.unref();

  function handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) {
    const ip = clientIp(req, cfg.trustProxy);
    if ((perIp.get(ip) ?? 0) >= maxPerIp) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  }

  function onConnection(ws: WebSocket, ip: string) {
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    const bucket = new TokenBucket(rate * 4, rate);
    const peer: Peer = {
      ip,
      send(msg: ServerMessage) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close() {
        // Let queued frames flush before closing.
        setImmediate(() => ws.close(1000));
      },
    };
    const reject = (code: "bad_message" | "rate_limited") => {
      peer.send({ t: "error", code });
      ws.close(1008);
    };

    peer.send({ t: "hello", iceServers: iceServersFor(cfg), ttlMs: rooms.opts.ttlMs });

    ws.on("message", (data, isBinary) => {
      if (!bucket.take()) return reject("rate_limited");
      if (isBinary) return reject("bad_message");
      const msg = parseClientMessage(data.toString());
      if (!msg) return reject("bad_message");

      let res;
      switch (msg.t) {
        case "ping":
          return peer.send({ t: "pong" });
        case "create":
          res = rooms.create(peer);
          if (res.ok) {
            log("room_created", { rooms: rooms.roomCount });
            peer.send({ t: "created", ...res.value });
          }
          break;
        case "reclaim":
          res = rooms.reclaim(peer, msg.nameplate, msg.token);
          if (res.ok) {
            log("room_reclaimed", { receiverPresent: res.value.receiverPresent });
            peer.send({ t: "reclaimed", ...res.value });
          }
          break;
        case "join":
          res = rooms.join(peer, msg.nameplate);
          if (res.ok) peer.send({ t: "joined" });
          else log("join_failed", { reason: res.code });
          break;
        case "signal":
          res = rooms.relay(peer, msg.data);
          break;
        case "done":
          res = rooms.done(peer);
          if (res.ok) log("transfer_done", { rooms: rooms.roomCount });
          break;
        case "cancel":
          res = rooms.cancel(peer);
          break;
        case "authed":
          res = rooms.authed(peer);
          break;
        case "auth_failed":
          res = rooms.authFailed(peer);
          if (res.ok) log("auth_failed", { rooms: rooms.roomCount });
          break;
        default:
          res = { ok: false as const, code: "bad_state" as const };
      }
      if (!res.ok) peer.send({ t: "error", code: res.code });
    });

    ws.on("close", () => {
      rooms.disconnect(peer);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });
    ws.on("error", () => ws.terminate());
  }

  function close() {
    clearInterval(heartbeat);
    rooms.shutdown();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  return { wss, rooms, handleUpgrade, close };
}
