import { resolve } from 'node:path';
import { svelteTesting } from '@testing-library/svelte/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  // MITHRA_API_PROXY is read at dev time only (the proxy does not exist in the production
  // build). It may come from the shell or from the repository-level .env file.
  const fileEnv = loadEnv(mode, resolve(import.meta.dirname, '../..'), 'MITHRA_');
  const apiTarget =
    process.env['MITHRA_API_PROXY'] ?? fileEnv['MITHRA_API_PROXY'] ?? 'http://localhost:8787';

  return {
    plugins: [sveltekit(), svelteTesting()],
    server: {
      port: 5173,
      proxy: { '/api': { target: apiTarget, changeOrigin: true } },
    },
    preview: {
      proxy: { '/api': { target: apiTarget, changeOrigin: true } },
    },
    test: {
      include: ['src/**/*.test.ts'],
      environment: 'jsdom',
      setupFiles: ['src/test/setup.ts'],
    },
  };
});
