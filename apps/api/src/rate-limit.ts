import type { NextFunction, Request, Response } from 'express';
import { envInt, getPool, logSystemEvent } from '@pulse/core';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * In-memory token bucket per authenticated user (falling back to IP).
 * Refills continuously at `limit` tokens per minute. Suitable for a single
 * API node; the scaling path (shared store / API-gateway limiter) is
 * documented in DESIGN-DECISIONS.md.
 */
export function rateLimiter() {
  const limit = envInt('RATE_LIMIT_PER_MINUTE', 300);
  const buckets = new Map<string, Bucket>();

  // Hourly sweep so idle keys do not accumulate forever.
  setInterval(() => {
    const cutoff = Date.now() - 3_600_000;
    for (const [key, bucket] of buckets) {
      if (bucket.lastRefill < cutoff) buckets.delete(key);
    }
  }, 3_600_000).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers.authorization;
    const key = auth ? `t:${auth.slice(-24)}` : `ip:${req.ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: limit, lastRefill: now };
      buckets.set(key, bucket);
    }
    // Continuous refill proportional to elapsed time.
    bucket.tokens = Math.min(limit, bucket.tokens + ((now - bucket.lastRefill) / 60_000) * limit);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      res.setHeader('Retry-After', '10');
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' } });
      void logSystemEvent(getPool(), {
        level: 'warn',
        component: 'api.rate-limit',
        message: `Rate limit exceeded for ${key.startsWith('t:') ? 'an authenticated client' : `IP ${req.ip}`} on ${req.method} ${req.path}`,
        context: { path: req.path, method: req.method },
      });
      return;
    }
    bucket.tokens -= 1;
    next();
  };
}
