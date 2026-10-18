import http from 'node:http';
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

const LISTEN_BACKLOG = 1024;
const MAX_CLIENT_SOCKETS = 100;
const READY_TIMEOUT_MS = 10_000;

const agents = new Map<string, http.Agent>();

function agentFor(baseUrl: string): http.Agent {
  let agent = agents.get(baseUrl);
  if (agent === undefined) {
    agent = new http.Agent({ keepAlive: true, maxSockets: MAX_CLIENT_SOCKETS });
    agents.set(baseUrl, agent);
  }
  return agent;
}

async function waitUntilAccepting(baseUrl: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(`${baseUrl}/healthz`);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`server at ${baseUrl} did not accept connections within ${READY_TIMEOUT_MS}ms`, { cause: lastError });
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
  const metrics = createMetrics();
  const policies = new PolicyStore({
    store,
    logger,
    seed: options.policies,
    onChange: (count) => {
      metrics.activePolicies.set(count);
    },
    onFailure: (operation) => {
      metrics.redisFailures.inc({ operation, mode: options.failureMode ?? 'fail-closed' });
    },
    refreshMs: options.policyRefreshMs ?? 60_000,
    keyPrefix: options.policyPrefix ?? uniqueKey('policies'),
  });
  await policies.refresh();
  if (options.policyRefreshMs !== undefined) policies.start();
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
  await app.listen({ port: 0, host: '127.0.0.1', backlog: LISTEN_BACKLOG });
  const address = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  await waitUntilAccepting(url);
  return {
    url,
    app,
    store,
    policies,
    close: async () => {
      agents.get(url)?.destroy();
      agents.delete(url);
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

export function post(baseUrl: string, payload: unknown): Promise<CheckResponse> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${baseUrl}/v1/check`,
      {
        method: 'POST',
        agent: agentFor(baseUrl),
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          try {
            resolve({
              status: response.statusCode ?? 0,
              headers,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as CheckResponse['body'],
            });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

export function postCheck(baseUrl: string, route: string, key: string): Promise<CheckResponse> {
  return post(baseUrl, { route, key });
}
