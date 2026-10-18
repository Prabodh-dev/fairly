import { SlidingWindowCounter } from '../../src/algorithms/sliding-window-counter.js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { RedisStore } from '../../src/store/redis.js';
import { connectStore, ManualClock, uniqueKey } from '../helpers.js';

describe('sliding-window-counter', () => {
  let store: RedisStore;
  beforeAll(async () => {
    store = await connectStore(inject('redisUrl'));
  });
  afterAll(async () => {
    await store.close();
  });

  const start = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);

  it('allows up to the limit, rejects the next, and decrements remaining', async () => {
    const clock = new ManualClock(start + 1000);
    const algorithm = new SlidingWindowCounter({ store, clock });
    const key = uniqueKey('swc');
    for (let i = 1; i <= 5; i++) {
      const result = await algorithm.check(key, 5, 60);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5 - i);
    }
    const rejected = await algorithm.check(key, 5, 60);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
  });

  it('weights the previous window by the remaining overlap', async () => {
    const clock = new ManualClock(start + 1000);
    const algorithm = new SlidingWindowCounter({ store, clock });
    const key = uniqueKey('swc');
    for (let i = 0; i < 10; i++) await algorithm.check(key, 10, 60);

    clock.set(start + 60_000 + 30_000);
    // weighted previous = floor(10 * 30000 / 60000) = 5, so 5 more are allowed
    for (let i = 1; i <= 5; i++) {
      const result = await algorithm.check(key, 10, 60);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5 - i);
    }
    expect((await algorithm.check(key, 10, 60)).allowed).toBe(false);
  });

  it('reports a retry time that is exact when only the previous window is blocking', async () => {
    const clock = new ManualClock(start + 1000);
    const algorithm = new SlidingWindowCounter({ store, clock });
    const key = uniqueKey('swc');
    for (let i = 0; i < 10; i++) await algorithm.check(key, 10, 60);

    clock.set(start + 60_000 + 10_000);
    // weighted previous = floor(10 * 50000 / 60000) = 8, so two more are allowed
    expect((await algorithm.check(key, 10, 60)).allowed).toBe(true);
    expect((await algorithm.check(key, 10, 60)).allowed).toBe(true);
    const rejected = await algorithm.check(key, 10, 60);
    expect(rejected.allowed).toBe(false);
    expect(rejected.resetAtMs).toBe(start + 60_000 + 12_001);
    expect(rejected.retryAfterMs).toBe(rejected.resetAtMs - clock.nowMs());

    clock.set(rejected.resetAtMs - 1);
    expect((await algorithm.check(key, 10, 60)).allowed).toBe(false);
    clock.set(rejected.resetAtMs);
    expect((await algorithm.check(key, 10, 60)).allowed).toBe(true);
  });

  it('reports a retry time past the next boundary when the current window is exhausted', async () => {
    const clock = new ManualClock(start + 1000);
    const algorithm = new SlidingWindowCounter({ store, clock });
    const key = uniqueKey('swc');
    for (let i = 0; i < 4; i++) await algorithm.check(key, 4, 60);

    const rejected = await algorithm.check(key, 4, 60);
    expect(rejected.allowed).toBe(false);
    expect(rejected.resetAtMs).toBeGreaterThan(start + 60_000);

    clock.set(rejected.resetAtMs - 1);
    expect((await algorithm.check(key, 4, 60)).allowed).toBe(false);
    clock.set(rejected.resetAtMs);
    expect((await algorithm.check(key, 4, 60)).allowed).toBe(true);
  });

  it('allows the full limit again once two windows have passed', async () => {
    const clock = new ManualClock(start + 1000);
    const algorithm = new SlidingWindowCounter({ store, clock });
    const key = uniqueKey('swc');
    for (let i = 0; i < 5; i++) await algorithm.check(key, 5, 60);
    clock.set(start + 2 * 60_000);
    let allowed = 0;
    for (let i = 0; i < 8; i++) if ((await algorithm.check(key, 5, 60)).allowed) allowed++;
    expect(allowed).toBe(5);
  });

  it('keeps rejecting when the clock jumps backwards within the same window', async () => {
    const clock = new ManualClock(start + 30_000);
    const algorithm = new SlidingWindowCounter({ store, clock });
    const key = uniqueKey('swc');
    for (let i = 0; i < 4; i++) await algorithm.check(key, 4, 60);
    clock.set(start + 5_000);
    expect((await algorithm.check(key, 4, 60)).allowed).toBe(false);
    clock.set(start + 30_000);
    expect((await algorithm.check(key, 4, 60)).allowed).toBe(false);
  });
});
