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

export class RedisTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`redis ${operation} did not complete within ${timeoutMs}ms`);
    this.name = 'RedisTimeoutError';
  }
}

export function createRedis(options: RedisOptions): Redis {
  return new Redis(options.url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: options.commandTimeoutMs,
    connectTimeout: options.commandTimeoutMs,
    retryStrategy: (attempt) => Math.min(attempt * 100, 2000),
  });
}

export class RedisStore implements ScriptRunner {
  constructor(
    private readonly redis: Redis,
    private readonly timeoutMs: number,
  ) {}

  private withTimeout<T>(operation: string, start: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RedisTimeoutError(operation, this.timeoutMs));
      }, this.timeoutMs);
      start().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  onError(handler: (err: Error) => void): void {
    this.redis.on('error', handler);
  }

  async connect(): Promise<void> {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }

  run<T>(operation: (redis: Redis) => Promise<T>): Promise<T> {
    return this.withTimeout('command', () => operation(this.redis));
  }

  execute(script: LuaScript, keys: string[], args: ScriptArg[]): Promise<unknown> {
    return this.withTimeout('script', async () => {
      try {
        return await this.redis.evalsha(script.sha, keys.length, ...keys, ...args);
      } catch (err) {
        if (!(err instanceof Error) || !err.message.startsWith('NOSCRIPT')) {
          throw err;
        }
      }
      await this.redis.script('LOAD', script.source);
      return this.redis.evalsha(script.sha, keys.length, ...keys, ...args);
    });
  }

  async ping(): Promise<void> {
    await this.withTimeout('ping', () => this.redis.ping());
  }

  abort(): void {
    this.redis.disconnect();
  }

  async close(): Promise<void> {
    if (this.redis.status !== 'ready') {
      this.redis.disconnect();
      return;
    }
    try {
      await this.withTimeout('quit', () => this.redis.quit());
    } catch (err) {
      this.redis.disconnect();
      throw err;
    }
  }
}
