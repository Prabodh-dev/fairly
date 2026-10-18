import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ALGORITHM_NAMES, type Policy } from '../../src/config/types.js';
import { parseMetrics, sampleValue, scrape } from '../metrics.js';
import { uniqueKey } from '../helpers.js';
import { post, postCheck, startServer, type RunningServer } from '../server.js';

const TOKEN = 'test-admin-token-0123456789';
const LIMIT = 3;
const policies: Policy[] = ALGORITHM_NAMES.map((algorithm) => ({
  name: algorithm,
  route: algorithm,
  algorithm,
  limit: LIMIT,
  windowSeconds: 3600,
}));

describe('metrics', () => {
  let server: RunningServer;
  const secretKey = uniqueKey('very-identifying-user');

  beforeAll(async () => {
    server = await startServer({ redisUrl: inject('redisUrl'), policies, adminToken: TOKEN });
  });
  afterAll(async () => {
    await server.close();
  });

  it('counts allowed and rejected decisions per policy and algorithm with exact values', async () => {
    for (const algorithm of ALGORITHM_NAMES) {
      const key = algorithm === 'fixed-window' ? secretKey : uniqueKey('user');
      for (let i = 0; i < LIMIT + 2; i++) await postCheck(server.url, algorithm, key);
    }
    const samples = await scrape(server.url);
    for (const algorithm of ALGORITHM_NAMES) {
      const labels = { policy: algorithm, algorithm };
      expect(sampleValue(samples, 'fairly_decisions_total', { ...labels, decision: 'allowed' }), `${algorithm} allowed`).toBe(LIMIT);
      expect(sampleValue(samples, 'fairly_decisions_total', { ...labels, decision: 'rejected' }), `${algorithm} rejected`).toBe(2);
    }
  });

  it('labels inline checks with the inline policy name', async () => {
    const inline = { key: uniqueKey('user'), algorithm: 'token-bucket', limit: 1, windowSeconds: 3600 };
    await post(server.url, inline);
    await post(server.url, inline);
    const samples = await scrape(server.url);
    expect(sampleValue(samples, 'fairly_decisions_total', { policy: 'inline', algorithm: 'token-bucket', decision: 'allowed' })).toBe(1);
    expect(sampleValue(samples, 'fairly_decisions_total', { policy: 'inline', algorithm: 'token-bucket', decision: 'rejected' })).toBe(1);
  });

  it('records one check duration observation per check, per algorithm', async () => {
    const samples = await scrape(server.url);
    for (const algorithm of ALGORITHM_NAMES) {
      const count = sampleValue(samples, 'fairly_check_duration_seconds_count', { algorithm });
      const total = LIMIT + 2 + (algorithm === 'token-bucket' ? 2 : 0);
      expect(count, algorithm).toBe(total);
      expect(sampleValue(samples, 'fairly_check_duration_seconds_sum', { algorithm })).toBeGreaterThan(0);
      expect(sampleValue(samples, 'fairly_check_duration_seconds_bucket', { algorithm, le: '+Inf' })).toBe(total);
    }
    const les = samples.filter((s) => s.name === 'fairly_check_duration_seconds_bucket' && s.labels['algorithm'] === 'fixed-window');
    const values = les.map((s) => s.value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });

  it('counts HTTP requests by method, route pattern and status without leaking path parameters', async () => {
    await post(server.url, { route: 'no-such-route', key: 'k' });
    await post(server.url, { key: 'k' });
    await fetch(`${server.url}/v1/admin/policies/some-name`, { headers: { 'x-admin-token': TOKEN } });
    await fetch(`${server.url}/definitely/not/a/route`);

    const samples = await scrape(server.url);
    const http = (labels: Record<string, string>): number | undefined => sampleValue(samples, 'fairly_http_requests_total', labels);
    expect(http({ method: 'POST', route: '/v1/check', status: '200' })).toBeGreaterThan(0);
    expect(http({ method: 'POST', route: '/v1/check', status: '429' })).toBeGreaterThan(0);
    expect(http({ method: 'POST', route: '/v1/check', status: '404' })).toBe(1);
    expect(http({ method: 'POST', route: '/v1/check', status: '400' })).toBe(1);
    expect(http({ method: 'GET', route: '/v1/admin/policies/:name', status: '404' })).toBe(1);
    expect(http({ method: 'GET', route: 'unmatched', status: '404' })).toBe(1);

    const routes = new Set(samples.filter((s) => s.name === 'fairly_http_requests_total').map((s) => s.labels['route']));
    expect(routes.has('/v1/admin/policies/some-name')).toBe(false);
    expect(routes.has('/definitely/not/a/route')).toBe(false);

    expect(sampleValue(samples, 'fairly_http_request_duration_seconds_count', { method: 'POST', route: '/v1/check' })).toBeGreaterThan(0);
  });

  it('tracks the number of loaded policies as policies are created and deleted', async () => {
    const admin = (method: string, path: string, body?: unknown): Promise<Response> =>
      fetch(`${server.url}${path}`, {
        method,
        headers: { 'x-admin-token': TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    expect(sampleValue(await scrape(server.url), 'fairly_policies')).toBe(ALGORITHM_NAMES.length);
    await admin('POST', '/v1/admin/policies', { name: 'extra', route: '/extra', algorithm: 'fixed-window', limit: 1, windowSeconds: 60 });
    expect(sampleValue(await scrape(server.url), 'fairly_policies')).toBe(ALGORITHM_NAMES.length + 1);
    await admin('DELETE', '/v1/admin/policies/extra');
    await admin('DELETE', `/v1/admin/policies/${ALGORITHM_NAMES[0]}`);
    expect(sampleValue(await scrape(server.url), 'fairly_policies')).toBe(ALGORITHM_NAMES.length - 1);
  });

  it('exports process metrics and starts failure counters at zero', async () => {
    const samples = await scrape(server.url);
    expect(sampleValue(samples, 'fairly_process_cpu_seconds_total')).toBeGreaterThan(0);
    expect(sampleValue(samples, 'fairly_nodejs_eventloop_lag_seconds')).toBeDefined();
    expect(samples.some((s) => s.name === 'fairly_redis_failures_total' && s.value > 0)).toBe(false);
    expect(samples.some((s) => s.name === 'fairly_degraded_decisions_total' && s.value > 0)).toBe(false);
  });

  it('never exposes the rate limit key in any label', async () => {
    const text = await (await fetch(`${server.url}/metrics`)).text();
    expect(text).not.toContain(secretKey);
    expect(() => parseMetrics(text)).not.toThrow();
  });
});
