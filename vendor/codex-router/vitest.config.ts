import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "vendor/codex-router/packages/core/test/**/*.test.ts",
      "vendor/codex-router/packages/codex/test/**/*.test.ts",
    ],
    testTimeout: 10_000,
  },
});
