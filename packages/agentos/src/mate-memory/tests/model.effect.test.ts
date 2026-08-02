import type {
  Api,
  AssistantMessage,
  Model,
  StopReason,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Ref, Schema } from "effect";

import { createTelemetryRecorder } from "../../telemetry/tests/fake-telemetry.ts";
import {
  relevantSelectionMessage,
  resolveRelevantTopicIds,
  selectRelevantTopics,
  type RelevantSelectionInput,
} from "../model.ts";

const Json = Schema.fromJsonString(Schema.Unknown);

function selectorModel(): Model<Api> {
  return {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "http://ai-gateway:8787",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100_000,
  };
}

function completion(
  text: string,
  stopReason: StopReason = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    timestamp: 1,
  };
}

function startup(): RelevantSelectionInput["startup"] {
  return {
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
  };
}

describe("Mate memory relevance selection Effect boundary", () => {
  it.effect("constructs a lazy Effect without resolving unused authentication", () =>
    Effect.gen(function*() {
      const authResolved = yield* Ref.make(false);
      const selection = selectRelevantTopics({
        prompt: "Recall the deployment decision",
        startup: { ...startup(), inventory: [] },
        model: undefined,
        resolveAuth: Ref.set(authResolved, true).pipe(
          Effect.as({ ok: false, error: "unused" }),
        ),
      });

      expect(Effect.isEffect(selection)).toBe(true);
      expect(yield* Ref.get(authResolved)).toBe(false);
      expect(yield* selection).toEqual([]);
      expect(yield* Ref.get(authResolved)).toBe(false);
    }),
  );

  it.effect("attributes one selector attempt without exposing prompts, paths, or credentials", () =>
    Effect.gen(function*() {
      const recorded = createTelemetryRecorder();
      const forwarded = yield* Ref.make(
        Option.none<Record<string, string | null>>(),
      );
      const authHeaders = { "x-original": "preserved" };
      const selected = yield* selectRelevantTopics({
        prompt: "SEED_PROMPT private human request",
        startup: startup(),
        model: selectorModel(),
        resolveAuth: Effect.succeed({
          ok: true,
          apiKey: "sk-seeded-secret",
          headers: authHeaders,
        }),
        telemetry: recorded.telemetry,
        completeImpl: (_model, _context, options) =>
          Ref.set(
            forwarded,
            Option.some(options?.headers ?? {}),
          ).pipe(Effect.as(completion('{"ids":["topic-0"]}'))),
        now: Effect.succeed(42),
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
      const encoded = yield* Schema.encodeEffect(Json)(recorded.operations);
      expect(encoded).not.toContain("SEED_PROMPT");
      expect(encoded).not.toContain("sk-seeded-secret");
      expect(encoded).not.toContain("private-project");
      const headers = Option.getOrUndefined(yield* Ref.get(forwarded));
      expect(headers).toMatchObject({
        "x-original": "preserved",
        traceparent: expect.any(String),
        "x-agentos-request-attempt-id": expect.any(String),
      });
      expect(authHeaders).toEqual({ "x-original": "preserved" });
    }),
  );

  it.effect("redacts all selector context and maps only opaque IDs to exact paths", () =>
    Effect.gen(function*() {
      const message = yield* relevantSelectionMessage({
        prompt: "Use password: hunter2 and sk-proj-secret-value",
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
      });

      expect(message).toContain("password=[REDACTED]");
      expect(message).not.toContain("hunter2");
      expect(message).not.toContain("sk-proj-secret-value");
      expect(message).not.toContain("index-secret");
      expect(message).not.toContain("sk-proj-index-secret");
      expect(message).not.toContain("inventory-secret");
      expect(message).not.toContain("AKIA1234567890ABCDEF");
      expect(message).toContain('"id":"topic-0"');
      expect(message).not.toContain('"relativePath"');
      expect(resolveRelevantTopicIds(["topic-0", "unknown"], [
        {
          relativePath: "topics/sk-abcdefgh.md",
          type: "reference",
          scope: "reporting",
          modified: "2026-07-28T12:00:00.000Z",
          pinned: false,
        },
      ])).toEqual(["topics/sk-abcdefgh.md"]);
    }),
  );

  it.effect("fails through exact typed channels for auth, transport, provider, and schema errors", () =>
    Effect.gen(function*() {
      const base = {
        prompt: "Recall",
        startup: startup(),
        model: selectorModel(),
      };
      const unavailable = yield* selectRelevantTopics({
        ...base,
        resolveAuth: Effect.succeed({ ok: false, error: "missing" }),
      }).pipe(Effect.flip);
      expect(unavailable.code).toBe("authentication_unavailable");

      const authFailure = yield* selectRelevantTopics({
        ...base,
        resolveAuth: Effect.fail(new Error("resolver unavailable")),
      }).pipe(Effect.flip);
      expect(authFailure.code).toBe("authentication_unavailable");

      const requestFailure = yield* selectRelevantTopics({
        ...base,
        resolveAuth: Effect.succeed({ ok: true }),
        completeImpl: () => Effect.fail(new Error("network unavailable")),
      }).pipe(Effect.flip);
      expect(requestFailure.code).toBe("request_failed");

      const providerFailure = yield* selectRelevantTopics({
        ...base,
        resolveAuth: Effect.succeed({ ok: true }),
        completeImpl: () => Effect.succeed(completion("", "error")),
      }).pipe(Effect.flip);
      expect(providerFailure.code).toBe("provider_failed");

      const invalid = yield* selectRelevantTopics({
        ...base,
        resolveAuth: Effect.succeed({ ok: true }),
        completeImpl: () => Effect.succeed(completion('{"paths":[]}')),
      }).pipe(Effect.flip);
      expect(invalid.code).toBe("invalid_response");
    }),
  );
});
