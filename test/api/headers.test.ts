import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ALGORITHM_NAMES, type AlgorithmName, type Policy } from '../../src/config/types.js';
import { ManualClock, uniqueKey } from '../helpers.js';
import { post, postCheck, startServer, type CheckResponse, type RunningServer } from '../server.js';

const LIMIT = 3;
const WINDOW = 3600;
const start = 1_700_000_000_000 - (1_700_000_000_000 % (WINDOW * 1000)) + 1000;

const policies: Policy[] = [
  ...ALGORITHM_NAMES.map((algorithm): Policy => ({ name: algorithm, route: algorithm, algorithm, limit: LIMIT, windowSeconds: WINDOW })),
  { name: 'premium', route: '*', tier: 'premium', algorithm: 'fixed-window', limit: 500, windowSeconds: WINDOW },
];

function expectHeaders(response: CheckResponse, limit: number): void {
  const headers = response.headers;
  expect(headers.get('x-ratelimit-limit')).toBe(String(limit));
  expect(headers.get('x-ratelimit-remaining')).toBe(String(response.body.remaining));
  expect(headers.get('x-ratelimit-reset')).toBe(String(Math.ceil(response.body.resetAtMs / 1000)));
  expect(Number.isInteger(Number(headers.get('x-ratelimit-reset')))).toBe(true);
}

describe('rate limit header contract', () => {
  let server: RunningServer;
  let clock: ManualClock;
  beforeAll(async () => {
    clock = new ManualClock(start);
    server = await startServer({ redisUrl: inject('redisUrl'), policies, clock });
  });
  afterAll(async () => {
    await server.close();
  });

  describe.each(ALGORITHM_NAMES)('%s', (name: AlgorithmName) => {
    it('sets Limit, Remaining and Reset on allowed responses and no Retry-After', async () => {
      const key = uniqueKey('user');
      for (let i = 1; i <= LIMIT; i++) {
        const response = await postCheck(server.url, name, key);
        expect(response.status).toBe(200);
        expect(response.body.remaining).toBe(LIMIT - i);
        expectHeaders(response, LIMIT);
        expect(response.headers.get('retry-after')).toBeNull();
        expect(response.body.resetAtMs).toBeGreaterThan(start);
      }
    });

    it('returns 429 with Limit, Remaining 0, Reset and an exact Retry-After on denied responses', async () => {
      const key = uniqueKey('user');
      for (let i = 0; i < LIMIT; i++) await postCheck(server.url, name, key);
      const denied = await postCheck(server.url, name, key);
      expect(denied.status).toBe(429);
      expect(denied.body.allowed).toBe(false);
      expect(denied.body.remaining).toBe(0);
      expectHeaders(denied, LIMIT);
      expect(denied.headers.get('x-ratelimit-remaining')).toBe('0');
      const retryAfter = Number(denied.headers.get('retry-after'));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBe(Math.max(1, Math.ceil((denied.body.resetAtMs - start) / 1000)));
    });
  });

  it('reports the limit of the policy that was resolved, including a tier policy', async () => {
    const free = await post(server.url, { key: uniqueKey('user'), route: '/anything' });
    expect(free.status).toBe(404);

    const premium = await post(server.url, { key: uniqueKey('user'), route: '/anything', tier: 'premium' });
    expect(premium.status).toBe(200);
    expectHeaders(premium, 500);
    expect(premium.body.remaining).toBe(499);
  });

  it('sets the same headers for an inline limit', async () => {
    const inline = { key: uniqueKey('user'), algorithm: 'fixed-window', limit: 1, windowSeconds: WINDOW };
    const allowed = await post(server.url, inline);
    expectHeaders(allowed, 1);
    const denied = await post(server.url, inline);
    expect(denied.status).toBe(429);
    expectHeaders(denied, 1);
    expect(denied.headers.get('retry-after')).not.toBeNull();
  });

  it('omits rate limit headers on invalid and unmatched requests', async () => {
    const response = await post(server.url, { key: 'k' });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-ratelimit-limit')).toBeNull();
  });
});
