import { z } from 'zod';

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) =>
        value.startsWith('postgresql://') ||
        value.startsWith('postgres://'),
      'DATABASE_URL must be a PostgreSQL URL',
    ),

  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required')
    .refine(
      (value) =>
        value.startsWith('redis://') ||
        value.startsWith('rediss://'),
      'REDIS_URL must be a Redis URL',
    ),

  API_HOST: z.string().min(1).default('0.0.0.0'),

API_PORT: z
  .string()
  .regex(/^\d+$/, 'API_PORT must be a valid integer')
  .transform(Number)
  .pipe(z.number().int().min(1).max(65535))
  .default(4000),

  WEB_ORIGIN: z.url(),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

export type Environment = z.infer<typeof environmentSchema>;

export type EnvironmentInput = Record<string, string | undefined>;

export function parseEnvironment(input: EnvironmentInput): Environment {
  const result = environmentSchema.safeParse(input);

  if (!result.success) {
    const messages = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );

    throw new Error(
      `Invalid environment configuration:\n${messages.join('\n')}`,
    );
  }

  return Object.freeze(result.data);
}