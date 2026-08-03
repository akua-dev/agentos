import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('.', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    // The rendered-site contract starts and compiles a real Next server. Keep
    // it from competing with other test-file workers for the site workspace.
    fileParallelism: false,
    environmentOptions: {
      jsdom: {
        url: 'https://agentos.test/',
      },
    },
    include: ['scripts/**/*.test.ts', 'lib/**/*.test.ts', 'components/**/*.test.tsx'],
  },
});
