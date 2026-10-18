import type { FastifyInstance } from 'fastify';
import type { FailureMode } from '../../config/types.js';
import type { Metrics } from '../../metrics/index.js';
import type { RedisStore } from '../../store/redis.js';

export function registerHealthzRoute(app: FastifyInstance, store: RedisStore, metrics: Metrics, failureMode: FailureMode): void {
  app.get('/healthz', async (request, reply) => {
    try {
      await store.ping();
    } catch (err) {
      metrics.redisFailures.inc({ operation: 'healthz', mode: failureMode });
      request.log.error({ err }, 'health check failed: redis unreachable');
      return reply.code(503).send({ status: 'unavailable' });
    }
    return reply.code(200).send({ status: 'ok' });
  });
}
