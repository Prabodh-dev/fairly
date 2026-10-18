import { Counter, Histogram, Registry } from 'prom-client';

export interface Metrics {
  registry: Registry;
  decisions: Counter<'policy' | 'algorithm' | 'decision'>;
  storeErrors: Counter<'algorithm' | 'policy'>;
  checkDuration: Histogram<'algorithm'>;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  const decisions = new Counter({
    name: 'fairly_decisions_total',
    help: 'Rate limit decisions by policy, algorithm and outcome',
    labelNames: ['policy', 'algorithm', 'decision'] as const,
    registers: [registry],
  });
  const storeErrors = new Counter({
    name: 'fairly_store_errors_total',
    help: 'Checks that failed because the store was unreachable, by failure policy applied',
    labelNames: ['algorithm', 'policy'] as const,
    registers: [registry],
  });
  const checkDuration = new Histogram({
    name: 'fairly_check_duration_seconds',
    help: 'Time spent executing one atomic rate limit check against the store',
    labelNames: ['algorithm'] as const,
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1],
    registers: [registry],
  });
  return { registry, decisions, storeErrors, checkDuration };
}
