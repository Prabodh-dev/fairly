import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadLimitsConfig, loadSettings, parseLimitsConfig, toFilePath } from '../../src/config/loader.js';

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

  it('rejects limits and windows above the supported maximum', () => {
    expect(() => parseLimitsConfig(withPolicy({ limit: 1_000_000_001 }))).toThrow(/limit must be at most 1000000000/);
    expect(() => parseLimitsConfig(withPolicy({ windowSeconds: 31_536_001 }))).toThrow(/windowSeconds must be at most 31536000/);
    expect(() => parseLimitsConfig(withPolicy({ limit: Number.MAX_SAFE_INTEGER }))).toThrow(/limit must be at most/);
    expect(parseLimitsConfig(withPolicy({ limit: 1_000_000_000, windowSeconds: 9007 })).policies).toHaveLength(1);
    expect(parseLimitsConfig(withPolicy({ limit: 1, windowSeconds: 31_536_000 })).policies).toHaveLength(1);
  });

  it('rejects a limit and window whose product in milliseconds would lose integer precision', () => {
    expect(() => parseLimitsConfig(withPolicy({ limit: 1_000_000_000, windowSeconds: 9008 }))).toThrow(
      /windowSeconds: limit multiplied by windowSeconds in milliseconds must not exceed 9007199254740991/,
    );
    expect(() => parseLimitsConfig(withPolicy({ limit: 1_000_000, windowSeconds: 9_008_000 }))).toThrow(/must not exceed/);
    expect(parseLimitsConfig(withPolicy({ limit: 1_000_000, windowSeconds: 9_007_199 })).policies).toHaveLength(1);
  });

  it('reports unreadable and malformed files', () => {
    expect(() => loadLimitsConfig('/nonexistent/fairly.json')).toThrow(/cannot read limits config/);
    expect(() => loadLimitsConfig(new URL('../../package.json', import.meta.url))).toThrow(/invalid limits config/);
  });

  it('loads the shipped config file', () => {
    const config = loadLimitsConfig(new URL('../../fairly.config.json', import.meta.url));
    expect(config.policies.map((p) => p.name)).toContain('demo-token-bucket');
  });

  it('loads the same file from a URL object, a file URL string and a plain path', () => {
    const url = new URL('../../fairly.config.json', import.meta.url);
    const fromUrl = loadLimitsConfig(url);
    expect(loadLimitsConfig(url.href)).toEqual(fromUrl);
    expect(loadLimitsConfig(fileURLToPath(url))).toEqual(fromUrl);
  });

  it('reports the resolved filesystem path, not the URL, when a file URL cannot be read', () => {
    const missing = new URL('../../does-not-exist.json', import.meta.url);
    expect(() => loadLimitsConfig(missing)).toThrow(`cannot read limits config at ${fileURLToPath(missing)}`);
  });
});

describe('toFilePath', () => {
  const windowsUrl = 'file:///C:/Prabodh/Projects/fairly/fairly.config.json';
  const windowsPath = 'C:\\Prabodh\\Projects\\fairly\\fairly.config.json';

  it('turns a Windows file URL string into a drive-letter path without a doubled drive', () => {
    expect(toFilePath(windowsUrl, { windows: true })).toBe(windowsPath);
  });

  it('turns a Windows file URL object into the same drive-letter path', () => {
    expect(toFilePath(new URL(windowsUrl), { windows: true })).toBe(windowsPath);
  });

  it('shows why URL.pathname is wrong for Windows: it keeps the leading slash that makes C:\\C:\\', () => {
    expect(new URL(windowsUrl).pathname).toBe('/C:/Prabodh/Projects/fairly/fairly.config.json');
    expect(path.win32.resolve('C:\\work', new URL(windowsUrl).pathname)).toBe('C:\\C:\\Prabodh\\Projects\\fairly\\fairly.config.json');
    expect(path.win32.resolve('C:\\work', toFilePath(windowsUrl, { windows: true }))).toBe(windowsPath);
  });

  it('handles Windows UNC file URLs and percent-encoded characters', () => {
    expect(toFilePath('file://server/share/fairly/config.json', { windows: true })).toBe('\\\\server\\share\\fairly\\config.json');
    expect(toFilePath('file:///C:/My%20Projects/fairly/config.json', { windows: true })).toBe('C:\\My Projects\\fairly\\config.json');
  });

  it('turns POSIX file URLs into POSIX paths and decodes percent-encoding', () => {
    expect(toFilePath('file:///home/user/fairly/fairly.config.json', { windows: false })).toBe('/home/user/fairly/fairly.config.json');
    expect(toFilePath(new URL('file:///home/user/my%20dir/fairly.config.json'), { windows: false })).toBe('/home/user/my dir/fairly.config.json');
  });

  it('rejects a file URL that cannot be a path on the target platform', () => {
    expect(() => toFilePath('file://server/share/x.json', { windows: false })).toThrow();
    expect(() => toFilePath('file:///C:/x%2Fy.json', { windows: false })).toThrow();
  });

  it('returns plain Windows, POSIX and relative paths unchanged', () => {
    expect(toFilePath('C:\\Prabodh\\Projects\\fairly\\fairly.config.json')).toBe('C:\\Prabodh\\Projects\\fairly\\fairly.config.json');
    expect(toFilePath('/home/user/fairly/fairly.config.json')).toBe('/home/user/fairly/fairly.config.json');
    expect(toFilePath('fairly.config.json')).toBe('fairly.config.json');
    expect(toFilePath('.\\config\\fairly.config.json')).toBe('.\\config\\fairly.config.json');
  });

  it('uses the platform default when no option is given', () => {
    const url = new URL('../../fairly.config.json', import.meta.url);
    expect(toFilePath(url)).toBe(fileURLToPath(url));
  });
});

