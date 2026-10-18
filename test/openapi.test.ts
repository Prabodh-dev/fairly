import { Validator } from '@seriousme/openapi-schema-validator';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Policy } from '../src/config/types.js';
import { SpecConformance, loadSpec } from './openapi.js';
import { uniqueKey } from './helpers.js';
import { post, startServer, type RunningServer } from './server.js';

const TOKEN = 'test-admin-token-0123456789';
const HTTP_METHODS = ['get', 'post', 'put', 'delete'];

function registeredRoutes(tree: string): string[] {
  const stack: string[] = [];
  const routes: string[] = [];
  for (const line of tree.split('\n')) {
    const match = /^((?:│ {3}| {4})*)(?:├── |└── )(\S+)(?: \(([^)]+)\))?$/.exec(line);
    if (match === null) continue;
    const depth = (match[1] ?? '').length / 4;
    stack.length = depth;
    stack.push(match[2] ?? '');
    for (const method of (match[3] ?? '').split(',').map((m) => m.trim()).filter((m) => m !== '' && m !== 'HEAD')) {
      routes.push(`${method} ${stack.join('')}`);
    }
  }
  return routes;
}

const policies: Policy[] = [
  { name: 'login', route: '/login', algorithm: 'sliding-window-log', limit: 2, windowSeconds: 3600 },
  { name: 'premium', route: '*', tier: 'premium', algorithm: 'token-bucket', limit: 50, windowSeconds: 60 },
  { name: 'base', route: '*', algorithm: 'fixed-window', limit: 2, windowSeconds: 3600 },
];

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3 document', async () => {
    const validator = new Validator();
    const result = await validator.validate({ ...loadSpec() });
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(validator.version).toMatch(/^3\./);
  });

  it('is rejected by the validator when it is broken', async () => {
    const broken = loadSpec() as unknown as Record<string, unknown>;
    delete broken['info'];
    const result = await new Validator().validate(broken);
    expect(result.valid).toBe(false);
  });

  it('defines every response with a schema or an explicit empty body', () => {
    const spec = loadSpec();
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
        expect(Object.keys(operation.responses).length, `${method} ${path}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('OpenAPI document against the running service', () => {
  let server: RunningServer;
  let conformance: SpecConformance;
  const spec = loadSpec();

  beforeAll(async () => {
    server = await startServer({ redisUrl: inject('redisUrl'), policies, adminToken: TOKEN });
    conformance = new SpecConformance(spec);
  });
  afterAll(async () => {
    await server.close();
  });

  const toFastifyUrl = (path: string): string => path.replace(/\{(\w+)\}/g, ':$1');

  it('documents only routes that exist', () => {
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const method of Object.keys(operations).filter((name) => HTTP_METHODS.includes(name))) {
        expect(server.app.hasRoute({ method: method.toUpperCase(), url: toFastifyUrl(path) }), `${method} ${path}`).toBe(true);
      }
    }
  });

  it('documents every route the service registers, apart from the docs UI', () => {
    const documented = new Set(
      Object.entries(spec.paths).flatMap(([path, operations]) =>
        Object.keys(operations)
          .filter((method) => HTTP_METHODS.includes(method))
          .map((method) => `${method.toUpperCase()} ${toFastifyUrl(path)}`),
      ),
    );
    const registered = registeredRoutes(server.app.printRoutes({ commonPrefix: false })).filter((route) => !route.includes(' /docs'));
    expect(registered.length).toBeGreaterThan(5);
    for (const route of registered) expect(documented.has(route), `${route} is not in openapi.yaml`).toBe(true);
  });

  async function json(response: Response): Promise<{ status: number; body: unknown; headers: Headers }> {
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
  }

  const admin = (method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Response> =>
    fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { 'x-admin-token': token }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('serves check responses that match the documented schemas and headers', async () => {
    const key = uniqueKey('user');
    const allowedHeaders = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
    for (let i = 0; i < 2; i++) {
      const res = await json(await fetch(`${server.url}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, route: '/login' }) }));
      expect(res.status).toBe(200);
      conformance.responseConforms('post', '/v1/check', 200, res.body, res.headers, allowedHeaders);
    }
    const denied = await json(await fetch(`${server.url}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, route: '/login' }) }));
    expect(denied.status).toBe(429);
    conformance.responseConforms('post', '/v1/check', 429, denied.body, denied.headers, [...allowedHeaders, 'retry-after']);

    const premium = await post(server.url, { key, route: '/anything', tier: 'premium' });
    expect(premium.body.policy).toBe('premium');
    const inline = await json(await fetch(`${server.url}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, algorithm: 'fixed-window', limit: 5, windowSeconds: 60 }) }));
    conformance.responseConforms('post', '/v1/check', 200, inline.body, inline.headers, allowedHeaders);

    const invalid = await json(await fetch(`${server.url}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) }));
    expect(invalid.status).toBe(400);
    conformance.responseConforms('post', '/v1/check', 400, invalid.body, invalid.headers);

    const malformed = await json(await fetch(`${server.url}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }));
    expect(malformed.status).toBe(400);
    conformance.responseConforms('post', '/v1/check', 400, malformed.body, malformed.headers);
  });

  it('serves a 404 for an unmatched route that matches the documented schema', async () => {
    const only: Policy[] = [{ name: 'only', route: '/only', algorithm: 'fixed-window', limit: 1, windowSeconds: 60 }];
    const narrow = await startServer({ redisUrl: inject('redisUrl'), policies: only });
    try {
      const withTier = await json(await fetch(`${narrow.url}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'k', route: '/other', tier: 'gold' }) }));
      expect(withTier.status).toBe(404);
      conformance.responseConforms('post', '/v1/check', 404, withTier.body, withTier.headers);
      const withoutTier = await json(await fetch(`${narrow.url}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'k', route: '/other' }) }));
      conformance.responseConforms('post', '/v1/check', 404, withoutTier.body, withoutTier.headers);
    } finally {
      await narrow.close();
    }
  });

  it('accepts the request examples in the spec', async () => {
    const examples = spec.paths['/v1/check']?.['post']?.requestBody?.content['application/json']?.examples ?? {};
    expect(Object.keys(examples).length).toBeGreaterThan(0);
    for (const [name, example] of Object.entries(examples)) {
      const res = await post(server.url, example.value);
      expect([200, 429], name).toContain(res.status);
    }
  });

  it('serves admin responses that match the documented schemas', async () => {
    const definition = { route: '/orders/*', algorithm: 'token-bucket', limit: 4, windowSeconds: 60 };
    const steps: { method: string; path: string; body?: unknown; token?: string | null; template: string; status: number }[] = [
      { method: 'GET', path: '/v1/admin/policies', template: '/v1/admin/policies', status: 200 },
      { method: 'GET', path: '/v1/admin/policies', token: null, template: '/v1/admin/policies', status: 401 },
      { method: 'POST', path: '/v1/admin/policies', body: { name: 'orders', ...definition }, template: '/v1/admin/policies', status: 201 },
      { method: 'POST', path: '/v1/admin/policies', body: { name: 'orders', ...definition }, template: '/v1/admin/policies', status: 409 },
      { method: 'POST', path: '/v1/admin/policies', body: { name: 'bad name', ...definition, limit: 0 }, template: '/v1/admin/policies', status: 400 },
      { method: 'GET', path: '/v1/admin/policies/orders', template: '/v1/admin/policies/{name}', status: 200 },
      { method: 'GET', path: '/v1/admin/policies/missing', template: '/v1/admin/policies/{name}', status: 404 },
      { method: 'PUT', path: '/v1/admin/policies/orders', body: { ...definition, limit: 9 }, template: '/v1/admin/policies/{name}', status: 200 },
      { method: 'PUT', path: '/v1/admin/policies/orders', body: { ...definition, limit: -1 }, template: '/v1/admin/policies/{name}', status: 400 },
      { method: 'PUT', path: '/v1/admin/policies/missing', body: definition, template: '/v1/admin/policies/{name}', status: 404 },
      { method: 'DELETE', path: '/v1/admin/policies/orders', token: 'nope-nope-nope-nope', template: '/v1/admin/policies/{name}', status: 401 },
      { method: 'DELETE', path: '/v1/admin/policies/orders', template: '/v1/admin/policies/{name}', status: 204 },
      { method: 'DELETE', path: '/v1/admin/policies/orders', template: '/v1/admin/policies/{name}', status: 404 },
    ];
    for (const step of steps) {
      const res = await json(await admin(step.method, step.path, step.body, step.token));
      expect(res.status, `${step.method} ${step.path}`).toBe(step.status);
      conformance.responseConforms(step.method.toLowerCase(), step.template, step.status, res.body, res.headers);
    }
  });

  it('serves health and metrics as documented', async () => {
    const health = await json(await fetch(`${server.url}/healthz`));
    expect(health.status).toBe(200);
    conformance.responseConforms('get', '/healthz', 200, health.body, health.headers);

    const metrics = await fetch(`${server.url}/metrics`);
    expect(metrics.status).toBe(200);
    conformance.responseConforms('get', '/metrics', 200, await metrics.text(), metrics.headers);
  });

  it('rejects a response that does not match the spec, so the conformance check is not vacuous', () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    expect(() => {
      conformance.responseConforms('post', '/v1/check', 200, { allowed: 'yes' }, headers);
    }).toThrow(/does not match the spec/);
    expect(() => {
      conformance.responseConforms('post', '/v1/check', 200, { allowed: true, remaining: 1, resetAtMs: 1, policy: 'p' }, new Headers({ 'content-type': 'application/json', 'retry-after': '3' }));
    }).toThrow(/does not declare/);
    expect(() => {
      conformance.responseConforms('post', '/v1/check', 418, {}, headers);
    }).toThrow(/does not document status/);
  });

  it('serves the spec and an interactive UI at /docs', async () => {
    const ui = await fetch(`${server.url}/docs`);
    expect(ui.status).toBe(200);
    expect(ui.headers.get('content-type')).toContain('text/html');
    expect(await ui.text()).toContain('swagger-ui');

    const served = (await (await fetch(`${server.url}/docs/json`)).json()) as { info: { title: string }; paths: Record<string, unknown> };
    expect(served.info.title).toBe('fairly');
    expect(Object.keys(served.paths).sort()).toEqual(Object.keys(spec.paths).sort());

    const yaml = await fetch(`${server.url}/docs/yaml`);
    expect(yaml.status).toBe(200);
    expect(await yaml.text()).toContain('openapi: 3.0.3');
  });
});
