/**
 * Global setup — runs once before the entire test suite.
 * Sets environment variables so config.ts doesn't throw.
 */
export function setup(): void {
  process.env['NODE_ENV']                 = 'test';
  process.env['DATABASE_URL']             = 'postgresql://test:test@localhost:5432/continuum_test';
  process.env['REDIS_URL']                = 'redis://localhost:6379';
  process.env['SUPABASE_URL']             = 'https://test.supabase.co';
  process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'test-service-role-key-minimum-32-chars-long';
  process.env['API_KEY_SALT']             = 'test-salt-that-is-at-least-16-chars';
  process.env['SMTP_CHECK_ENABLED']       = 'false';  // unit tests never make real TCP connections
  process.env['SMTP_HELO_DOMAIN']         = 'test.continuum.local';
  process.env['SMTP_CHECK_TIMEOUT_MS']    = '1000';
  process.env['LOG_LEVEL'] = 'warn';
}

export function teardown(): void {
  // Nothing to clean up at the global level
}
