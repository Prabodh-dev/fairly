import { describe, expect, it } from 'vitest';
import type { Policy } from '../../src/config/types.js';
import { compilePolicies, resolvePolicy } from '../../src/policy/resolve.js';

function policy(name: string, route: string, tier?: string): Policy {
  return tier === undefined
    ? { name, route, algorithm: 'fixed-window', limit: 1, windowSeconds: 60 }
    : { name, route, tier, algorithm: 'fixed-window', limit: 1, windowSeconds: 60 };
}

function resolveName(policies: Policy[], route: string, tier?: string): string | undefined {
  return resolvePolicy(compilePolicies(policies), route, tier)?.name;
}

describe('policy resolution', () => {
  it('matches an exact route', () => {
    expect(resolveName([policy('login', '/login')], '/login')).toBe('login');
    expect(resolveName([policy('login', '/login')], '/login/x')).toBeUndefined();
  });

  it('matches wildcard patterns across the whole route', () => {
    const policies = [policy('api', '/api/*')];
    expect(resolveName(policies, '/api/orders/17')).toBe('api');
    expect(resolveName(policies, '/api/')).toBe('api');
    expect(resolveName(policies, '/apix')).toBeUndefined();
    expect(resolveName([policy('mid', '/a/*/c')], '/a/b/c')).toBe('mid');
    expect(resolveName([policy('mid', '/a/*/c')], '/a/b/d')).toBeUndefined();
  });

  it('treats regex characters in a route literally', () => {
    expect(resolveName([policy('dot', '/v1.0/(x)')], '/v1.0/(x)')).toBe('dot');
    expect(resolveName([policy('dot', '/v1.0/(x)')], '/v1x0/(x)')).toBeUndefined();
  });

  it('prefers an exact route over any wildcard', () => {
    const policies = [policy('all', '*'), policy('api', '/api/*'), policy('exact', '/api/orders')];
    expect(resolveName(policies, '/api/orders')).toBe('exact');
  });

  it('prefers the wildcard with more literal characters', () => {
    const policies = [policy('all', '*'), policy('api', '/api/*'), policy('v1', '/api/v1/*')];
    expect(resolveName(policies, '/api/v1/orders')).toBe('v1');
    expect(resolveName(policies, '/api/v2/orders')).toBe('api');
    expect(resolveName(policies, '/health')).toBe('all');
  });

  it('prefers a tier match over no tier for the same route pattern', () => {
    const policies = [policy('base', '*'), policy('premium', '*', 'premium')];
    expect(resolveName(policies, '/x', 'premium')).toBe('premium');
    expect(resolveName(policies, '/x', 'free')).toBe('base');
    expect(resolveName(policies, '/x')).toBe('base');
  });

  it('does not let a tier policy beat a more specific route', () => {
    const policies = [policy('login', '/login'), policy('premium', '*', 'premium')];
    expect(resolveName(policies, '/login', 'premium')).toBe('login');
    expect(resolveName(policies, '/other', 'premium')).toBe('premium');
  });

  it('ignores a tier policy when the request tier differs or is absent', () => {
    const policies = [policy('premium-only', '/x', 'premium')];
    expect(resolveName(policies, '/x', 'free')).toBeUndefined();
    expect(resolveName(policies, '/x')).toBeUndefined();
  });

  it('breaks exact ties by policy name', () => {
    const policies = [policy('b', '/x'), policy('a', '/x')];
    expect(resolveName(policies, '/x')).toBe('a');
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveName([], '/x')).toBeUndefined();
  });
});
