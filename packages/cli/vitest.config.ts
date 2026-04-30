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
      // PR9 / finding 15: thresholds bumped from 55/72/68/55 to
      // 60/75/80/60 alongside backfill of util/cli, runLogs, open,
      // runs.ts. The blueprint target is 80+ across the board, but
      // index.ts (76 KB of action handlers, currently uncovered) is
      // the dominant uncovered surface. Decomposing it into testable
      // command-registration modules is PR10; once that lands the
      // 80+ floor becomes achievable without test bloat.
      thresholds: {
        statements: 60,
        branches: 75,
        functions: 80,
        lines: 60,
      },
    },
  },
});
