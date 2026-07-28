import { describe, expect, test } from "bun:test";

import { relevantSelectionMessage } from "../model.ts";

describe("Mate memory relevance selection", () => {
  test("redacts the human request before building the selector message", () => {
    const message = relevantSelectionMessage({
      prompt: "Use password: hunter2 and sk-proj-secret-value",
      startup: {
        index: "# Memory index",
        pinned: [],
        inventory: [],
        degraded: [],
      },
      model: undefined,
      modelRegistry: undefined as never,
    });

    expect(message).toContain("Use password=[REDACTED]");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("sk-proj-secret-value");
  });
});
