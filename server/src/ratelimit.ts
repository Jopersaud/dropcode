// Sliding-window event counter keyed by client IP. Only timestamps of
// recent events are stored; keys with no recent events are pruned.

export class SlidingWindowLimiter {
  private events = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.events.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.events.set(key, list);
    else this.events.delete(key);
    return list;
  }

  /** True once `limit` events have been recorded inside the window. */
  isLimited(key: string): boolean {
    return this.recent(key).length >= this.limit;
  }

  record(key: string): void {
    const list = this.recent(key);
    list.push(this.now());
    this.events.set(key, list);
  }

  /** Drop stale keys; call periodically so memory stays bounded. */
  prune(): void {
    for (const key of [...this.events.keys()]) this.recent(key);
  }

  get size(): number {
    return this.events.size;
  }
}

/** Token bucket used to cap per-connection message rate. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
