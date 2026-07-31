import { describe, expect, test } from "bun:test";

describe("canonical codex-router package", () => {
  test("loads the portable policy and Bun adapter from one root Git dependency", async () => {
    const [core, codex, bun] = await Promise.all([
      import("@akua-dev/codex-router/core"),
      import("@akua-dev/codex-router/codex"),
      import("@akua-dev/codex-router/bun"),
    ]);

    expect(core.selectAccount).toBeFunction();
    expect(codex.sanitizeRequestHeaders).toBeFunction();
    expect(bun.openSqliteRoutingState).toBeFunction();
  });
});
