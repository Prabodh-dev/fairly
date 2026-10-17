import { randomUUID } from 'node:crypto';
import { LuaScript } from '../store/redis.js';
import { parseScriptReply, REDIS_TIME, type Algorithm, type AlgorithmDeps, type CheckResult } from './types.js';

// Atomic because eviction of expired entries, the count, and the ZADD of the new entry all run
// inside one Lua execution. A concurrent request can never observe the set between the count and
// the insert. The only value generated outside the script is a unique member id, which carries
// no decision logic.
const script = LuaScript.fromFile(new URL('./lua/sliding-window-log.lua', import.meta.url));

export class SlidingWindowLog implements Algorithm {
  readonly name = 'sliding-window-log';

  constructor(private readonly deps: AlgorithmDeps) {}

  async check(key: string, limit: number, windowSeconds: number): Promise<CheckResult> {
    const now = this.deps.clock?.nowMs() ?? REDIS_TIME;
    const reply = await this.deps.store.execute(
      script,
      [`fairly:{${key}}:swl`],
      [limit, windowSeconds * 1000, now, randomUUID()],
    );
    return parseScriptReply(reply);
  }
}
