import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    // Bumped from the 5s default. The fakeAgent / e2eParallel /
    // freshInstall suites drive end-to-end CLI flows that do many file
    // mutations under parallel vitest workers; atomic writes (temp+rename)
    // serialize harder on macOS APFS than direct writeFile, and 5s left no
    // headroom under that contention.
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 55,
        branches: 72,
        functions: 68,
        lines: 55,
      },
    },
  },
});
