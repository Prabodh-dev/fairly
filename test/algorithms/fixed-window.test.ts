import { FixedWindow } from '../../src/algorithms/fixed-window.js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { RedisStore } from '../../src/store/redis.js';
import { connectStore, ManualClock, uniqueKey } from '../helpers.js';

describe('fixed-window', () => {
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
    const algorithm = new FixedWindow({ store, clock });
    const key = uniqueKey('fw');
    for (let i = 1; i <= 5; i++) {
      const result = await algorithm.check(key, 5, 60);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5 - i);
      expect(result.resetAtMs).toBe(start + 60_000);
    }
    const rejected = await algorithm.check(key, 5, 60);
    expect(rejected).toEqual({ allowed: false, remaining: 0, resetAtMs: start + 60_000, retryAfterMs: 59_000 });
  });

  it('allows again at the window boundary and not before', async () => {
    const clock = new ManualClock(start + 1000);
    const algorithm = new FixedWindow({ store, clock });
    const key = uniqueKey('fw');
    for (let i = 0; i < 3; i++) await algorithm.check(key, 3, 60);
    clock.set(start + 59_999);
    expect((await algorithm.check(key, 3, 60)).allowed).toBe(false);
    clock.set(start + 60_000);
    const result = await algorithm.check(key, 3, 60);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it('permits up to twice the limit across a window boundary', async () => {
    const clock = new ManualClock(start + 59_000);
    const algorithm = new FixedWindow({ store, clock });
    const key = uniqueKey('fw');
    let allowed = 0;
    for (let i = 0; i < 10; i++) if ((await algorithm.check(key, 5, 60)).allowed) allowed++;
    clock.set(start + 60_000);
    for (let i = 0; i < 10; i++) if ((await algorithm.check(key, 5, 60)).allowed) allowed++;
    expect(allowed).toBe(10);
  });

  it('keeps keys independent', async () => {
    const clock = new ManualClock(start);
    const algorithm = new FixedWindow({ store, clock });
    const a = uniqueKey('fw');
    const b = uniqueKey('fw');
    await algorithm.check(a, 1, 60);
    expect((await algorithm.check(a, 1, 60)).allowed).toBe(false);
    expect((await algorithm.check(b, 1, 60)).allowed).toBe(true);
  });

  it('uses Redis server time when no clock is injected', async () => {
    const algorithm = new FixedWindow({ store });
    const key = uniqueKey('fw');
    const before = Date.now();
    const result = await algorithm.check(key, 2, 3600);
    expect(result.allowed).toBe(true);
    expect(result.resetAtMs).toBeGreaterThan(before);
    expect(result.resetAtMs - before).toBeLessThanOrEqual(3_600_000 + 5000);
  });

  it('stays within the limit when the clock moves backwards into an earlier window', async () => {
    const clock = new ManualClock(start + 1000);
    const algorithm = new FixedWindow({ store, clock });
    const key = uniqueKey('fw');
    for (let i = 0; i < 3; i++) await algorithm.check(key, 3, 60);
    clock.set(start + 1000 - 5000);
    const fresh = await algorithm.check(key, 3, 60);
    expect(fresh.allowed).toBe(true);
    clock.set(start + 1000);
    expect((await algorithm.check(key, 3, 60)).allowed).toBe(false);
  });
});
