import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Policy } from '../../src/config/types.js';
import { postCheck, startServer, type RunningServer } from '../server.js';

const policies: Policy[] = [{ name: 'r', route: 'r', algorithm: 'fixed-window', limit: 1, windowSeconds: 3600 }];

describe('store failure policy', () => {
  let container: Awaited<ReturnType<GenericContainer['start']>>;
  let open: RunningServer;
  let closed: RunningServer;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    open = await startServer({ redisUrl: url, policies, failurePolicy: 'open' });
    closed = await startServer({ redisUrl: url, policies, failurePolicy: 'closed' });
  });

  afterAll(async () => {
    await open.close();
    await closed.close();
    await container.stop();
  });

  it('follows the configured policy and healthz reports 503 once Redis is unreachable', async () => {
    expect((await postCheck(open.url, 'r', 'k1')).status).toBe(200);
    expect((await fetch(`${closed.url}/healthz`)).status).toBe(200);

    await container.stop();

    const openResponse = await postCheck(open.url, 'r', 'k2');
    expect(openResponse.status).toBe(200);
    expect(openResponse.body).toEqual({ allowed: true, degraded: true });
    expect(openResponse.headers.get('x-ratelimit-remaining')).toBeNull();

    const closedResponse = await postCheck(closed.url, 'r', 'k2');
    expect(closedResponse.status).toBe(503);
    expect(closedResponse.body).toMatchObject({ allowed: false, degraded: true });

    expect((await fetch(`${closed.url}/healthz`)).status).toBe(503);

    const metrics = await (await fetch(`${closed.url}/metrics`)).text();
    expect(metrics).toMatch(/fairly_store_errors_total\{algorithm="fixed-window",policy="closed"\} [1-9]/);
  });
});
