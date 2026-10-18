import pino from 'pino';
import { buildServer } from './api/server.js';
import { createAlgorithms } from './algorithms/index.js';
import { loadLimitsConfig, loadSettings } from './config/loader.js';
import { createMetrics } from './metrics/index.js';
import { PolicyStore } from './policy/store.js';
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

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  policies.stop();
  await app.close();
  await store.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdown(signal).then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
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
