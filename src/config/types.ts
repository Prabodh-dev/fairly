import { z } from 'zod';

export const ALGORITHM_NAMES = [
  'fixed-window',
  'sliding-window-log',
  'sliding-window-counter',
  'token-bucket',
] as const;

export type AlgorithmName = (typeof ALGORITHM_NAMES)[number];

export const limitSchema = z.object({
  algorithm: z.enum(ALGORITHM_NAMES, {
    error: `algorithm must be one of: ${ALGORITHM_NAMES.join(', ')}`,
  }),
  limit: z.number({ error: 'limit must be a number' }).int('limit must be an integer').positive('limit must be positive'),
  windowSeconds: z
    .number({ error: 'windowSeconds must be a number' })
    .int('windowSeconds must be an integer')
    .positive('windowSeconds must be positive'),
});

export type LimitSpec = z.infer<typeof limitSchema>;

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export const policyDefinitionSchema = limitSchema.extend({
  route: z.string().min(1, 'route must not be empty').max(256, 'route must be at most 256 characters').default('*'),
  tier: z
    .string()
    .regex(NAME_PATTERN, 'tier may contain only letters, digits, underscore, dot and hyphen')
    .max(64, 'tier must be at most 64 characters')
    .optional(),
});

export type PolicyDefinition = z.infer<typeof policyDefinitionSchema>;

export const policyNameSchema = z
  .string()
  .regex(NAME_PATTERN, 'name may contain only letters, digits, underscore, dot and hyphen')
  .max(64, 'name must be at most 64 characters');

export const policySchema = policyDefinitionSchema.extend({ name: policyNameSchema });

export type Policy = z.infer<typeof policySchema>;

export const limitsConfigSchema = z.object({
  policies: z.array(policySchema).refine(
    (policies) => new Set(policies.map((policy) => policy.name)).size === policies.length,
    'policy names must be unique',
  ),
});

export type LimitsConfig = z.infer<typeof limitsConfigSchema>;

export const FAILURE_MODES = ['fail-open', 'fail-closed'] as const;

export type FailureMode = (typeof FAILURE_MODES)[number];

export interface Settings {
  port: number;
  host: string;
  redisUrl: string;
  redisCommandTimeoutMs: number;
  configPath: string;
  failureMode: FailureMode;
  logLevel: string;
  policyRefreshMs: number;
  failClosedRetryAfterSeconds: number;
  shutdownTimeoutMs: number;
  adminToken: string | undefined;
}
