import { readFileSync } from 'node:fs';
import { limitsConfigSchema, type FailurePolicy, type LimitsConfig, type Settings } from './types.js';

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

export function loadLimitsConfig(path: string): LimitsConfig {
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

function parseFailurePolicy(value: string | undefined): FailurePolicy {
  if (value !== 'open' && value !== 'closed') {
    throw new ConfigError(
      `FAIRLY_FAILURE_POLICY must be set to "open" or "closed" (there is no default), got ${value === undefined ? 'nothing' : `"${value}"`}`,
    );
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
    failurePolicy: parseFailurePolicy(env['FAIRLY_FAILURE_POLICY']),
    logLevel: env['LOG_LEVEL'] ?? 'info',
  };
}
