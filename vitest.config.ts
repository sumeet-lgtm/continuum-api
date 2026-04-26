import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Use Node environment (no DOM)
    environment: 'node',

    // Pattern for test files
    include: ['src/__tests__/**/*.test.ts'],

    // Global setup — runs once before all test files
    globalSetup: ['src/__tests__/setup/global.ts'],

    // Per-file setup — runs before each test file
    setupFiles: ['src/__tests__/setup/file.ts'],

    // Timeouts — SMTP + DNS tests need more headroom
    testTimeout: 15_000,
    hookTimeout: 10_000,

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/engine/**', 'src/routes/**', 'src/lib/**'],
      exclude: ['src/workers/**', 'src/server.ts'],
      thresholds: {
        lines:      80,
        functions:  80,
        branches:   75,
        statements: 80,
      },
    },

    // Isolated — each test file gets a fresh module registry
    isolate: true,

    // Reporters
    reporters: ['verbose'],
  },
});
