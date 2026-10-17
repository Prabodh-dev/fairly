import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { createAlgorithms } from '../src/algorithms/index.js';
import type { Clock } from '../src/algorithms/types.js';
import { buildServer } from '../src/api/server.js';
import type { FailurePolicy, LimitsConfig } from '../src/config/types.js';
import { createMetrics } from '../src/metrics/index.js';
import type { RedisStore } from '../src/store/redis.js';
import { connectStore } from './helpers.js';

export interface RunningServer {
  url: string;
  app: FastifyInstance;
  store: RedisStore;
  close(): Promise<void>;
}

export async function startServer(
  redisUrl: string,
  limits: LimitsConfig,
  failurePolicy: FailurePolicy = 'closed',
  clock?: Clock,
): Promise<RunningServer> {
  const store = await connectStore(redisUrl);
  const app = buildServer({
    store,
    limits,
    algorithms: createAlgorithms(clock === undefined ? { store } : { store, clock }),
    failurePolicy,
    metrics: createMetrics(),
    logger: pino({ level: 'silent' }),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    app,
    store,
    close: async () => {
      await app.close();
      await store.close();
    },
  };
}

export interface CheckResponse {
  status: number;
  headers: Headers;
  body: { allowed: boolean; remaining: number; resetAtMs: number };
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
