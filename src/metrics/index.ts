import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  decisions: Counter<'policy' | 'algorithm' | 'decision'>;
  degradedDecisions: Counter<'mode' | 'decision'>;
  redisFailures: Counter<'operation' | 'mode'>;
  checkDuration: Histogram<'algorithm'>;
  httpRequests: Counter<'method' | 'route' | 'status'>;
  httpDuration: Histogram<'method' | 'route'>;
  activePolicies: Gauge;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'fairly_' });

  const decisions = new Counter({
    name: 'fairly_decisions_total',
    help: 'Rate limit decisions by policy, algorithm and outcome (allowed or rejected)',
    labelNames: ['policy', 'algorithm', 'decision'] as const,
    registers: [registry],
  });
  const degradedDecisions = new Counter({
    name: 'fairly_degraded_decisions_total',
    help: 'Decisions made by the failure mode because Redis could not answer, by mode and outcome',
    labelNames: ['mode', 'decision'] as const,
    registers: [registry],
  });
  const redisFailures = new Counter({
    name: 'fairly_redis_failures_total',
    help: 'Redis operations that failed or timed out, by operation and configured failure mode',
    labelNames: ['operation', 'mode'] as const,
    registers: [registry],
  });
  const checkDuration = new Histogram({
    name: 'fairly_check_duration_seconds',
    help: 'Time spent executing one atomic rate limit check against the store',
    labelNames: ['algorithm'] as const,
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1],
    registers: [registry],
  });
  const httpRequests = new Counter({
    name: 'fairly_http_requests_total',
    help: 'HTTP requests by method, route pattern and status code',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: 'fairly_http_request_duration_seconds',
    help: 'HTTP request duration by method and route pattern',
    labelNames: ['method', 'route'] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  const activePolicies = new Gauge({
    name: 'fairly_policies',
    help: 'Number of policies currently loaded in this instance',
    registers: [registry],
  });
  return { registry, decisions, degradedDecisions, redisFailures, checkDuration, httpRequests, httpDuration, activePolicies };
}
