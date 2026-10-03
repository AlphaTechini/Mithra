import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // @mithra/shared is consumed as TypeScript source, so it must be bundled in.
  // Third-party dependencies stay external and are loaded from node_modules at runtime.
  noExternal: ['@mithra/shared'],
});
