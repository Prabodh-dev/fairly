import type { FastifyInstance } from 'fastify';
import type { Registry } from 'prom-client';

export function registerMetricsRoute(app: FastifyInstance, registry: Registry): void {
  app.get('/metrics', async (_request, reply) => {
    return reply.header('content-type', registry.contentType).send(await registry.metrics());
  });
}
