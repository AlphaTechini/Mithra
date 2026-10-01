import { defineConfig } from 'vitest/config';

// Integration tests run against a real Canton sandbox with the Mithra DARs (scripts/sandbox.sh
// start) and a PostgreSQL database (DATABASE_URL_TEST). They are not part of `pnpm test`.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
