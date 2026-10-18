import type { FastifyBaseLogger } from 'fastify';
import { policyDefinitionSchema, policySchema, type Policy, type PolicyDefinition } from '../config/types.js';
import { LuaScript, type RedisStore } from '../store/redis.js';
import { compilePolicies, resolvePolicy, type CompiledPolicy } from './resolve.js';

const seedScript = LuaScript.fromFile(new URL('./lua/policy-seed.lua', import.meta.url));
const writeScript = LuaScript.fromFile(new URL('./lua/policy-write.lua', import.meta.url));

export interface PolicyStoreOptions {
  store: RedisStore;
  logger: FastifyBaseLogger;
  seed: Policy[];
  refreshMs: number;
  keyPrefix?: string;
  onFailure?: (operation: string) => void;
}

function toDefinition(policy: Policy): PolicyDefinition {
  return { route: policy.route, algorithm: policy.algorithm, limit: policy.limit, windowSeconds: policy.windowSeconds, tier: policy.tier };
}

export class PolicyStore {
  private readonly store: RedisStore;
  private readonly logger: FastifyBaseLogger;
  private readonly seed: Policy[];
  private readonly refreshMs: number;
  private readonly hashKey: string;
  private readonly seededKey: string;
  private readonly onFailure: (operation: string) => void;
  private policies = new Map<string, Policy>();
  private compiled: CompiledPolicy[] = [];
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;

  constructor(options: PolicyStoreOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.seed = options.seed;
    this.refreshMs = options.refreshMs;
    const prefix = options.keyPrefix ?? 'fairly:policies';
    this.hashKey = prefix;
    this.seededKey = `${prefix}:seeded`;
    this.onFailure = options.onFailure ?? ((): void => undefined);
    this.setAll(options.seed);
  }

  start(): void {
    this.timer = setInterval(() => {
      void this.refresh().catch((err: unknown) => {
        this.onFailure('policy_refresh');
        this.logger.warn({ err }, 'policy refresh failed, keeping last known policies');
      });
    }, this.refreshMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  resolve(route: string, tier: string | undefined): Policy | undefined {
    return resolvePolicy(this.compiled, route, tier);
  }

  get(name: string): Policy | undefined {
    return this.policies.get(name);
  }

  list(): Policy[] {
    return [...this.policies.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.seedIfEmpty();
      const entries = await this.store.run((redis) => redis.hgetall(this.hashKey));
      const loaded: Policy[] = [];
      for (const [name, raw] of Object.entries(entries)) {
        const policy = this.parseEntry(name, raw);
        if (policy !== undefined) loaded.push(policy);
      }
      this.setAll(loaded);
    } finally {
      this.refreshing = false;
    }
  }

  async create(name: string, definition: PolicyDefinition): Promise<Policy | undefined> {
    const policy: Policy = { ...definition, name };
    const written = await this.write('create', policy);
    return written ? policy : undefined;
  }

  async update(name: string, definition: PolicyDefinition): Promise<Policy | undefined> {
    const policy: Policy = { ...definition, name };
    const written = await this.write('update', policy);
    return written ? policy : undefined;
  }

  async remove(name: string): Promise<boolean> {
    const removed = await this.store.run((redis) => redis.hdel(this.hashKey, name));
    this.policies.delete(name);
    this.recompile();
    return removed === 1;
  }

  private async write(mode: 'create' | 'update', policy: Policy): Promise<boolean> {
    const reply = await this.store.execute(
      writeScript,
      [this.hashKey],
      [mode, policy.name, JSON.stringify(toDefinition(policy))],
    );
    if (reply !== 1) return false;
    this.policies.set(policy.name, policy);
    this.recompile();
    return true;
  }

  private async seedIfEmpty(): Promise<void> {
    const args = this.seed.flatMap((policy) => [policy.name, JSON.stringify(toDefinition(policy))]);
    await this.store.execute(seedScript, [this.hashKey, this.seededKey], args);
  }

  private parseEntry(name: string, raw: string): Policy | undefined {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      this.logger.error({ err, policy: name }, 'stored policy is not valid JSON, ignoring it');
      return undefined;
    }
    const definition = policyDefinitionSchema.safeParse(json);
    if (!definition.success) {
      this.logger.error({ policy: name, issues: definition.error.issues }, 'stored policy is invalid, ignoring it');
      return undefined;
    }
    return policySchema.parse({ ...definition.data, name });
  }

  private setAll(policies: Policy[]): void {
    this.policies = new Map(policies.map((policy) => [policy.name, policy]));
    this.recompile();
  }

  private recompile(): void {
    this.compiled = compilePolicies(this.policies.values());
  }
}
