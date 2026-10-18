import http from 'node:http';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { digestToken, tokenMatches } from '../../src/api/routes/admin.js';
import { startServer, type RunningServer } from '../server.js';

const TOKEN = 'correct-horse-battery-staple-0123456789';

describe('admin token comparison', () => {
  const expected = digestToken(TOKEN);

  it('accepts only the exact token', () => {
    expect(tokenMatches(TOKEN, expected)).toBe(true);
    expect(tokenMatches(`${TOKEN} `, expected)).toBe(false);
    expect(tokenMatches(` ${TOKEN}`, expected)).toBe(false);
    expect(tokenMatches(TOKEN.toUpperCase(), expected)).toBe(false);
    expect(tokenMatches(TOKEN.slice(0, -1), expected)).toBe(false);
    expect(tokenMatches(`${TOKEN}x`, expected)).toBe(false);
    expect(tokenMatches(`${TOKEN.slice(0, -1)}X`, expected)).toBe(false);
    expect(tokenMatches('', expected)).toBe(false);
  });

  it('rejects values that are not a single string without throwing', () => {
    expect(tokenMatches(undefined, expected)).toBe(false);
    expect(tokenMatches(null, expected)).toBe(false);
    expect(tokenMatches([TOKEN], expected)).toBe(false);
    expect(tokenMatches(42, expected)).toBe(false);
  });

  it('handles tokens of any length and any characters, because it compares fixed-size digests', () => {
    expect(() => tokenMatches('x'.repeat(100_000), expected)).not.toThrow();
    expect(tokenMatches('x'.repeat(100_000), expected)).toBe(false);
    expect(tokenMatches('\u0000\u0001😀', expected)).toBe(false);
    expect(digestToken(TOKEN)).toHaveLength(32);
    expect(digestToken('a')).toHaveLength(32);
    expect(digestToken('a'.repeat(5000))).toHaveLength(32);
  });
});

describe('admin token over HTTP', () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await startServer({ redisUrl: inject('redisUrl'), policies: [], adminToken: TOKEN });
  });
  afterAll(async () => {
    await server.close();
  });

  const status = async (headers: Record<string, string>): Promise<number> =>
    (await fetch(`${server.url}/v1/admin/policies`, { headers })).status;

  it('answers 401 for every wrong, malformed or oversized token and 200 only for the right one', async () => {
    expect(await status({ 'x-admin-token': TOKEN })).toBe(200);
    expect(await status({})).toBe(401);
    expect(await status({ 'x-admin-token': '' })).toBe(401);
    expect(await status({ 'x-admin-token': TOKEN.replace('c', 'C') })).toBe(401);
    expect(await status({ 'x-admin-token': `${TOKEN}${TOKEN}` })).toBe(401);
    expect(await status({ 'x-admin-token': 'x'.repeat(8000) })).toBe(401);
    expect(await status({ authorization: `Bearer ${TOKEN}` })).toBe(401);
  });

  it('answers 401 when the header is repeated, even if one copy is correct', async () => {
    const url = new URL(server.url);
    const code = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: url.hostname, port: url.port, path: '/v1/admin/policies', method: 'GET', headers: { 'x-admin-token': [TOKEN, 'other-token-other-token'] } },
        (res) => {
          res.resume();
          res.on('end', () => {
            resolve(res.statusCode ?? 0);
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(code).toBe(401);
  });

  it('rejects before reading a body, so an unauthenticated client cannot make the server parse one', async () => {
    const response = await fetch(`${server.url}/v1/admin/policies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'wrong-wrong-wrong-wrong' },
      body: '{ this is not json',
    });
    expect(response.status).toBe(401);
  });
});
