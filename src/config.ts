import { z } from 'zod';

// Dev-only placeholder values. Startup fails in production if a secret is
// still holding one of these — a secret must never silently fall back to a
// shared default outside local development (see the superRefine below).
const DEV_SESSION_SECRET = 'dev-session-secret-at-least-32-chars-long';
const DEV_API_KEY_SALT = 'dev-salt-change-in-production';

const baseEnvSchema = z.object({
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
  // Called directly (no proxy needed — ZeroBounce's public API doesn't
  // require routing around the way DeBounce/Bouncer/MillionVerifier do).
  // Tried first when set, ahead of the proxy-routed providers below.
  ZEROBOUNCE_API_KEY: z.string().optional(),

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

  // Crypto secrets — each guards a distinct capability (DKIM key encryption,
  // unsubscribe/opt-in tokens, tracking tokens, mailbox credential
  // encryption). Optional here only so local dev doesn't need five secrets;
  // production requires every one of these via the superRefine below, so
  // none of them can silently collapse onto API_KEY_SALT outside dev.
  DOMAIN_KEY_SECRET: z.string().min(32, 'DOMAIN_KEY_SECRET must be at least 32 characters').optional(),
  UNSUBSCRIBE_SECRET: z.string().min(32, 'UNSUBSCRIBE_SECRET must be at least 32 characters').optional(),
  TRACKING_SECRET: z.string().min(32, 'TRACKING_SECRET must be at least 32 characters').optional(),
  MAILBOX_CREDS_SECRET: z.string().min(32, 'MAILBOX_CREDS_SECRET must be at least 32 characters').optional(),
  OPTIN_SECRET: z.string().min(32, 'OPTIN_SECRET must be at least 32 characters').optional(),

  // Feature gates
  WARMUP_POOL_ENABLED: z.string().transform(v => v?.toLowerCase() === 'true').default('false'),
  IMAP_POLL_ENABLED: z.string().transform(v => v?.toLowerCase() === 'true').default('false'),
  AI_PERSONALIZATION_ENABLED: z.string().transform(v => v?.toLowerCase() === 'true').default('false'),

  // IMAP seed accounts for inbox placement testing
  SEED_GMAIL_USER: z.string().optional(),
  SEED_GMAIL_PASSWORD: z.string().optional(),
  SEED_OUTLOOK_USER: z.string().optional(),
  SEED_OUTLOOK_PASSWORD: z.string().optional(),

  // Anthropic (for AI personalization)
  ANTHROPIC_API_KEY: z.string().optional(),

  // WorkOS (SSO / AuthKit)
  WORKOS_API_KEY: z.string().optional(),
  WORKOS_CLIENT_ID: z.string().optional(),

  // Mailbox OAuth connect (Gmail / Outlook one-click connect) — each pair is
  // independently optional; the dashboard's "Connect with Google/Outlook"
  // buttons are simply hidden until the matching pair is set, same pattern
  // as every other optional integration in this file.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  MICROSOFT_OAUTH_CLIENT_ID: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_OAUTH_REDIRECT_URI: z.string().url().optional(),

  // Cal.com webhook secret (paste here after setting it in Cal.com → Webhooks → Secret)
  CALCOM_WEBHOOK_SECRET: z.string().optional(),
  // WorkOS webhook secret (from WorkOS Dashboard → Webhooks → Endpoint → Secret)
  WORKOS_WEBHOOK_SECRET: z.string().optional(),
  SESSION_SECRET: z
    .string()
    .min(32)
    .default(DEV_SESSION_SECRET),
  API_BASE_URL: z.string().url().optional(),

  // SMTP relay (port 587) — PEM text with literal \n for newlines, the
  // standard way to fit a multi-line cert into a single-line env var.
  // Required for STARTTLS to actually work; the relay refuses to accept
  // AUTH without it (allowInsecureAuth is off), so an unset cert here
  // means the relay is running but nobody can ever authenticate.
  SMTP_RELAY_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_RELAY_TLS_CERT: z.string().optional(),
  SMTP_RELAY_TLS_KEY: z.string().optional(),

  // Error tracking (Sentry) — off entirely when unset. Production errors
  // previously lived only in the raw Railway log stream with no
  // aggregation, alerting, or exception grouping.
  SENTRY_DSN: z.string().url().optional(),

  // Internal
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  API_KEY_SALT: z
    .string()
    .min(16, 'API_KEY_SALT must be at least 16 characters')
    .default(DEV_API_KEY_SALT),
});

// Secrets that must never fall back to a shared or hardcoded default once
// this is running in production. Each guards a distinct security boundary
// (DKIM signing keys, mailbox credentials, unsubscribe/opt-in tokens,
// tracking tokens, the session cookie, API key hashing) — a fallback here
// previously meant one leaked or forgotten env var silently degraded every
// one of these to the same well-known dev string.
const REQUIRED_IN_PRODUCTION = [
  'DOMAIN_KEY_SECRET',
  'UNSUBSCRIBE_SECRET',
  'TRACKING_SECRET',
  'MAILBOX_CREDS_SECRET',
  'OPTIN_SECRET',
] as const;

const envSchema = baseEnvSchema.superRefine((val, ctx) => {
  if (val.NODE_ENV !== 'production') return;

  for (const key of REQUIRED_IN_PRODUCTION) {
    if (!val[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required in production — without it this secret silently falls back to API_KEY_SALT instead of failing`,
      });
    }
  }
  if (val.SESSION_SECRET === DEV_SESSION_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SESSION_SECRET'],
      message: 'SESSION_SECRET must be set to a real value in production — the dev default is not allowed',
    });
  }
  if (val.API_KEY_SALT === DEV_API_KEY_SALT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['API_KEY_SALT'],
      message: 'API_KEY_SALT must be set to a real value in production — the dev default is not allowed',
    });
  }
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
