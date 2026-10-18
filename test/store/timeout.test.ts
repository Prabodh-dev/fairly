import { execFileSync } from 'node:child_process';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LuaScript, RedisStore, RedisTimeoutError, createRedis } from '../../src/store/redis.js';

describe('redis store timeout', () => {
  let container: Awaited<ReturnType<GenericContainer['start']>>;
  let store: RedisStore;

  beforeAll(async () => {
    container = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    store = new RedisStore(createRedis({ url, commandTimeoutMs: 60_000 }), 200);
    await store.connect();
  });

  afterAll(async () => {
    await store.close();
    await container.stop();
  });

  it('rejects with a timeout error when Redis stops answering, independent of the client timeout', async () => {
    await store.ping();
    execFileSync('docker', ['pause', container.getId()]);
    try {
      const script = new LuaScript('return 1');
      for (const operation of [
        () => store.ping(),
        () => store.execute(script, [], []),
        () => store.run((redis) => redis.get('anything')),
      ]) {
        const started = performance.now();
        await expect(operation()).rejects.toBeInstanceOf(RedisTimeoutError);
        expect(performance.now() - started).toBeLessThan(1000);
      }
    } finally {
      execFileSync('docker', ['unpause', container.getId()]);
    }
    await expect.poll(() => store.ping().then(() => 'ok'), { timeout: 10_000 }).toBe('ok');
  });
});
