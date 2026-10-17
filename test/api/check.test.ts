import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { LimitsConfig } from '../../src/config/types.js';
import { uniqueKey } from '../helpers.js';
import { post, postCheck, startServer, type RunningServer } from '../server.js';

const limits: LimitsConfig = {
  routes: {
    strict: { algorithm: 'fixed-window', limit: 3, windowSeconds: 3600 },
    bursty: { algorithm: 'token-bucket', limit: 2, windowSeconds: 3600 },
  },
};

describe('POST /v1/check and GET /healthz', () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await startServer(inject('redisUrl'), limits);
  });
  afterAll(async () => {
    await server.close();
  });

  it('returns 200 with rate limit headers computed from the decision', async () => {
    const key = uniqueKey('user');
    const first = await postCheck(server.url, 'strict', key);
    expect(first.status).toBe(200);
    expect(first.body.allowed).toBe(true);
    expect(first.body.remaining).toBe(2);
    expect(first.headers.get('x-ratelimit-limit')).toBe('3');
    expect(first.headers.get('x-ratelimit-remaining')).toBe('2');
    expect(first.headers.get('x-ratelimit-reset')).toBe(String(Math.ceil(first.body.resetAtMs / 1000)));
    expect(first.headers.get('retry-after')).toBeNull();

    const second = await postCheck(server.url, 'strict', key);
    expect(second.headers.get('x-ratelimit-remaining')).toBe('1');
  });

  it('returns 429 with Retry-After once the limit is reached', async () => {
    const key = uniqueKey('user');
    for (let i = 0; i < 3; i++) expect((await postCheck(server.url, 'strict', key)).status).toBe(200);
    const rejected = await postCheck(server.url, 'strict', key);
    expect(rejected.status).toBe(429);
    expect(rejected.body.allowed).toBe(false);
    expect(rejected.body.remaining).toBe(0);
    expect(rejected.headers.get('x-ratelimit-remaining')).toBe('0');
    const retryAfter = Number(rejected.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });

  it('applies the algorithm configured for the route', async () => {
    const key = uniqueKey('user');
    expect((await postCheck(server.url, 'bursty', key)).body.remaining).toBe(1);
    expect((await postCheck(server.url, 'bursty', key)).body.remaining).toBe(0);
    expect((await postCheck(server.url, 'bursty', key)).status).toBe(429);
  });

  it('isolates the same key across routes', async () => {
    const key = uniqueKey('user');
    for (let i = 0; i < 3; i++) await postCheck(server.url, 'strict', key);
    expect((await postCheck(server.url, 'bursty', key)).status).toBe(200);
  });

  it('returns 404 for an unknown route and 400 for a malformed body', async () => {
    const unknown = await postCheck(server.url, 'nope', 'k');
    expect(unknown.status).toBe(404);

    const malformed = await fetch(`${server.url}/v1/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ route: 'strict' }),
    });
    expect(malformed.status).toBe(400);
  });

  it('accepts an inline algorithm and limit config instead of a route', async () => {
    const key = uniqueKey('user');
    const inline = { key, algorithm: 'sliding-window-log', limit: 2, windowSeconds: 3600 };
    expect((await post(server.url, inline)).body.remaining).toBe(1);
    expect((await post(server.url, inline)).body.remaining).toBe(0);
    const rejected = await post(server.url, inline);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).not.toBeNull();
  });

  it('rejects an inline config with an unknown algorithm or non-positive limit', async () => {
    const base = { key: 'k', algorithm: 'fixed-window', limit: 5, windowSeconds: 60 };
    expect((await post(server.url, { ...base, algorithm: 'leaky-bucket' })).status).toBe(400);
    expect((await post(server.url, { ...base, limit: 0 })).status).toBe(400);
    expect((await post(server.url, { ...base, windowSeconds: -1 })).status).toBe(400);
  });

  it('exposes decision counters on /metrics', async () => {
    const key = uniqueKey('user');
    for (let i = 0; i < 4; i++) await postCheck(server.url, 'strict', key);
    const text = await (await fetch(`${server.url}/metrics`)).text();
    expect(text).toMatch(/fairly_decisions_total\{route="strict",algorithm="fixed-window",decision="allowed"\} \d+/);
    expect(text).toMatch(/fairly_decisions_total\{route="strict",algorithm="fixed-window",decision="rejected"\} [1-9]\d*/);
    expect(text).toContain('fairly_check_duration_seconds_bucket');
  });

  it('reports healthy when Redis is reachable', async () => {
    const response = await fetch(`${server.url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });
});
