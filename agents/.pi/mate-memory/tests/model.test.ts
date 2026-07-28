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

  test("redacts index and inventory context before building the selector message", () => {
    const message = relevantSelectionMessage({
      prompt: "Recall the reporting preference",
      startup: {
        index: "password: index-secret and sk-proj-index-secret",
        pinned: [],
        inventory: [
          {
            relativePath: "topics/token=inventory-secret.md",
            type: "reference",
            scope: "AKIA1234567890ABCDEF",
            modified: "2026-07-28T12:00:00.000Z",
            pinned: false,
          },
        ],
        degraded: [],
      },
      model: undefined,
      modelRegistry: undefined as never,
    });

    expect(message).not.toContain("index-secret");
    expect(message).not.toContain("sk-proj-index-secret");
    expect(message).not.toContain("inventory-secret");
    expect(message).not.toContain("AKIA1234567890ABCDEF");
  });
});
