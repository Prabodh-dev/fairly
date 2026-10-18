import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ALGORITHM_NAMES, type AlgorithmName, type Policy } from '../../src/config/types.js';
import { uniqueKey } from '../helpers.js';
import { postCheck, startServer, type RunningServer } from '../server.js';

const LIMIT = 100;
const REQUESTS = 500;

const policies: Policy[] = ALGORITHM_NAMES.map((algorithm) => ({
  name: algorithm,
  route: algorithm,
  algorithm,
  limit: LIMIT,
  windowSeconds: 3600,
}));

function tally(responses: { status: number }[]): { allowed: number; rejected: number; other: number } {
  const allowed = responses.filter((r) => r.status === 200).length;
  const rejected = responses.filter((r) => r.status === 429).length;
  return { allowed, rejected, other: responses.length - allowed - rejected };
}

describe.each(ALGORITHM_NAMES)('concurrency: %s', (name: AlgorithmName) => {
  let first: RunningServer;
  let second: RunningServer;
  beforeAll(async () => {
    first = await startServer({ redisUrl: inject('redisUrl'), policies, policyPrefix: uniqueKey('policies') });
    second = await startServer({ redisUrl: inject('redisUrl'), policies });
  });
  afterAll(async () => {
    await first.close();
    await second.close();
  });

  it(`allows exactly ${LIMIT} of ${REQUESTS} concurrent requests against one server`, async () => {
    const key = uniqueKey('race');
    const responses = await Promise.all(Array.from({ length: REQUESTS }, () => postCheck(first.url, name, key)));
    expect(tally(responses)).toEqual({ allowed: LIMIT, rejected: REQUESTS - LIMIT, other: 0 });
  });

  it(`allows exactly ${LIMIT} of ${REQUESTS} concurrent requests split across two server instances`, async () => {
    const key = uniqueKey('race');
    const responses = await Promise.all(
      Array.from({ length: REQUESTS }, (_, i) => postCheck(i % 2 === 0 ? first.url : second.url, name, key)),
    );
    expect(tally(responses)).toEqual({ allowed: LIMIT, rejected: REQUESTS - LIMIT, other: 0 });
  });

  it('reports remaining counts that are unique and exact across the allowed requests', async () => {
    const key = uniqueKey('race');
    const responses = await Promise.all(Array.from({ length: REQUESTS }, () => postCheck(first.url, name, key)));
    const remaining = responses
      .filter((r) => r.status === 200)
      .map((r) => r.body.remaining)
      .sort((a, b) => a - b);
    expect(remaining).toEqual(Array.from({ length: LIMIT }, (_, i) => i));
  });
});
