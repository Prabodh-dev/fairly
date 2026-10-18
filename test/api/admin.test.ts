import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Policy } from '../../src/config/types.js';
import { uniqueKey } from '../helpers.js';
import { postCheck, startServer, type RunningServer } from '../server.js';

const TOKEN = 'test-admin-token-0123456789';
const seed: Policy[] = [{ name: 'base', route: '*', algorithm: 'fixed-window', limit: 2, windowSeconds: 3600 }];
const definition = { route: '/orders/*', algorithm: 'token-bucket', limit: 4, windowSeconds: 3600 };

async function admin(
  server: RunningServer,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token !== null) headers['x-admin-token'] = token;
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

describe('admin API', () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await startServer({ redisUrl: inject('redisUrl'), policies: seed, adminToken: TOKEN });
  });
  afterAll(async () => {
    await server.close();
  });

  it('rejects requests with a missing or wrong token on every endpoint', async () => {
    const calls: [string, string, unknown?][] = [
      ['GET', '/v1/admin/policies'],
      ['GET', '/v1/admin/policies/base'],
      ['POST', '/v1/admin/policies', { name: 'x', ...definition }],
      ['PUT', '/v1/admin/policies/base', definition],
      ['DELETE', '/v1/admin/policies/base'],
    ];
    for (const [method, path, body] of calls) {
      expect((await admin(server, method, path, body, null)).status, `${method} ${path} without token`).toBe(401);
      expect((await admin(server, method, path, body, 'wrong-token-wrong-token')).status, `${method} ${path} wrong token`).toBe(401);
      expect((await admin(server, method, path, body, TOKEN.slice(0, -1))).status, `${method} ${path} prefix`).toBe(401);
    }
    expect(server.policies.get('base')?.limit).toBe(2);
  });

  it('lists and fetches policies', async () => {
    const list = await admin(server, 'GET', '/v1/admin/policies');
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ policies: [{ name: 'base', route: '*', algorithm: 'fixed-window', limit: 2, windowSeconds: 3600 }] });

    const one = await admin(server, 'GET', '/v1/admin/policies/base');
    expect(one.status).toBe(200);
    expect((await admin(server, 'GET', '/v1/admin/policies/nope')).status).toBe(404);
  });

  it('creates, updates and deletes a policy, and checks follow each change immediately', async () => {
    const name = uniqueKey('orders').replace(/[^A-Za-z0-9_.-]/g, '');
    const key = uniqueKey('user');

    expect((await postCheck(server.url, '/orders/1', key)).body).toMatchObject({ policy: 'base' });

    const created = await admin(server, 'POST', '/v1/admin/policies', { name, ...definition });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ name, ...definition });
    expect((await postCheck(server.url, '/orders/1', key)).body).toMatchObject({ policy: name, remaining: 3 });

    expect((await admin(server, 'POST', '/v1/admin/policies', { name, ...definition })).status).toBe(409);

    const updated = await admin(server, 'PUT', `/v1/admin/policies/${name}`, { ...definition, limit: 50 });
    expect(updated.status).toBe(200);
    expect(updated.body).toEqual({ name, ...definition, limit: 50 });
    const afterUpdate = await postCheck(server.url, '/orders/2', uniqueKey('user'));
    expect(afterUpdate.headers.get('x-ratelimit-limit')).toBe('50');

    const removed = await admin(server, 'DELETE', `/v1/admin/policies/${name}`);
    expect(removed.status).toBe(204);
    expect((await postCheck(server.url, '/orders/1', key)).body).toMatchObject({ policy: 'base' });
    expect((await admin(server, 'DELETE', `/v1/admin/policies/${name}`)).status).toBe(404);
    expect((await admin(server, 'PUT', `/v1/admin/policies/${name}`, definition)).status).toBe(404);
  });

  it('validates request bodies with clear errors', async () => {
    const bad = await admin(server, 'POST', '/v1/admin/policies', { name: 'bad', ...definition, algorithm: 'leaky-bucket', limit: 0 });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('algorithm must be one of');
    expect(JSON.stringify(bad.body)).toContain('limit must be positive');

    expect((await admin(server, 'POST', '/v1/admin/policies', { name: 'has space', ...definition })).status).toBe(400);
    expect((await admin(server, 'POST', '/v1/admin/policies', definition)).status).toBe(400);
    expect((await admin(server, 'PUT', '/v1/admin/policies/base', { ...definition, windowSeconds: -1 })).status).toBe(400);
    expect(server.policies.get('bad')).toBeUndefined();
  });

  it('keeps the quota state when only the limit of a policy changes', async () => {
    const name = uniqueKey('state').replace(/[^A-Za-z0-9_.-]/g, '');
    const key = uniqueKey('user');
    await admin(server, 'POST', '/v1/admin/policies', { name, route: '/state', algorithm: 'fixed-window', limit: 3, windowSeconds: 3600 });
    await postCheck(server.url, '/state', key);
    await postCheck(server.url, '/state', key);
    await admin(server, 'PUT', `/v1/admin/policies/${name}`, { route: '/state', algorithm: 'fixed-window', limit: 5, windowSeconds: 3600 });
    expect((await postCheck(server.url, '/state', key)).body.remaining).toBe(2);
  });
});

describe('admin API without a configured token', () => {
  it('is not exposed', async () => {
    const server = await startServer({ redisUrl: inject('redisUrl'), policies: seed });
    try {
      expect((await admin(server, 'GET', '/v1/admin/policies')).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe('admin changes across instances', () => {
  it('reach a second instance sharing the same Redis within its refresh interval', async () => {
    const prefix = uniqueKey('policies');
    const a = await startServer({ redisUrl: inject('redisUrl'), policies: seed, adminToken: TOKEN, policyPrefix: prefix, policyRefreshMs: 50 });
    const b = await startServer({ redisUrl: inject('redisUrl'), policies: seed, adminToken: TOKEN, policyPrefix: prefix, policyRefreshMs: 50 });
    try {
      const key = uniqueKey('user');
      expect((await postCheck(b.url, '/shared', key)).body).toMatchObject({ policy: 'base' });

      expect((await admin(a, 'POST', '/v1/admin/policies', { name: 'shared', route: '/shared', algorithm: 'fixed-window', limit: 1, windowSeconds: 3600 })).status).toBe(201);
      await expect.poll(async () => (await postCheck(b.url, '/shared', uniqueKey('user'))).body).toMatchObject({ policy: 'shared' });

      expect((await postCheck(b.url, '/shared', key)).status).toBe(200);
      expect((await postCheck(a.url, '/shared', key)).status).toBe(429);

      expect((await admin(b, 'DELETE', '/v1/admin/policies/shared')).status).toBe(204);
      await expect.poll(() => a.policies.get('shared')).toBeUndefined();
    } finally {
      await a.close();
      await b.close();
    }
  });
});
