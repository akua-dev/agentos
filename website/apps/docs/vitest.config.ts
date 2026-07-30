import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': new URL('.', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    environmentOptions: {
      jsdom: {
        url: 'https://agentos.test/',
      },
    },
    include: ['scripts/**/*.test.ts', 'lib/**/*.test.ts', 'components/**/*.test.tsx'],
  },
});
