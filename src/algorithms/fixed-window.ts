import { LuaScript } from '../store/redis.js';
import { parseScriptReply, REDIS_TIME, type Algorithm, type AlgorithmDeps, type CheckResult } from './types.js';

// Atomic because the bucket lookup, the limit comparison and the INCR all run inside one Lua
// execution, which Redis runs to completion without interleaving any other command. The window
// bucket is derived from Redis TIME inside the script (unless a test clock is passed), so no
// client clock is involved. The bucket key shares the hash tag of KEYS[1].
const script = LuaScript.fromFile(new URL('./lua/fixed-window.lua', import.meta.url));

export class FixedWindow implements Algorithm {
  readonly name = 'fixed-window';

  constructor(private readonly deps: AlgorithmDeps) {}

  async check(key: string, limit: number, windowSeconds: number): Promise<CheckResult> {
    const now = this.deps.clock?.nowMs() ?? REDIS_TIME;
    const reply = await this.deps.store.execute(script, [`fairly:{${key}}:fw`], [limit, windowSeconds * 1000, now]);
    return parseScriptReply(reply);
  }
}
