import { z } from 'zod';

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required').refine(v => v.startsWith('postgresql://') || v.startsWith('postgres://'), 'DATABASE_URL must start with postgresql:// or postgres://'),

  // Redis
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // Supabase
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),

  // Storage
  STORAGE_BUCKET_UPLOADS: z.string().default('continuum-uploads'),
  STORAGE_BUCKET_EXPORTS: z.string().default('continuum-exports'),

  // SMTP verification
  SMTP_CHECK_ENABLED: z
    .string()
    .transform((v) => v.toLowerCase() === 'true')
    .default('true'),
  SMTP_CHECK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(5000),
  SMTP_HELO_DOMAIN: z
    .string()
    .min(1, 'SMTP_HELO_DOMAIN is required when SMTP_CHECK_ENABLED=true')
    .default('localhost'),
  SMTP_PROBE_URL: z.string().url().optional(),
  SMTP_PROBE_KEY: z.string().optional(),
  MILLIONVERIFIER_API_KEY: z.string().optional(),
  MV_PROXY_URL: z.string().url().optional(),
  MV_PROXY_KEY: z.string().optional(),
  DEBOUNCE_API_KEY: z.string().optional(),
  BOUNCER_API_KEY: z.string().optional(),

  // Billing (Dodo Payments)
  DODO_PAYMENTS_API_KEY: z.string().optional(),
  DODO_WEBHOOK_SECRET: z.string().optional(),
  DODO_PRODUCT_STARTER: z.string().optional(),
  DODO_PRODUCT_GROWTH: z.string().optional(),
  DODO_PRODUCT_SCALE: z.string().optional(),
  DASHBOARD_URL: z.string().url().default('https://app.continuumapi.com'),

  // Transactional email (Resend) — email is off when the key is unset
  RESEND_API_KEY: z.string().optional(),
  SUPPORT_EMAIL: z.string().default('sumeet@continuumapi.com'),

  // Send (Amazon SES) — /v1/send 503s until these are set; everything else
  // in Phase 6 (schema, quota, webhooks, suppression) works without them.
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SES_CONFIGURATION_SET: z.string().optional(),
  SES_FROM_DOMAIN: z.string().default('relay.continuumapi.com'),
  SES_SNS_TOPIC_ARN: z.string().optional(),

  // Rate limiting
  DEFAULT_RATE_LIMIT_RPM: z.coerce.number().int().min(1).max(100000).default(1000),

  // Webhook delivery
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),

  // Internal
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_KEY_SALT: z
    .string()
    .min(16, 'API_KEY_SALT must be at least 16 characters')
    .default('dev-salt-change-in-production'),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Environment configuration is invalid:\n${formatted}`);
  }

  return result.data;
}

// Singleton — loaded once at startup, throws immediately if invalid
export const config = loadConfig();

export const isDev = config.NODE_ENV === 'development';
export const isProd = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
