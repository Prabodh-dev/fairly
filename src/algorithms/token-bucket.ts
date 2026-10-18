import { LuaScript } from '../store/redis.js';
import { parseScriptReply, REDIS_TIME, type Algorithm, type AlgorithmDeps, type CheckResult } from './types.js';

// Atomic because reading the stored balance, the refill computation, the decision, and writing
// the new balance all run inside one Lua execution. The elapsed time used for refill is taken
// from Redis TIME inside the script (unless a test clock is passed), so client clock skew and
// request reordering cannot grant or lose tokens.
const script = LuaScript.fromFile(new URL('./lua/token-bucket.lua', import.meta.url));

export class TokenBucket implements Algorithm {
  readonly name = 'token-bucket';

  constructor(private readonly deps: AlgorithmDeps) {}

  async check(key: string, limit: number, windowSeconds: number): Promise<CheckResult> {
    const now = this.deps.clock?.nowMs() ?? REDIS_TIME;
    const reply = await this.deps.store.execute(script, [`fairly:{${key}}:tb`], [limit, windowSeconds * 1000, now]);
    return parseScriptReply(reply);
  }
}
