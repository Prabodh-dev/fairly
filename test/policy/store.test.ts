import { afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import pino from 'pino';
import type { Policy, PolicyDefinition } from '../../src/config/types.js';
import { PolicyStore } from '../../src/policy/store.js';
import type { RedisStore } from '../../src/store/redis.js';
import { connectStore, uniqueKey } from '../helpers.js';

const seed: Policy[] = [
  { name: 'base', route: '*', algorithm: 'fixed-window', limit: 10, windowSeconds: 60 },
  { name: 'login', route: '/login', algorithm: 'sliding-window-log', limit: 5, windowSeconds: 300 },
];
const extra: PolicyDefinition = { route: '/extra', algorithm: 'token-bucket', limit: 3, windowSeconds: 30 };

describe('policy store', () => {
  let store: RedisStore;
  const stores: PolicyStore[] = [];
  beforeAll(async () => {
    store = await connectStore(inject('redisUrl'));
  });
  afterEach(() => {
    for (const s of stores.splice(0)) s.stop();
  });

  function create(prefix: string, policies: Policy[] = seed): PolicyStore {
    const created = new PolicyStore({ store, logger: pino({ level: 'silent' }), seed: policies, refreshMs: 50, keyPrefix: prefix });
    stores.push(created);
    return created;
  }

  it('serves the config file policies before Redis has been read', () => {
    const policies = create(uniqueKey('p'));
    expect(policies.list().map((p) => p.name)).toEqual(['base', 'login']);
    expect(policies.resolve('/login', undefined)?.name).toBe('login');
  });

  it('seeds an empty Redis once and then treats Redis as the source of truth', async () => {
    const prefix = uniqueKey('p');
    const first = create(prefix);
    await first.refresh();
    expect(await first.remove('login')).toBe(true);

    const second = create(prefix);
    await second.refresh();
    expect(second.list().map((p) => p.name)).toEqual(['base']);
  });

  it('does not overwrite policies that already exist in Redis when seeding', async () => {
    const prefix = uniqueKey('p');
    const first = create(prefix, []);
    await first.refresh();
    await first.create('base', { route: '*', algorithm: 'token-bucket', limit: 99, windowSeconds: 10 });

    const second = create(prefix, seed);
    await second.refresh();
    expect(second.get('base')?.limit).toBe(99);
    expect(second.get('login')).toBeUndefined();
  });

  it('creates, updates and removes policies and reports conflicts', async () => {
    const policies = create(uniqueKey('p'));
    await policies.refresh();

    expect((await policies.create('extra', extra))?.limit).toBe(3);
    expect(await policies.create('extra', extra)).toBeUndefined();
    expect(policies.resolve('/extra', undefined)?.name).toBe('extra');

    expect((await policies.update('extra', { ...extra, limit: 7 }))?.limit).toBe(7);
    expect(policies.get('extra')?.limit).toBe(7);
    expect(await policies.update('missing', extra)).toBeUndefined();

    expect(await policies.remove('extra')).toBe(true);
    expect(await policies.remove('extra')).toBe(false);
    expect(policies.resolve('/extra', undefined)?.name).toBe('base');
  });

  it('propagates changes to another instance on its next refresh', async () => {
    const prefix = uniqueKey('p');
    const a = create(prefix);
    const b = create(prefix);
    await a.refresh();
    await b.refresh();
    b.start();

    await a.create('extra', extra);
    await a.update('base', { route: '*', algorithm: 'fixed-window', limit: 11, windowSeconds: 60 });
    await a.remove('login');

    await expect.poll(() => b.get('extra')?.limit).toBe(3);
    expect(b.get('base')?.limit).toBe(11);
    expect(b.get('login')).toBeUndefined();
  });

  it('keeps writes made by another instance visible to concurrent creators exactly once', async () => {
    const prefix = uniqueKey('p');
    const a = create(prefix);
    const b = create(prefix);
    await a.refresh();
    const results = await Promise.all([a.create('race', extra), b.create('race', extra), a.create('race', extra)]);
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
  });

  it('ignores a stored entry that is not a valid policy and keeps the rest', async () => {
    const prefix = uniqueKey('p');
    const policies = create(prefix);
    await policies.refresh();
    await store.run((redis) => redis.hset(prefix, 'broken', '{"limit":-1}', 'garbled', 'not json'));
    await policies.refresh();
    expect(policies.list().map((p) => p.name)).toEqual(['base', 'login']);
  });
});
