import { SlidingWindowLog } from '../../src/algorithms/sliding-window-log.js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { LuaScript, type RedisStore } from '../../src/store/redis.js';
import { connectStore, ManualClock, uniqueKey } from '../helpers.js';

describe('sliding-window-log', () => {
  let store: RedisStore;
  beforeAll(async () => {
    store = await connectStore(inject('redisUrl'));
  });
  afterAll(async () => {
    await store.close();
  });

  const start = 1_700_000_000_000;

  it('allows up to the limit, rejects the next, and decrements remaining', async () => {
    const clock = new ManualClock(start);
    const algorithm = new SlidingWindowLog({ store, clock });
    const key = uniqueKey('swl');
    for (let i = 1; i <= 5; i++) {
      const result = await algorithm.check(key, 5, 60);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5 - i);
    }
    const rejected = await algorithm.check(key, 5, 60);
    expect(rejected).toEqual({ allowed: false, remaining: 0, resetAtMs: start + 60_000, retryAfterMs: 60_000 });
  });

  it('counts requests with identical timestamps separately', async () => {
    const clock = new ManualClock(start);
    const algorithm = new SlidingWindowLog({ store, clock });
    const key = uniqueKey('swl');
    const results = await Promise.all(Array.from({ length: 10 }, () => algorithm.check(key, 4, 60)));
    expect(results.filter((r) => r.allowed)).toHaveLength(4);
  });

  it('frees one slot per expiring entry, exactly at the reported reset time', async () => {
    const clock = new ManualClock(start);
    const algorithm = new SlidingWindowLog({ store, clock });
    const key = uniqueKey('swl');
    await algorithm.check(key, 2, 60);
    clock.advance(10_000);
    await algorithm.check(key, 2, 60);
    clock.advance(10_000);
    const rejected = await algorithm.check(key, 2, 60);
    expect(rejected.allowed).toBe(false);
    expect(rejected.resetAtMs).toBe(start + 60_000);

    clock.set(start + 59_999);
    expect((await algorithm.check(key, 2, 60)).allowed).toBe(false);
    clock.set(start + 60_000);
    expect((await algorithm.check(key, 2, 60)).allowed).toBe(true);
    expect((await algorithm.check(key, 2, 60)).allowed).toBe(false);
    clock.set(start + 70_000);
    expect((await algorithm.check(key, 2, 60)).allowed).toBe(true);
  });

  it('does not allow a burst across a window boundary', async () => {
    const clock = new ManualClock(start + 59_000);
    const algorithm = new SlidingWindowLog({ store, clock });
    const key = uniqueKey('swl');
    let allowed = 0;
    for (let i = 0; i < 10; i++) if ((await algorithm.check(key, 5, 60)).allowed) allowed++;
    clock.set(start + 61_000);
    for (let i = 0; i < 10; i++) if ((await algorithm.check(key, 5, 60)).allowed) allowed++;
    expect(allowed).toBe(5);
  });

  it('expires the key after the window', async () => {
    const algorithm = new SlidingWindowLog({ store });
    const key = uniqueKey('swl');
    await algorithm.check(key, 2, 5);
    const ttl = await store.execute(
      new LuaScript("return redis.call('PTTL', KEYS[1])"),
      [`fairly:{${key}}:swl`],
      [],
    );
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5000);
  });

  it('keeps enforcing the limit when the clock jumps backwards', async () => {
    const clock = new ManualClock(start);
    const algorithm = new SlidingWindowLog({ store, clock });
    const key = uniqueKey('swl');
    for (let i = 0; i < 3; i++) await algorithm.check(key, 3, 60);
    clock.set(start - 30_000);
    expect((await algorithm.check(key, 3, 60)).allowed).toBe(false);
    clock.set(start + 60_000);
    expect((await algorithm.check(key, 3, 60)).allowed).toBe(true);
  });
});
