import type { AlgorithmName } from '../config/types.js';
import type { ScriptRunner } from '../store/redis.js';

export interface CheckResult {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
  retryAfterMs: number;
}

export interface Algorithm {
  readonly name: AlgorithmName;
  check(key: string, limit: number, windowSeconds: number): Promise<CheckResult>;
}

export interface Clock {
  nowMs(): number;
}

export interface AlgorithmDeps {
  store: ScriptRunner;
  clock?: Clock;
}

export const REDIS_TIME = '';

export function parseScriptReply(reply: unknown): CheckResult {
  if (
    !Array.isArray(reply) ||
    reply.length !== 4 ||
    !reply.every((value): value is number => typeof value === 'number')
  ) {
    throw new Error(`unexpected script reply: ${JSON.stringify(reply)}`);
  }
  const [allowed, remaining, resetAtMs, retryAfterMs] = reply as [number, number, number, number];
  return { allowed: allowed === 1, remaining, resetAtMs, retryAfterMs };
}
