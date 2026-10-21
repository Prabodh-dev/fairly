import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Algorithm } from '../../algorithms/types.js';
import { ALGORITHM_NAMES, budgetIssue, limitFields, withinBudget, type AlgorithmName, type FailureMode, type LimitSpec } from '../../config/types.js';
import type { Metrics } from '../../metrics/index.js';
import type { PolicyStore } from '../../policy/store.js';

const keySchema = z.string().min(1).max(256);

const checkBodySchema = z.union([
  z
    .object({
      key: keySchema,
      route: z.string().min(1).max(256),
      tier: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z.object({ key: keySchema, ...limitFields }).strict().refine(withinBudget, budgetIssue),
]);

const INLINE_POLICY = 'inline';

function setRateLimitHeaders(reply: FastifyReply, limit: number, remaining: number, resetAtMs: number): void {
  void reply
    .header('X-RateLimit-Limit', limit)
    .header('X-RateLimit-Remaining', remaining)
    .header('X-RateLimit-Reset', Math.ceil(resetAtMs / 1000));
}

export interface CheckRouteDeps {
  policies: PolicyStore;
  algorithms: Record<AlgorithmName, Algorithm>;
  failureMode: FailureMode;
  failClosedRetryAfterSeconds: number;
  metrics: Metrics;
}

export function registerCheckRoute(app: FastifyInstance, deps: CheckRouteDeps): void {
  app.post('/v1/check', async (request, reply) => {
    const body = checkBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_request',
        details: body.error.issues.map((issue) => issue.message),
        hint: `send { key, route, tier? } to use a named policy, or { key, algorithm, limit, windowSeconds } with algorithm one of: ${ALGORITHM_NAMES.join(', ')}`,
      });
    }

    let policyName: string;
    let routeLimit: LimitSpec;
    if ('route' in body.data) {
      const policy = deps.policies.resolve(body.data.route, body.data.tier);
      if (policy === undefined) {
        return reply.code(404).send({ error: 'no_matching_policy', route: body.data.route, tier: body.data.tier ?? null });
      }
      policyName = policy.name;
      routeLimit = { algorithm: policy.algorithm, limit: policy.limit, windowSeconds: policy.windowSeconds };
    } else {
      policyName = INLINE_POLICY;
      routeLimit = { algorithm: body.data.algorithm, limit: body.data.limit, windowSeconds: body.data.windowSeconds };
    }
    const key = body.data.key;
    const limitKey = `${policyName}:${key}`;

    const algorithm = deps.algorithms[routeLimit.algorithm];
    const stopTimer = deps.metrics.checkDuration.startTimer({ algorithm: routeLimit.algorithm });

    let result;
    try {
      result = await algorithm.check(limitKey, routeLimit.limit, routeLimit.windowSeconds);
    } catch (err) {
      stopTimer();
      const allowed = deps.failureMode === 'fail-open';
      deps.metrics.redisFailures.inc({ operation: 'check', mode: deps.failureMode });
      request.log.error(
        { err, key, policy: policyName, algorithm: routeLimit.algorithm, failureMode: deps.failureMode, decision: allowed ? 'allowed' : 'rejected' },
        'redis unavailable, applying failure mode',
      );
      deps.metrics.degradedDecisions.inc({ mode: deps.failureMode, decision: allowed ? 'allowed' : 'rejected' });
      const nowMs = Date.now();
      void reply.header('X-Fairly-Degraded', 'true');
      if (allowed) {
        const resetAtMs = nowMs + routeLimit.windowSeconds * 1000;
        setRateLimitHeaders(reply, routeLimit.limit, routeLimit.limit, resetAtMs);
        return reply.code(200).send({ allowed: true, remaining: routeLimit.limit, resetAtMs, policy: policyName, degraded: true });
      }
      const retryAfterSeconds = deps.failClosedRetryAfterSeconds;
      const resetAtMs = nowMs + retryAfterSeconds * 1000;
      setRateLimitHeaders(reply, routeLimit.limit, 0, resetAtMs);
      return reply
        .code(503)
        .header('Retry-After', retryAfterSeconds)
        .send({ allowed: false, remaining: 0, resetAtMs, policy: policyName, degraded: true, error: 'store_unavailable' });
    }
    stopTimer();

    const decision = result.allowed ? 'allowed' : 'rejected';
    deps.metrics.decisions.inc({ policy: policyName, algorithm: routeLimit.algorithm, decision });
    request.log.info(
      { key, policy: policyName, algorithm: routeLimit.algorithm, decision, remaining: result.remaining },
      'rate limit decision',
    );

    setRateLimitHeaders(reply, routeLimit.limit, result.remaining, result.resetAtMs);

    const payload = { allowed: result.allowed, remaining: result.remaining, resetAtMs: result.resetAtMs, policy: policyName };
    if (!result.allowed) {
      return reply
        .code(429)
        .header('Retry-After', Math.max(1, Math.ceil(result.retryAfterMs / 1000)))
        .send(payload);
    }
    return reply.code(200).send(payload);
  });
}
