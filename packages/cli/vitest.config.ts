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
      // Exclude bootstrap wiring and shell-out wrappers: tested transitively
      // or require process-level mocks that add more noise than signal.
      exclude: [
        // CLI entry point: pure Commander wiring, tested transitively
        'src/index.ts',
        'src/registers/**',
        'src/util/program.ts',
        'src/ux/open.ts',
        'src/lifecycle/git.ts',
        // External I/O adapters: manual requires stdin/tty interaction;
        // ollama requires a running Ollama HTTP service. Both analogous to
        // git.ts (shell-out wrapper) — add integration tests separately.
        'src/agents/manual.ts',
        'src/agents/ollama.ts',
      ],
      // Thresholds ratchet: 70/75/80/70 after S-COV-01 (recover.ts).
      // Target 80/80/85/80 once S-COV-02..05 land.
      thresholds: {
        statements: 70,
        branches: 75,
        functions: 80,
        lines: 70,
      },
    },
  },
});
