import { fileURLToPath } from 'node:url';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Algorithm } from '../algorithms/types.js';
import type { AlgorithmName, FailureMode } from '../config/types.js';
import type { Metrics } from '../metrics/index.js';
import type { PolicyStore } from '../policy/store.js';
import type { RedisStore } from '../store/redis.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerCheckRoute } from './routes/check.js';
import { registerHealthzRoute } from './routes/healthz.js';
import { registerMetricsRoute } from './routes/metrics.js';

export interface ServerDeps {
  store: RedisStore;
  policies: PolicyStore;
  algorithms: Record<AlgorithmName, Algorithm>;
  failureMode: FailureMode;
  failClosedRetryAfterSeconds: number;
  metrics: Metrics;
  logger: FastifyBaseLogger;
  adminToken?: string | undefined;
}

const OPENAPI_PATH = fileURLToPath(new URL('../../openapi.yaml', import.meta.url));

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.logger });
  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unmatched';
    deps.metrics.httpRequests.inc({ method: request.method, route, status: reply.statusCode });
    deps.metrics.httpDuration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
    done();
  });
  registerCheckRoute(app, {
    policies: deps.policies,
    algorithms: deps.algorithms,
    failureMode: deps.failureMode,
    failClosedRetryAfterSeconds: deps.failClosedRetryAfterSeconds,
    metrics: deps.metrics,
  });
  if (deps.adminToken !== undefined) {
    registerAdminRoutes(app, deps.policies, deps.adminToken);
  } else {
    app.log.warn('FAIRLY_ADMIN_TOKEN is not set, the admin API is disabled');
  }
  registerHealthzRoute(app, deps.store, deps.metrics, deps.failureMode);
  registerMetricsRoute(app, deps.metrics.registry);
  void app.register(fastifySwagger, { mode: 'static', specification: { path: OPENAPI_PATH, baseDir: '' } });
  void app.register(fastifySwaggerUi, { routePrefix: '/docs' });
  return app;
}
