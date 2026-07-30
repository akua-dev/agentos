import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["vendor/codex-router/packages/**/test/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
