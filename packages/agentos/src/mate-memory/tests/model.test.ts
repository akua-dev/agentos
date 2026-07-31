import { describe, expect, test } from "bun:test";

import {
  relevantSelectionMessage,
  resolveRelevantTopicIds,
  selectRelevantTopics,
} from "../model.ts";
import { createTelemetryRecorder } from "../../telemetry/tests/fake-telemetry.ts";

describe("Mate memory relevance selection", () => {
  test("attributes the selector call without recording memory content", async () => {
    const recorded = createTelemetryRecorder();
    let forwardedHeaders: Record<string, string | null> | undefined;
    const authHeaders = { "x-original": "preserved" };
    const selected = await selectRelevantTopics({
      prompt: "SEED_PROMPT private human request",
      startup: {
        index: "# Memory index",
        pinned: [],
        inventory: [
          {
            relativePath: "topics/private-project.md",
            type: "project",
            scope: "private",
            modified: "2026-07-28T12:00:00.000Z",
            pinned: false,
          },
        ],
        degraded: [],
      },
      model: {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        baseUrl: "http://ai-gateway:8787",
      } as never,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({
          ok: true,
          apiKey: "sk-seeded-secret",
          headers: authHeaders,
        }),
      } as never,
      telemetry: recorded.telemetry,
      completeImpl: async (_model, _context, options) => {
        forwardedHeaders = options?.headers;
        return ({
          role: "assistant",
          content: [{ type: "text", text: '{"ids":["topic-0"]}' }],
          usage: { input: 4, output: 2 },
          stopReason: "stop",
        }) as never;
      },
    });

    expect(selected).toEqual(["topics/private-project.md"]);
    expect(recorded.operations[0]?.attempts).toEqual([
      {
        input: {
          requestKind: "extension",
          streamMode: "non_streaming",
        },
        outcome: {
          error: undefined,
          inputTokens: 4,
          outputTokens: 2,
          status: 200,
          streamOutcome: "completed",
        },
      },
    ]);
    expect(JSON.stringify(recorded.operations)).not.toContain(
      "SEED_PROMPT",
    );
    expect(JSON.stringify(recorded.operations)).not.toContain(
      "sk-seeded-secret",
    );
    expect(JSON.stringify(recorded.operations)).not.toContain(
      "private-project",
    );
    expect(forwardedHeaders).toMatchObject({
      "x-original": "preserved",
      traceparent: expect.any(String),
      "x-agentos-request-attempt-id": expect.any(String),
    });
    expect(authHeaders).toEqual({ "x-original": "preserved" });
  });

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
    expect(message).toContain('"id":"topic-0"');
    expect(message).not.toContain('"relativePath"');
  });

  test("maps opaque selector IDs back to exact topic paths", () => {
    expect(
      resolveRelevantTopicIds(
        ["topic-0"],
        [
          {
            relativePath: "topics/sk-abcdefgh.md",
            type: "reference",
            scope: "reporting",
            modified: "2026-07-28T12:00:00.000Z",
            pinned: false,
          },
        ],
      ),
    ).toEqual(["topics/sk-abcdefgh.md"]);
  });
});
