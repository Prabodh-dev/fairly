import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ALGORITHM_NAMES, MAX_LIMIT, MAX_WINDOW_SECONDS, type AlgorithmName } from '../../src/config/types.js';
import type { RedisStore } from '../../src/store/redis.js';
import { createAlgorithms } from '../../src/algorithms/index.js';
import { connectStore, uniqueKey } from '../helpers.js';

const cases = [
  { name: 'largest limit', limit: MAX_LIMIT, windowSeconds: 9007 },
  { name: 'longest window', limit: 1, windowSeconds: MAX_WINDOW_SECONDS },
  { name: 'largest product', limit: 1_000_000, windowSeconds: 9_007_199 },
  { name: 'smallest values', limit: 1, windowSeconds: 1 },
];

describe.each(ALGORITHM_NAMES)('%s at the edges of the accepted range', (name: AlgorithmName) => {
  let store: RedisStore;
  beforeAll(async () => {
    store = await connectStore(inject('redisUrl'));
  });
  afterAll(async () => {
    await store.close();
  });

  it.each(cases)('counts exactly and reports sane times with $name', async ({ limit, windowSeconds }) => {
    const algorithm = createAlgorithms({ store })[name];
    const key = uniqueKey('extreme');
    const before = Date.now();

    const first = await algorithm.check(key, limit, windowSeconds);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(limit - 1);
    expect(Number.isSafeInteger(first.resetAtMs)).toBe(true);
    expect(first.resetAtMs).toBeGreaterThan(before - 1);
    expect(first.resetAtMs).toBeLessThanOrEqual(before + windowSeconds * 1000 * 2 + 5000);

    const second = await algorithm.check(key, limit, windowSeconds);
    if (limit === 1) {
      expect(second.allowed).toBe(false);
      expect(second.remaining).toBe(0);
      expect(second.retryAfterMs).toBeGreaterThan(0);
      expect(second.retryAfterMs).toBeLessThanOrEqual(windowSeconds * 1000 + 5000);
      expect(Number.isSafeInteger(second.resetAtMs)).toBe(true);
    } else if (name === 'token-bucket') {
      expect(second.allowed).toBe(true);
      expect(second.remaining).toBeGreaterThanOrEqual(limit - 2);
      expect(second.remaining).toBeLessThanOrEqual(limit - 1);
    } else {
      expect(second.allowed).toBe(true);
      expect(second.remaining).toBe(limit - 2);
    }
  });
});
