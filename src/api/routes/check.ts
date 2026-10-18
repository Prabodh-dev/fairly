import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Algorithm } from '../../algorithms/types.js';
import { ALGORITHM_NAMES, routeLimitSchema, type AlgorithmName, type FailurePolicy, type LimitsConfig, type RouteLimit } from '../../config/types.js';
import type { Metrics } from '../../metrics/index.js';

const keySchema = z.string().min(1).max(256);

const checkBodySchema = z.union([
  z.object({ key: keySchema, route: z.string().min(1).max(128) }).strict(),
  z.object({ key: keySchema }).extend(routeLimitSchema.shape).strict(),
]);

const INLINE_ROUTE = 'inline';

export interface CheckRouteDeps {
  limits: LimitsConfig;
  algorithms: Record<AlgorithmName, Algorithm>;
  failurePolicy: FailurePolicy;
  metrics: Metrics;
}

export function registerCheckRoute(app: FastifyInstance, deps: CheckRouteDeps): void {
  app.post('/v1/check', async (request, reply) => {
    const body = checkBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: body.error.issues.map((issue) => issue.message),
        hint: `send { key, route } for a configured route, or { key, algorithm, limit, windowSeconds } with algorithm one of: ${ALGORITHM_NAMES.join(', ')}`,
      });
    }

    let routeName: string;
    let routeLimit: RouteLimit;
    let limitKey: string;
    if ('route' in body.data) {
      const configured = deps.limits.routes[body.data.route];
      if (configured === undefined) {
        return reply.code(404).send({ error: 'unknown_route', route: body.data.route });
      }
      routeName = body.data.route;
      routeLimit = configured;
      limitKey = `${routeName}:${body.data.key}`;
    } else {
      routeName = INLINE_ROUTE;
      routeLimit = { algorithm: body.data.algorithm, limit: body.data.limit, windowSeconds: body.data.windowSeconds };
      limitKey = `${INLINE_ROUTE}:${body.data.key}`;
    }
    const key = body.data.key;

    const algorithm = deps.algorithms[routeLimit.algorithm];
    const stopTimer = deps.metrics.checkDuration.startTimer({ algorithm: routeLimit.algorithm });

    let result;
    try {
      result = await algorithm.check(limitKey, routeLimit.limit, routeLimit.windowSeconds);
    } catch (err) {
      stopTimer();
      const allowed = deps.failurePolicy === 'open';
      deps.metrics.storeErrors.inc({ algorithm: routeLimit.algorithm, policy: deps.failurePolicy });
      request.log.error(
        { err, key, route: routeName, algorithm: routeLimit.algorithm, failurePolicy: deps.failurePolicy, decision: allowed ? 'allowed' : 'rejected' },
        'rate limit store unavailable, applying failure policy',
      );
      if (allowed) {
        return reply.code(200).send({ allowed: true, degraded: true });
      }
      return reply.code(503).send({ allowed: false, degraded: true, error: 'store_unavailable' });
    }
    stopTimer();

    const decision = result.allowed ? 'allowed' : 'rejected';
    deps.metrics.decisions.inc({ route: routeName, algorithm: routeLimit.algorithm, decision });
    request.log.info(
      { key, route: routeName, algorithm: routeLimit.algorithm, decision, remaining: result.remaining },
      'rate limit decision',
    );

    void reply
      .header('X-RateLimit-Limit', routeLimit.limit)
      .header('X-RateLimit-Remaining', result.remaining)
      .header('X-RateLimit-Reset', Math.ceil(result.resetAtMs / 1000));

    const payload = { allowed: result.allowed, remaining: result.remaining, resetAtMs: result.resetAtMs };
    if (!result.allowed) {
      return reply
        .code(429)
        .header('Retry-After', Math.max(1, Math.ceil(result.retryAfterMs / 1000)))
        .send(payload);
    }
    return reply.code(200).send(payload);
  });
}
