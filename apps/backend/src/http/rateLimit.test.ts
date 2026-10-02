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

describe('RateLimiter idle key sweep', () => {
  function fill(limiter: RateLimiter, count: number): void {
    for (let i = 0; i < count; i++) limiter.allow(`ip-${i}`);
  }
  const keys = (limiter: RateLimiter): number =>
    (limiter as unknown as { hits: Map<string, number[]> }).hits.size;

  it('drops idle keys once the map is over 10,000 keys', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 5, windowMs: 1000, now: () => now });
    fill(limiter, 10_001);
    expect(keys(limiter)).toBe(10_001);
    now = 5000; // every key is idle
    limiter.allow('fresh');
    expect(keys(limiter)).toBe(1);
  });

  it('sweeps at most once per window', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 5, windowMs: 1000, now: () => now });
    fill(limiter, 10_001);
    now = 5000;
    limiter.allow('first'); // sweeps everything idle
    expect(keys(limiter)).toBe(1);
    // Refill past the threshold; the keys are idle again 1000 ms later, but the last sweep was
    // less than a window ago, so the next call does not scan the map.
    fill(limiter, 10_001);
    now = 5500;
    limiter.allow('second');
    expect(keys(limiter)).toBeGreaterThan(10_000);
    now = 6001; // the keys from 5000 are idle and a window passed since the last sweep
    limiter.allow('third');
    expect(keys(limiter)).toBe(2); // 'second' (5500) is still inside its window, plus 'third'
  });
});
