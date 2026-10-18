import { execFileSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { GenericContainer, Wait } from 'testcontainers';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Policy } from '../../src/config/types.js';
import { uniqueKey } from '../helpers.js';
import { sampleValue, scrape } from '../metrics.js';
import { SpecConformance, loadSpec } from '../openapi.js';
import { postCheck, startServer, type RunningServer } from '../server.js';

const TOKEN = 'test-admin-token-0123456789';
const TIMEOUT_MS = 300;
const policies: Policy[] = [{ name: 'r', route: 'r', algorithm: 'fixed-window', limit: 2, windowSeconds: 3600 }];

interface LogLine {
  msg?: string;
  key?: string;
  policy?: string;
  algorithm?: string;
  failureMode?: string;
  decision?: string;
}

function capture(lines: LogLine[]): pino.Logger {
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      for (const line of chunk.toString().split('\n')) {
        if (line !== '') lines.push(JSON.parse(line) as LogLine);
      }
      callback();
    },
  });
  return pino({ level: 'info' }, sink);
}

async function metricValue(server: RunningServer, series: string): Promise<number> {
  const text = await (await fetch(`${server.url}/metrics`)).text();
  const line = text.split('\n').find((candidate) => candidate.startsWith(series));
  return line === undefined ? 0 : Number(line.slice(series.length).trim());
}

async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await operation();
  return { value, ms: performance.now() - started };
}

