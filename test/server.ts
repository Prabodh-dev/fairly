import type { AddressInfo } from 'node:net';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import pino from 'pino';
import { createAlgorithms } from '../src/algorithms/index.js';
import type { Clock } from '../src/algorithms/types.js';
import { buildServer } from '../src/api/server.js';
import type { FailureMode, Policy } from '../src/config/types.js';
import { createMetrics } from '../src/metrics/index.js';
import { PolicyStore } from '../src/policy/store.js';
import type { RedisStore } from '../src/store/redis.js';
import { connectStore, uniqueKey } from './helpers.js';

export interface RunningServer {
  url: string;
  app: FastifyInstance;
  store: RedisStore;
  policies: PolicyStore;
  close(): Promise<void>;
}

export interface StartOptions {
  redisUrl: string;
  policies: Policy[];
  failureMode?: FailureMode;
  commandTimeoutMs?: number;
  failClosedRetryAfterSeconds?: number;
  logger?: FastifyBaseLogger;
  clock?: Clock;
  policyPrefix?: string;
  policyRefreshMs?: number;
  adminToken?: string;
}

export async function startServer(options: StartOptions): Promise<RunningServer> {
  const store = await connectStore(options.redisUrl, options.commandTimeoutMs);
  const logger = options.logger ?? pino({ level: 'silent' });
  const policies = new PolicyStore({
    store,
    logger,
    seed: options.policies,
    onFailure: (operation) => {
      metrics.redisFailures.inc({ operation, mode: options.failureMode ?? 'fail-closed' });
    },
    refreshMs: options.policyRefreshMs ?? 60_000,
    keyPrefix: options.policyPrefix ?? uniqueKey('policies'),
  });
  await policies.refresh();
  if (options.policyRefreshMs !== undefined) policies.start();
  const metrics = createMetrics();
  const app = buildServer({
    store,
    policies,
    algorithms: createAlgorithms(options.clock === undefined ? { store } : { store, clock: options.clock }),
    failureMode: options.failureMode ?? 'fail-closed',
    failClosedRetryAfterSeconds: options.failClosedRetryAfterSeconds ?? 1,
    metrics,
    logger,
    adminToken: options.adminToken,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    app,
    store,
    policies,
    close: async () => {
      policies.stop();
      await app.close();
      await store.close();
    },
  };
}

export interface CheckResponse {
  status: number;
  headers: Headers;
  body: { allowed: boolean; remaining: number; resetAtMs: number; policy?: string; degraded?: boolean };
}

export async function post(baseUrl: string, payload: unknown): Promise<CheckResponse> {
  const response = await fetch(`${baseUrl}/v1/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json()) as CheckResponse['body'],
  };
}

export function postCheck(baseUrl: string, route: string, key: string): Promise<CheckResponse> {
  return post(baseUrl, { route, key });
}
