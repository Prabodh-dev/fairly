import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { uniqueKey } from '../helpers.js';
import { post, startServer, type RunningServer } from '../server.js';

const TOKEN = 'test-admin-token-0123456789';

describe('out-of-range limits are refused at the API instead of reaching Redis', () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await startServer({ redisUrl: inject('redisUrl'), policies: [], adminToken: TOKEN });
  });
  afterAll(async () => {
    await server.close();
  });

  const inline = (extra: Record<string, unknown>): Record<string, unknown> => ({
    key: uniqueKey('user'),
    algorithm: 'sliding-window-counter',
    limit: 10,
    windowSeconds: 60,
    ...extra,
  });

  it.each([
    ['a limit above the maximum', { limit: 1_000_000_001 }],
    ['a window above one year', { windowSeconds: 31_536_001 }],
    ['an unsafe integer window', { limit: 1, windowSeconds: Number.MAX_SAFE_INTEGER }],
    ['a product above 2^53 in milliseconds', { limit: 1_000_000_000, windowSeconds: 9008 }],
  ])('answers 400 to an inline check with %s', async (_label, extra) => {
    const response = await post(server.url, inline(extra));
    expect(response.status).toBe(400);
    expect(response.headers.get('x-ratelimit-limit')).toBeNull();
  });

  it('answers 400 to a policy with the same problems and stores nothing', async () => {
    for (const extra of [{ limit: 1_000_000_001 }, { windowSeconds: 31_536_001 }, { limit: 1_000_000_000, windowSeconds: 9008 }]) {
      const response = await fetch(`${server.url}/v1/admin/policies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
        body: JSON.stringify({ name: 'too-big', route: '/x', algorithm: 'token-bucket', limit: 10, windowSeconds: 60, ...extra }),
      });
      expect(response.status).toBe(400);
    }
    expect(server.policies.get('too-big')).toBeUndefined();
  });

  it('accepts the largest values the schema allows', async () => {
    const response = await post(server.url, inline({ algorithm: 'token-bucket', limit: 1_000_000_000, windowSeconds: 9007 }));
    expect(response.status).toBe(200);
    expect(response.body.remaining).toBe(999_999_999);
  });
});