describe('redis failure handling', () => {
  let container: Awaited<ReturnType<GenericContainer['start']>>;
  let open: RunningServer;
  let closed: RunningServer;
  const openLogs: LogLine[] = [];
  const closedLogs: LogLine[] = [];

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    const redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    const shared = { redisUrl, policies, adminToken: TOKEN, commandTimeoutMs: TIMEOUT_MS, policyRefreshMs: 100 };
    open = await startServer({ ...shared, failureMode: 'fail-open', logger: capture(openLogs) });
    closed = await startServer({ ...shared, failureMode: 'fail-closed', logger: capture(closedLogs) });
  });

  afterAll(async () => {
    await open.close();
    await closed.close();
    await container.stop();
  });

  it('serves normal, non-degraded responses while Redis is healthy', async () => {
    for (const server of [open, closed]) {
      const response = await postCheck(server.url, 'r', uniqueKey('user'));
      expect(response.status).toBe(200);
      expect(response.headers.get('x-fairly-degraded')).toBeNull();
      expect(response.body.remaining).toBe(1);
    }
  });

  it('answers within the timeout when Redis hangs, in both modes, without stalling the server', async () => {
    execFileSync('docker', ['pause', container.getId()]);
    try {
      const probes: number[] = [];
      const state = { probing: true };
      const prober = (async (): Promise<void> => {
        while (state.probing) {
          const { ms } = await timed(() => fetch(`${closed.url}/metrics`).then((r) => r.text()));
          probes.push(ms);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();

      const [openResults, closedResults] = await Promise.all([
        Promise.all(Array.from({ length: 20 }, () => timed(() => postCheck(open.url, 'r', uniqueKey('user'))))),
        Promise.all(Array.from({ length: 20 }, () => timed(() => postCheck(closed.url, 'r', uniqueKey('user'))))),
      ]);
      state.probing = false;
      await prober;

      for (const { value, ms } of openResults) {
        expect(value.status).toBe(200);
        expect(value.body.allowed).toBe(true);
        expect(ms).toBeLessThan(TIMEOUT_MS * 4);
      }
      for (const { value, ms } of closedResults) {
        expect(value.status).toBe(503);
        expect(value.body.allowed).toBe(false);
        expect(ms).toBeLessThan(TIMEOUT_MS * 4);
      }
      expect(probes.length).toBeGreaterThan(3);
      expect(Math.max(...probes)).toBeLessThan(150);
    } finally {
      execFileSync('docker', ['unpause', container.getId()]);
    }
  });

  it('recovers on its own once Redis responds again', async () => {
    await expect
      .poll(async () => (await postCheck(open.url, 'r', uniqueKey('user'))).headers.get('x-fairly-degraded'), { timeout: 15_000 })
      .toBeNull();
    await expect
      .poll(async () => (await postCheck(closed.url, 'r', uniqueKey('user'))).status, { timeout: 15_000 })
      .toBe(200);
  });

  it('fail-open allows the request, logs the decision and counts the failure when Redis is gone', async () => {
    await container.stop();
    const key = uniqueKey('user');
    const before = await metricValue(open, 'fairly_redis_failures_total{operation="check",mode="fail-open"}');

    const response = await postCheck(open.url, 'r', key);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ allowed: true, degraded: true, policy: 'r', remaining: 2 });
    expect(response.headers.get('x-ratelimit-limit')).toBe('2');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('2');
    expect(Number(response.headers.get('x-ratelimit-reset'))).toBeGreaterThan(Date.now() / 1000);
    expect(response.headers.get('x-fairly-degraded')).toBe('true');
    expect(response.headers.get('retry-after')).toBeNull();

    const entry = openLogs.find((line) => line.msg === 'redis unavailable, applying failure mode' && line.key === key);
    expect(entry).toMatchObject({ policy: 'r', algorithm: 'fixed-window', failureMode: 'fail-open', decision: 'allowed' });
    expect(await metricValue(open, 'fairly_redis_failures_total{operation="check",mode="fail-open"}')).toBe(before + 1);
  });

  it('serves degraded responses that match the documented schemas and counts degraded decisions', async () => {
    const conformance = new SpecConformance(loadSpec());
    const headers = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-fairly-degraded'];
    const send = (server: RunningServer): Promise<Response> =>
      fetch(`${server.url}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: uniqueKey('user'), route: 'r' }) });

    const openResponse = await send(open);
    conformance.responseConforms('post', '/v1/check', 200, await openResponse.json(), openResponse.headers, headers);
    const closedResponse = await send(closed);
    expect(closedResponse.status).toBe(503);
    conformance.responseConforms('post', '/v1/check', 503, await closedResponse.json(), closedResponse.headers, [...headers, 'retry-after']);
    const health = await fetch(`${closed.url}/healthz`);
    conformance.responseConforms('get', '/healthz', 503, await health.json(), health.headers);

    const openMetrics = await scrape(open.url);
    expect(sampleValue(openMetrics, 'fairly_degraded_decisions_total', { mode: 'fail-open', decision: 'allowed' })).toBeGreaterThanOrEqual(2);
    expect(sampleValue(openMetrics, 'fairly_degraded_decisions_total', { mode: 'fail-open', decision: 'rejected' })).toBeUndefined();
    const closedMetrics = await scrape(closed.url);
    expect(sampleValue(closedMetrics, 'fairly_degraded_decisions_total', { mode: 'fail-closed', decision: 'rejected' })).toBeGreaterThanOrEqual(1);
    expect(sampleValue(closedMetrics, 'fairly_http_requests_total', { method: 'POST', route: '/v1/check', status: '503' })).toBeGreaterThanOrEqual(1);
  });

  it('logs and counts every failed check, not only the first', async () => {
    const before = await metricValue(open, 'fairly_redis_failures_total{operation="check",mode="fail-open"}');
    for (let i = 0; i < 5; i++) await postCheck(open.url, 'r', uniqueKey('user'));
    expect(await metricValue(open, 'fairly_redis_failures_total{operation="check",mode="fail-open"}')).toBe(before + 5);
    expect(openLogs.filter((line) => line.msg === 'redis unavailable, applying failure mode').length).toBeGreaterThanOrEqual(6);
  });

  it('fail-closed denies the request with Retry-After, logs the decision and counts the failure', async () => {
    const key = uniqueKey('user');
    const response = await postCheck(closed.url, 'r', key);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ allowed: false, degraded: true, remaining: 0, policy: 'r' });
    expect(response.headers.get('retry-after')).toBe('1');
    expect(response.headers.get('x-ratelimit-limit')).toBe('2');
    expect(response.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(response.headers.get('x-ratelimit-reset')).not.toBeNull();

    const entry = closedLogs.find((line) => line.msg === 'redis unavailable, applying failure mode' && line.key === key);
    expect(entry).toMatchObject({ policy: 'r', algorithm: 'fixed-window', failureMode: 'fail-closed', decision: 'rejected' });
    expect(await metricValue(closed, 'fairly_redis_failures_total{operation="check",mode="fail-closed"}')).toBeGreaterThanOrEqual(1);
  });

  it('keeps resolving policies from the last known state and counts refresh failures', async () => {
    const response = await postCheck(open.url, 'r', uniqueKey('user'));
    expect(response.body.policy).toBe('r');
    await expect
      .poll(() => metricValue(open, 'fairly_redis_failures_total{operation="policy_refresh",mode="fail-open"}'))
      .toBeGreaterThan(0);
  });

  it('reports admin writes as unavailable instead of pretending they succeeded', async () => {
    const response = await fetch(`${open.url}/v1/admin/policies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify({ name: 'new', route: '/new', algorithm: 'fixed-window', limit: 1, windowSeconds: 60 }),
    });
    expect(response.status).toBe(503);
    expect(open.policies.get('new')).toBeUndefined();
  });

  it('reports unhealthy on /healthz', async () => {
    expect((await fetch(`${open.url}/healthz`)).status).toBe(503);
    expect((await fetch(`${closed.url}/healthz`)).status).toBe(503);
  });
});
