import { vi } from 'vitest';

// Mock pino so log output doesn't clutter test output.
// We use vi.mock at the module level so all imports of ../lib/logger get
// the silenced version.
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));
