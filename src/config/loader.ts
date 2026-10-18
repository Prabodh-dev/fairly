import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { limitsConfigSchema, FAILURE_MODES, type FailureMode, type LimitsConfig, type Settings } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseLimitsConfig(raw: unknown): LimitsConfig {
  const result = limitsConfigSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`invalid limits config: ${details}`);
  }
  return result.data;
}

export interface FilePathOptions {
  windows?: boolean;
}

export function toFilePath(input: string | URL, options: FilePathOptions = {}): string {
  const fileUrlOptions = options.windows === undefined ? undefined : { windows: options.windows };
  if (input instanceof URL) {
    return fileURLToPath(input, fileUrlOptions);
  }
  if (input.startsWith('file:')) {
    return fileURLToPath(input, fileUrlOptions);
  }
  return input;
}

export function loadLimitsConfig(input: string | URL): LimitsConfig {
  const path = toFilePath(input);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read limits config at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`limits config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseLimitsConfig(raw);
}

function parsePositiveInt(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseFailureMode(env: NodeJS.ProcessEnv): FailureMode {
  if (env['FAIRLY_FAILURE_POLICY'] !== undefined) {
    throw new ConfigError('FAIRLY_FAILURE_POLICY has been replaced by FAIRLY_FAILURE_MODE (fail-open or fail-closed)');
  }
  const value = env['FAIRLY_FAILURE_MODE'] ?? 'fail-open';
  const mode = FAILURE_MODES.find((candidate) => candidate === value);
  if (mode === undefined) {
    throw new ConfigError(`FAIRLY_FAILURE_MODE must be one of: ${FAILURE_MODES.join(', ')}, got "${value}"`);
  }
  return mode;
}

function parseAdminToken(value: string | undefined): string | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value.length < 16) {
    throw new ConfigError('FAIRLY_ADMIN_TOKEN must be at least 16 characters');
  }
  return value;
}

export function loadSettings(env: NodeJS.ProcessEnv): Settings {
  return {
    port: parsePositiveInt('PORT', env['PORT'] ?? '8080'),
    host: env['HOST'] ?? '0.0.0.0',
    redisUrl: env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
    redisCommandTimeoutMs: parsePositiveInt('REDIS_COMMAND_TIMEOUT_MS', env['REDIS_COMMAND_TIMEOUT_MS'] ?? '1000'),
    configPath: env['FAIRLY_CONFIG'] ?? 'fairly.config.json',
    failureMode: parseFailureMode(env),
    logLevel: env['LOG_LEVEL'] ?? 'info',
    policyRefreshMs: parsePositiveInt('POLICY_REFRESH_MS', env['POLICY_REFRESH_MS'] ?? '2000'),
    failClosedRetryAfterSeconds: parsePositiveInt(
      'FAIRLY_FAIL_CLOSED_RETRY_AFTER_SECONDS',
      env['FAIRLY_FAIL_CLOSED_RETRY_AFTER_SECONDS'] ?? '1',
    ),
    adminToken: parseAdminToken(env['FAIRLY_ADMIN_TOKEN']),
  };
}
