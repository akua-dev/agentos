import { describe, expect, test } from "bun:test";

describe("Mate memory extension discovery", () => {
  for (const role of ["firstmate", "secondmate"]) {
    test(`${role} exposes the shared extension through its Pi entrypoint`, async () => {
      const extension = await import(
        `../../../${role}/.pi/extensions/agentos-mate-memory.ts`
      );
      expect(extension.default).toBeFunction();
    });
  }
});
