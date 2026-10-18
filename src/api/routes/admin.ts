import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { policyDefinitionSchema, policyNameSchema, policySchema } from '../../config/types.js';
import type { PolicyStore } from '../../policy/store.js';

export const ADMIN_TOKEN_HEADER = 'x-admin-token';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function tokenMatches(provided: unknown, expected: Buffer): boolean {
  return typeof provided === 'string' && timingSafeEqual(digest(provided), expected);
}

function invalid(reply: FastifyReply, issues: { message: string }[]): FastifyReply {
  return reply.code(400).send({ error: 'invalid_policy', details: issues.map((issue) => issue.message) });
}

export function registerAdminRoutes(app: FastifyInstance, policies: PolicyStore, adminToken: string): void {
  const expected = digest(adminToken);

  void app.register((admin, _options, done) => {
    admin.addHook('onRequest', async (request, reply) => {
      if (!tokenMatches(request.headers[ADMIN_TOKEN_HEADER], expected)) {
        request.log.warn({ path: request.url, method: request.method }, 'admin request rejected: missing or invalid token');
        return reply.code(401).send({ error: 'unauthorized' });
      }
      return undefined;
    });

    admin.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
      if (err.statusCode !== undefined && err.statusCode < 500) {
        return reply.send(err);
      }
      request.log.error({ err, path: request.url, method: request.method }, 'admin operation failed');
      return reply.code(503).send({ error: 'store_unavailable' });
    });

    admin.get('/v1/admin/policies', () => ({ policies: policies.list() }));

    admin.get<{ Params: { name: string } }>('/v1/admin/policies/:name', async (request, reply) => {
      const policy = policies.get(request.params.name);
      if (policy === undefined) {
        return reply.code(404).send({ error: 'policy_not_found', name: request.params.name });
      }
      return policy;
    });

    admin.post('/v1/admin/policies', async (request, reply) => {
      const parsed = policySchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      const { name, ...definition } = parsed.data;
      const created = await policies.create(name, definition);
      if (created === undefined) {
        return reply.code(409).send({ error: 'policy_exists', name });
      }
      request.log.info({ policy: name, action: 'create' }, 'policy changed');
      return reply.code(201).send(created);
    });

    admin.put<{ Params: { name: string } }>('/v1/admin/policies/:name', async (request, reply) => {
      const name = policyNameSchema.safeParse(request.params.name);
      if (!name.success) return invalid(reply, name.error.issues);
      const parsed = policyDefinitionSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, parsed.error.issues);
      const updated = await policies.update(name.data, parsed.data);
      if (updated === undefined) {
        return reply.code(404).send({ error: 'policy_not_found', name: name.data });
      }
      request.log.info({ policy: name.data, action: 'update' }, 'policy changed');
      return updated;
    });

    admin.delete<{ Params: { name: string } }>('/v1/admin/policies/:name', async (request, reply) => {
      const removed = await policies.remove(request.params.name);
      if (!removed) {
        return reply.code(404).send({ error: 'policy_not_found', name: request.params.name });
      }
      request.log.info({ policy: request.params.name, action: 'delete' }, 'policy changed');
      return reply.code(204).send();
    });

    done();
  });
}
