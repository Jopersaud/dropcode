/** Rolling-window transfer rate estimate, for speed and ETA display. */
export class RateMeter {
  private samples: { t: number; bytes: number }[] = [];

  constructor(
    private readonly windowMs = 3000,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Record the cumulative byte count. */
  update(bytes: number): void {
    const t = this.now();
    this.samples.push({ t, bytes });
    while (this.samples.length > 2 && t - this.samples[0]!.t > this.windowMs) this.samples.shift();
  }

  /** Bytes per second over the window, or 0 if unknown. */
  get rate(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.t - first.t < 250) return 0;
    return Math.max(0, ((last.bytes - first.bytes) * 1000) / (last.t - first.t));
  }

  /** Seconds remaining, or null if the rate is unknown. */
  eta(total: number): number | null {
    const last = this.samples[this.samples.length - 1];
    const r = this.rate;
    if (!last || r <= 0) return null;
    return Math.max(0, (total - last.bytes) / r);
  }

  reset(): void {
    this.samples = [];
  }
}

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(n: number): string {
  let i = 0;
  while (n >= 1000 && i < UNITS.length - 1) {
    n /= 1000;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${UNITS[i]}`;
}

export function formatDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "–";
  sec = Math.ceil(sec);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${String(sec % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function percent(done: number, total: number): number {
  if (total <= 0) return 100;
  return Math.min(100, Math.floor((done / total) * 1000) / 10);
}
