import { ApiError } from "./errors.js";

type Bucket = number[];

export class MemoryRateLimiter {
  private readonly hits = new Map<string, Bucket>();
  constructor(
    private readonly windowMs: number,
    private readonly max: number
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const next = (this.hits.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
    if (next.length >= this.max) {
      this.hits.set(key, next);
      return false;
    }
    next.push(now);
    this.hits.set(key, next);
    return true;
  }

  reset(): void {
    this.hits.clear();
  }
}

const enabled = () =>
  process.env.VERITY_RATE_LIMIT === "1" ||
  (process.env.VERITY_RATE_LIMIT !== "0" && process.env.NODE_ENV !== "test" && process.env.VITEST !== "true");

export const limiters = {
  login: new MemoryRateLimiter(15 * 60_000, 20),
  loginFail: new MemoryRateLimiter(15 * 60_000, 8),
  nova: new MemoryRateLimiter(60_000, 30),
  upload: new MemoryRateLimiter(60_000, 10),
  approval: new MemoryRateLimiter(60_000, 20),
  connector: new MemoryRateLimiter(60_000, 10),
  audit: new MemoryRateLimiter(60_000, 20),
};

export function enforceLimit(limiter: MemoryRateLimiter, key: string, message: string): void {
  if (!enabled()) {
    return;
  }
  if (!limiter.allow(key)) {
    throw new ApiError(429, "RATE_LIMITED", message);
  }
}

export function rateLimitEnabled(): boolean {
  return enabled();
}
