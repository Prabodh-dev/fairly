import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { PolicyStore } from './policy/store.js';
import type { RedisStore } from './store/redis.js';

export interface ShutdownDeps {
  app: FastifyInstance;
  policies: PolicyStore;
  store: RedisStore;
  logger: FastifyBaseLogger;
  timeoutMs: number;
  exit: (code: number) => void;
}

const SWEEP_INTERVAL_MS = 50;

type CloseOutcome = 'closed' | 'timeout' | 'error';

export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  const { app, policies, store, logger, timeoutMs, exit } = deps;
  let started = false;

  return async (signal) => {
    if (started) {
      logger.warn({ signal }, 'second shutdown signal received, forcing exit');
      app.server.closeAllConnections();
      exit(1);
      return;
    }
    started = true;
    logger.info({ signal, timeoutMs }, 'shutting down: closing the listener and waiting for in-flight requests');
    policies.stop();

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<CloseOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    });
    const sweep = setInterval(() => {
      app.server.closeIdleConnections();
    }, SWEEP_INTERVAL_MS);
    const closing = app.close().then(
      (): CloseOutcome => 'closed',
      (err: unknown): CloseOutcome => {
        logger.error({ err }, 'error while closing the server');
        return 'error';
      },
    );
    const outcome = await Promise.race([closing, deadline]);
    clearTimeout(timer);
    clearInterval(sweep);

    if (outcome === 'closed') {
      try {
        await store.close();
      } catch (err) {
        logger.warn({ err }, 'closing the redis connection did not finish cleanly');
      }
    } else {
      if (outcome === 'timeout') {
        logger.error({ timeoutMs }, 'in-flight requests did not finish before the shutdown timeout, closing their connections');
      }
      app.server.closeAllConnections();
      store.abort();
    }

    const code = outcome === 'closed' ? 0 : 1;
    logger.info({ code }, 'shutdown complete');
    exit(code);
  };
}
