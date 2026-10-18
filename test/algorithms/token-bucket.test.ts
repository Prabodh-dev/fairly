import { TokenBucket } from '../../src/algorithms/token-bucket.js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { RedisStore } from '../../src/store/redis.js';
import { connectStore, ManualClock, uniqueKey } from '../helpers.js';

describe('token-bucket', () => {
  let store: RedisStore;
  beforeAll(async () => {
    store = await connectStore(inject('redisUrl'));
  });
  afterAll(async () => {
    await store.close();
  });

  const start = 1_700_000_000_000;

  it('allows a burst up to capacity, then rejects, and decrements remaining', async () => {
    const clock = new ManualClock(start);
    const algorithm = new TokenBucket({ store, clock });
    const key = uniqueKey('tb');
    for (let i = 1; i <= 10; i++) {
      const result = await algorithm.check(key, 10, 60);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(10 - i);
    }
    const rejected = await algorithm.check(key, 10, 60);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    expect(rejected.retryAfterMs).toBe(6000);
    expect(rejected.resetAtMs).toBe(start + 6000);
  });

  it('refills one token per window/limit and not before', async () => {
    const clock = new ManualClock(start);
    const algorithm = new TokenBucket({ store, clock });
    const key = uniqueKey('tb');
    for (let i = 0; i < 10; i++) await algorithm.check(key, 10, 60);

    clock.set(start + 5999);
    expect((await algorithm.check(key, 10, 60)).allowed).toBe(false);
    clock.set(start + 6000);
    expect((await algorithm.check(key, 10, 60)).allowed).toBe(true);
    expect((await algorithm.check(key, 10, 60)).allowed).toBe(false);
  });

  it('sustains the configured steady-state rate over a measured period', async () => {
    const clock = new ManualClock(start);
    const algorithm = new TokenBucket({ store, clock });
    const key = uniqueKey('tb');
    for (let i = 0; i < 10; i++) await algorithm.check(key, 10, 10);

    let allowed = 0;
    const periodMs = 100_000;
    for (let elapsed = 100; elapsed <= periodMs; elapsed += 100) {
      clock.set(start + elapsed);
      for (let attempt = 0; attempt < 3; attempt++) {
        if ((await algorithm.check(key, 10, 10)).allowed) allowed++;
      }
    }
    // 10 tokens per 10 seconds = 1 per second, so 100 seconds yields exactly 100 tokens
    expect(allowed).toBe(100);
  });

  it('caps the refill at capacity', async () => {
    const clock = new ManualClock(start);
    const algorithm = new TokenBucket({ store, clock });
    const key = uniqueKey('tb');
    for (let i = 0; i < 5; i++) await algorithm.check(key, 5, 60);
    clock.set(start + 10 * 60_000);
    let allowed = 0;
    for (let i = 0; i < 10; i++) if ((await algorithm.check(key, 5, 60)).allowed) allowed++;
    expect(allowed).toBe(5);
  });

  it('does not credit tokens when the clock moves backwards', async () => {
    const clock = new ManualClock(start);
    const algorithm = new TokenBucket({ store, clock });
    const key = uniqueKey('tb');
    for (let i = 0; i < 3; i++) await algorithm.check(key, 3, 60);
    clock.set(start - 30_000);
    expect((await algorithm.check(key, 3, 60)).allowed).toBe(false);
  });

  it('refills from Redis server time when no clock is injected', async () => {
    const algorithm = new TokenBucket({ store });
    const key = uniqueKey('tb');
    expect((await algorithm.check(key, 1, 1)).allowed).toBe(true);
    expect((await algorithm.check(key, 1, 1)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await algorithm.check(key, 1, 1)).allowed).toBe(true);
  });
});
