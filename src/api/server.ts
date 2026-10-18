import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Algorithm } from '../algorithms/types.js';
import type { AlgorithmName, FailurePolicy, LimitsConfig } from '../config/types.js';
import type { Metrics } from '../metrics/index.js';
import type { RedisStore } from '../store/redis.js';
import { registerCheckRoute } from './routes/check.js';
import { registerHealthzRoute } from './routes/healthz.js';
import { registerMetricsRoute } from './routes/metrics.js';

export interface ServerDeps {
  store: RedisStore;
  limits: LimitsConfig;
  algorithms: Record<AlgorithmName, Algorithm>;
  failurePolicy: FailurePolicy;
  metrics: Metrics;
  logger: FastifyBaseLogger;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.logger });
  registerCheckRoute(app, {
    limits: deps.limits,
    algorithms: deps.algorithms,
    failurePolicy: deps.failurePolicy,
    metrics: deps.metrics,
  });
  registerHealthzRoute(app, deps.store);
  registerMetricsRoute(app, deps.metrics.registry);
  return app;
}
