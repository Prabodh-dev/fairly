import { randomUUID } from 'node:crypto';
import type { Clock } from '../src/algorithms/types.js';
import { createRedis, RedisStore } from '../src/store/redis.js';

export class ManualClock implements Clock {
  constructor(private current: number) {}

  nowMs(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

export async function connectStore(redisUrl: string, commandTimeoutMs = 5000): Promise<RedisStore> {
  const store = new RedisStore(createRedis({ url: redisUrl, commandTimeoutMs }));
  await store.connect();
  return store;
}

export function uniqueKey(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