describe('settings', () => {
  it('defaults the failure mode to fail-open', () => {
    expect(loadSettings({}).failureMode).toBe('fail-open');
  });

  it('accepts both failure modes and rejects anything else', () => {
    expect(loadSettings({ FAIRLY_FAILURE_MODE: 'fail-closed' }).failureMode).toBe('fail-closed');
    expect(loadSettings({ FAIRLY_FAILURE_MODE: 'fail-open' }).failureMode).toBe('fail-open');
    expect(() => loadSettings({ FAIRLY_FAILURE_MODE: 'closed' })).toThrow(/must be one of: fail-open, fail-closed, got "closed"/);
  });

  it('refuses the old failure policy variable instead of silently ignoring it', () => {
    expect(() => loadSettings({ FAIRLY_FAILURE_POLICY: 'closed' })).toThrow(/replaced by FAIRLY_FAILURE_MODE/);
  });

  it('rejects values outside the range the runtime can honor', () => {
    expect(loadSettings({ PORT: '65535' }).port).toBe(65535);
    expect(() => loadSettings({ PORT: '65536' })).toThrow(/PORT must be a positive integer no greater than 65535/);
    expect(loadSettings({ REDIS_COMMAND_TIMEOUT_MS: '2147483647' }).redisCommandTimeoutMs).toBe(2_147_483_647);
    expect(() => loadSettings({ REDIS_COMMAND_TIMEOUT_MS: '2147483648' })).toThrow(/REDIS_COMMAND_TIMEOUT_MS must be a positive integer no greater than 2147483647/);
    expect(() => loadSettings({ POLICY_REFRESH_MS: '99999999999' })).toThrow(/POLICY_REFRESH_MS/);
    expect(() => loadSettings({ FAIRLY_SHUTDOWN_TIMEOUT_MS: '3000000000' })).toThrow(/FAIRLY_SHUTDOWN_TIMEOUT_MS/);
    expect(() => loadSettings({ FAIRLY_FAIL_CLOSED_RETRY_AFTER_SECONDS: '86401' })).toThrow(/FAIRLY_FAIL_CLOSED_RETRY_AFTER_SECONDS/);
  });

  it('accepts plain decimal integers only', () => {
    for (const value of ['0x1F90', '1e3', ' 8080', '8080 ', '+8080', '8080.0', '-1', '', 'abc', '١٢٣']) {
      expect(() => loadSettings({ PORT: value }), JSON.stringify(value)).toThrow(/PORT must be a positive integer/);
    }
    expect(loadSettings({ PORT: '08080' }).port).toBe(8080);
  });

  it('validates the log level and the Redis URL instead of failing later', () => {
    expect(loadSettings({ LOG_LEVEL: 'silent' }).logLevel).toBe('silent');
    expect(() => loadSettings({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL must be one of: fatal, error, warn, info, debug, trace, silent, got "loud"/);
    expect(loadSettings({ REDIS_URL: 'rediss://:secret@cache.example.com:6380/2' }).redisUrl).toBe('rediss://:secret@cache.example.com:6380/2');
    for (const value of ['garbage', 'localhost:6379', 'http://localhost:6379', 'redis', '']) {
      expect(() => loadSettings({ REDIS_URL: value }), JSON.stringify(value)).toThrow(/REDIS_URL must be a redis:\/\/ or rediss:\/\/ URL/);
    }
  });

  it('rejects a non-positive port or timeout', () => {
    expect(() => loadSettings({ PORT: '0' })).toThrow(/PORT must be a positive integer/);
    expect(() => loadSettings({ REDIS_COMMAND_TIMEOUT_MS: '-5' })).toThrow(/REDIS_COMMAND_TIMEOUT_MS must be a positive integer/);
  });

  it('defaults the shutdown timeout to 10 seconds and rejects a non-positive value', () => {
    expect(loadSettings({}).shutdownTimeoutMs).toBe(10_000);
    expect(loadSettings({ FAIRLY_SHUTDOWN_TIMEOUT_MS: '2500' }).shutdownTimeoutMs).toBe(2500);
    expect(() => loadSettings({ FAIRLY_SHUTDOWN_TIMEOUT_MS: '0' })).toThrow(/FAIRLY_SHUTDOWN_TIMEOUT_MS must be a positive integer/);
  });

  it('requires an admin token of at least 16 characters when one is set', () => {
    expect(loadSettings({}).adminToken).toBeUndefined();
    expect(() => loadSettings({ FAIRLY_ADMIN_TOKEN: 'short' })).toThrow(/at least 16 characters/);
    expect(loadSettings({ FAIRLY_ADMIN_TOKEN: 'a-long-enough-token' }).adminToken).toBe('a-long-enough-token');
  });
});
