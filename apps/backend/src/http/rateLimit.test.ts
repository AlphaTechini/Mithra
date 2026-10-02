import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rateLimit';

describe('RateLimiter', () => {
  it('allows the limit within the window and refuses the next attempt', () => {
    const now = 0;
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect([1, 2, 3].map(() => limiter.allow('ip'))).toEqual([true, true, true]);
    expect(limiter.allow('ip')).toBe(false);
    expect(limiter.allow('other')).toBe(true);
  });

  it('lets attempts through again as the window slides', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: () => now });
    limiter.allow('ip');
    now = 500;
    limiter.allow('ip');
    expect(limiter.allow('ip')).toBe(false);
    now = 1001; // the first attempt left the window
    expect(limiter.allow('ip')).toBe(true);
    expect(limiter.allow('ip')).toBe(false);
  });
});
