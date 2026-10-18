import { describe, expect, it } from 'vitest';
import { ConfigError, loadLimitsConfig, loadSettings, parseLimitsConfig } from '../../src/config/loader.js';

const valid = { routes: { api: { algorithm: 'token-bucket', limit: 10, windowSeconds: 60 } } };

describe('limits config', () => {
  it('accepts a valid config', () => {
    expect(parseLimitsConfig(valid)).toEqual(valid);
  });

  it('rejects an unknown algorithm and names the valid ones', () => {
    const bad = { routes: { api: { algorithm: 'leaky-bucket', limit: 10, windowSeconds: 60 } } };
    expect(() => parseLimitsConfig(bad)).toThrow(ConfigError);
    expect(() => parseLimitsConfig(bad)).toThrow(/routes\.api\.algorithm: algorithm must be one of: fixed-window, sliding-window-log, sliding-window-counter, token-bucket/);
  });

  it.each([0, -5])('rejects a non-positive limit (%d)', (limit) => {
    const bad = { routes: { api: { algorithm: 'fixed-window', limit, windowSeconds: 60 } } };
    expect(() => parseLimitsConfig(bad)).toThrow(/routes\.api\.limit: limit must be positive/);
  });

  it.each([0, -1])('rejects a non-positive window (%d)', (windowSeconds) => {
    const bad = { routes: { api: { algorithm: 'fixed-window', limit: 5, windowSeconds } } };
    expect(() => parseLimitsConfig(bad)).toThrow(/routes\.api\.windowSeconds: windowSeconds must be positive/);
  });

  it('rejects non-integer and non-numeric values', () => {
    expect(() => parseLimitsConfig({ routes: { api: { algorithm: 'fixed-window', limit: 1.5, windowSeconds: 60 } } })).toThrow(/limit must be an integer/);
    expect(() => parseLimitsConfig({ routes: { api: { algorithm: 'fixed-window', limit: '5', windowSeconds: 60 } } })).toThrow(/limit must be a number/);
  });

  it('rejects missing fields, empty routes, and route names containing a colon', () => {
    expect(() => parseLimitsConfig({ routes: { api: { algorithm: 'fixed-window', limit: 5 } } })).toThrow(/routes\.api\.windowSeconds/);
    expect(() => parseLimitsConfig({ routes: {} })).toThrow(/at least one route/);
    expect(() => parseLimitsConfig({ routes: { 'a:b': valid.routes.api } })).toThrow(/route names may contain only/);
  });

  it('reports unreadable and malformed files', () => {
    expect(() => loadLimitsConfig('/nonexistent/fairly.json')).toThrow(/cannot read limits config/);
    expect(() => loadLimitsConfig(new URL('../../package.json', import.meta.url).pathname)).toThrow(/invalid limits config/);
  });

  it('loads the shipped config file', () => {
    const config = loadLimitsConfig(new URL('../../fairly.config.json', import.meta.url).pathname);
    expect(Object.keys(config.routes)).toContain('demo-token-bucket');
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
