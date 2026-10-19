import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { createAppServer } from "../src/http.ts";
import type { SignalingOptions } from "../src/signaling.ts";

process.env.DROPCODE_QUIET = "1";

export async function startServer(opts: SignalingOptions = {}) {
  const cfg = loadConfig({ TRUST_PROXY: "xff", STUN_URLS: "" }, "/nonexistent");
  const app = createAppServer(cfg, opts);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const port = (app.server.address() as AddressInfo).port;
  return { app, url: `ws://127.0.0.1:${port}/ws`, httpUrl: `http://127.0.0.1:${port}` };
}

/** Test client that records every server message and lets tests await them in order. */
export class Client {
  ws: WebSocket;
  private queue: any[] = [];
  private waiters: ((m: any) => void)[] = [];
  closed: Promise<number>;

  constructor(url: string, ip = "10.0.0.1") {
    this.ws = new WebSocket(url, { headers: { "x-forwarded-for": ip } });
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      const w = this.waiters.shift();
      if (w) w(m);
      else this.queue.push(m);
    });
    this.ws.on("error", () => {});
    this.closed = new Promise((r) => this.ws.on("close", (code) => r(code)));
  }

  static async connect(url: string, ip?: string): Promise<Client> {
    const c = new Client(url, ip);
    const hello = await c.next();
    if (hello.t !== "hello") throw new Error("expected hello");
    return c;
  }

  send(m: unknown) {
    this.ws.send(typeof m === "string" ? m : JSON.stringify(m));
  }

  next(timeoutMs = 2000): Promise<any> {
    const m = this.queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }

  /** Resolves true if no message arrives within `ms`. */
  async silent(ms = 100): Promise<boolean> {
    try {
      await this.next(ms);
      return false;
    } catch {
      return true;
    }
  }

  close() {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
