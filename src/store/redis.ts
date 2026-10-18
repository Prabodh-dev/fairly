import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Redis } from 'ioredis';

export class LuaScript {
  readonly sha: string;

  constructor(readonly source: string) {
    this.sha = createHash('sha1').update(source).digest('hex');
  }

  static fromFile(url: URL): LuaScript {
    return new LuaScript(readFileSync(url, 'utf8'));
  }
}

export type ScriptArg = string | number;

export interface ScriptRunner {
  execute(script: LuaScript, keys: string[], args: ScriptArg[]): Promise<unknown>;
}

export interface RedisOptions {
  url: string;
  commandTimeoutMs: number;
}

export function createRedis(options: RedisOptions): Redis {
  return new Redis(options.url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: options.commandTimeoutMs,
    retryStrategy: (attempt) => Math.min(attempt * 100, 2000),
  });
}

export class RedisStore implements ScriptRunner {
  constructor(private readonly redis: Redis) {}

  onError(handler: (err: Error) => void): void {
    this.redis.on('error', handler);
  }

  async connect(): Promise<void> {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }

  run<T>(operation: (redis: Redis) => Promise<T>): Promise<T> {
    return operation(this.redis);
  }

  async execute(script: LuaScript, keys: string[], args: ScriptArg[]): Promise<unknown> {
    try {
      return await this.redis.evalsha(script.sha, keys.length, ...keys, ...args);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('NOSCRIPT')) {
        throw err;
      }
    }
    await this.redis.script('LOAD', script.source);
    return this.redis.evalsha(script.sha, keys.length, ...keys, ...args);
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async close(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
    } else {
      this.redis.disconnect();
    }
  }
}
