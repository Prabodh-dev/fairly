import { LuaScript } from '../store/redis.js';
import { parseScriptReply, REDIS_TIME, type Algorithm, type AlgorithmDeps, type CheckResult } from './types.js';

// Atomic because reading the previous and current bucket counts, computing the weighted estimate,
// and the INCR of the current bucket all run inside one Lua execution. Bucket numbers come from
// Redis TIME inside the script (unless a test clock is passed). Both bucket keys share the hash
// tag of KEYS[1].
const script = LuaScript.fromFile(new URL('./lua/sliding-window-counter.lua', import.meta.url));

export class SlidingWindowCounter implements Algorithm {
  readonly name = 'sliding-window-counter';

  constructor(private readonly deps: AlgorithmDeps) {}

  async check(key: string, limit: number, windowSeconds: number): Promise<CheckResult> {
    const now = this.deps.clock?.nowMs() ?? REDIS_TIME;
    const reply = await this.deps.store.execute(script, [`fairly:{${key}}:swc`], [limit, windowSeconds * 1000, now]);
    return parseScriptReply(reply);
  }
}
