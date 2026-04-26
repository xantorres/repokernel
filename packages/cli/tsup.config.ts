import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node20',
  splitting: false,
  treeshake: true,
  noExternal: ['@repokernel/core'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
