import pino from 'pino';
import { buildServer } from './api/server.js';
import { createAlgorithms } from './algorithms/index.js';
import { loadLimitsConfig, loadSettings } from './config/loader.js';
import { createMetrics } from './metrics/index.js';
import { PolicyStore } from './policy/store.js';
import { createShutdown } from './shutdown.js';
import { createRedis, RedisStore } from './store/redis.js';

const settings = loadSettings(process.env);
const limits = loadLimitsConfig(settings.configPath);

const store = new RedisStore(
  createRedis({ url: settings.redisUrl, commandTimeoutMs: settings.redisCommandTimeoutMs }),
  settings.redisCommandTimeoutMs,
);
const logger = pino({ level: settings.logLevel });
const metrics = createMetrics();
const policies = new PolicyStore({
  store,
  logger,
  seed: limits.policies,
  refreshMs: settings.policyRefreshMs,
  onChange: (count) => {
    metrics.activePolicies.set(count);
  },
  onFailure: (operation) => {
    metrics.redisFailures.inc({ operation, mode: settings.failureMode });
  },
});
const app = buildServer({
  store,
  policies,
  algorithms: createAlgorithms({ store }),
  failureMode: settings.failureMode,
  failClosedRetryAfterSeconds: settings.failClosedRetryAfterSeconds,
  metrics,
  logger,
  adminToken: settings.adminToken,
});

store.onError((err) => {
  app.log.warn({ err, failureMode: settings.failureMode }, 'redis connection error');
});

const shutdown = createShutdown({
  app,
  policies,
  store,
  logger,
  timeoutMs: settings.shutdownTimeoutMs,
  exit: (code) => process.exit(code),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

try {
  await store.connect().catch((err: unknown) => {
    app.log.warn({ err, failureMode: settings.failureMode }, 'redis not reachable at startup, continuing; requests follow the failure mode');
  });
  await policies.refresh().catch((err: unknown) => {
    app.log.warn({ err }, 'initial policy load failed, using policies from the config file until Redis is reachable');
  });
  policies.start();
  await app.listen({ port: settings.port, host: settings.host });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
