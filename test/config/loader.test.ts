import { describe, expect, it } from 'vitest';
import { ConfigError, loadLimitsConfig, loadSettings, parseLimitsConfig } from '../../src/config/loader.js';

const policy = { name: 'api', route: '/api/*', algorithm: 'token-bucket', limit: 10, windowSeconds: 60 };
const valid = { policies: [policy] };

function withPolicy(overrides: Record<string, unknown>): unknown {
  return { policies: [{ ...policy, ...overrides }] };
}

describe('limits config', () => {
  it('accepts a valid config and defaults the route to a wildcard', () => {
    expect(parseLimitsConfig(valid)).toEqual(valid);
    const withoutRoute = { name: 'api', algorithm: 'token-bucket', limit: 10, windowSeconds: 60 };
    expect(parseLimitsConfig({ policies: [withoutRoute] }).policies[0]?.route).toBe('*');
  });

  it('accepts an empty policy list', () => {
    expect(parseLimitsConfig({ policies: [] })).toEqual({ policies: [] });
  });

  it('rejects an unknown algorithm and names the valid ones', () => {
    const bad = withPolicy({ algorithm: 'leaky-bucket' });
    expect(() => parseLimitsConfig(bad)).toThrow(ConfigError);
    expect(() => parseLimitsConfig(bad)).toThrow(/policies\.0\.algorithm: algorithm must be one of: fixed-window, sliding-window-log, sliding-window-counter, token-bucket/);
  });

  it.each([0, -5])('rejects a non-positive limit (%d)', (limit) => {
    expect(() => parseLimitsConfig(withPolicy({ limit }))).toThrow(/policies\.0\.limit: limit must be positive/);
  });

  it.each([0, -1])('rejects a non-positive window (%d)', (windowSeconds) => {
    expect(() => parseLimitsConfig(withPolicy({ windowSeconds }))).toThrow(/policies\.0\.windowSeconds: windowSeconds must be positive/);
  });

  it('rejects non-integer and non-numeric values', () => {
    expect(() => parseLimitsConfig(withPolicy({ limit: 1.5 }))).toThrow(/limit must be an integer/);
    expect(() => parseLimitsConfig(withPolicy({ limit: '5' }))).toThrow(/limit must be a number/);
  });

  it('rejects bad names and tiers, empty routes and duplicate names', () => {
    expect(() => parseLimitsConfig(withPolicy({ name: 'a:b' }))).toThrow(/name may contain only/);
    expect(() => parseLimitsConfig(withPolicy({ tier: 'pre mium' }))).toThrow(/tier may contain only/);
    expect(() => parseLimitsConfig(withPolicy({ route: '' }))).toThrow(/route must not be empty/);
    expect(() => parseLimitsConfig({ policies: [policy, policy] })).toThrow(/policy names must be unique/);
    expect(() => parseLimitsConfig({ routes: {} })).toThrow(/policies/);
  });

  it('reports unreadable and malformed files', () => {
    expect(() => loadLimitsConfig('/nonexistent/fairly.json')).toThrow(/cannot read limits config/);
    expect(() => loadLimitsConfig(new URL('../../package.json', import.meta.url).pathname)).toThrow(/invalid limits config/);
  });

  it('loads the shipped config file', () => {
    const config = loadLimitsConfig(new URL('../../fairly.config.json', import.meta.url).pathname);
    expect(config.policies.map((p) => p.name)).toContain('demo-token-bucket');
  });
});

describe('settings', () => {
  it('requires an explicit failure policy', () => {
    expect(() => loadSettings({})).toThrow(/FAIRLY_FAILURE_POLICY must be set/);
    expect(() => loadSettings({ FAIRLY_FAILURE_POLICY: 'maybe' })).toThrow(/"maybe"/);
    expect(loadSettings({ FAIRLY_FAILURE_POLICY: 'open' }).failurePolicy).toBe('open');
  });

  it('rejects a non-positive port', () => {
    expect(() => loadSettings({ FAIRLY_FAILURE_POLICY: 'closed', PORT: '0' })).toThrow(/PORT must be a positive integer/);
  });
});
