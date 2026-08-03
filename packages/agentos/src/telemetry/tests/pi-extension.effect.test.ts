import { describe, expect, it } from "@effect/vitest";
import type {
  AgentOSOperation,
  AgentOSOperationInput,
  AgentOSOperationOutcome,
  AgentOSProviderAttempt,
  AgentOSProviderAttemptInput,
  AgentOSProviderAttemptOutcome,
  AgentOSTelemetry,
} from "../runtime.ts";
import { registerAgentOSObservabilityEffect } from "../pi-extension.ts";
import { makePiTestHarness } from "../../../tests/pi-test-harness.ts";
import { classifyAIError } from "../privacy.ts";
import { Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";

function recorder() {
  const attemptEnds: Array<string> = [];
  const operationEnds: Array<string> = [];
  const operations: Array<{
    input: AgentOSOperationInput;
    outcome?: AgentOSOperationOutcome;
    attempts: Array<{
      id: string;
      input: AgentOSProviderAttemptInput;
      outcome?: AgentOSProviderAttemptOutcome;
      headers: Record<string, string>;
    }>;
  }> = [];
  let nextId = 0;
  const telemetry: AgentOSTelemetry = {
    enabled: true,
    startOperation(input) {
      return Effect.sync(() => {
      const record: (typeof operations)[number] = { input, attempts: [] };
      operations.push(record);
      const operation: AgentOSOperation = {
        id: `operation-${++nextId}`,
        inject: () => Effect.void,
        startProviderAttempt(attemptInput) {
          return Effect.sync(() => {
          const attemptRecord: (typeof record.attempts)[number] = {
            id: `attempt-${++nextId}`,
            input: attemptInput,
            headers: {},
          };
          record.attempts.push(attemptRecord);
          const attempt: AgentOSProviderAttempt = {
            id: attemptRecord.id,
            inject(headers) {
              return Effect.sync(() => {
              if (headers instanceof Headers) {
                headers.set(
                  "traceparent",
                  "00-11111111111111111111111111111111-2222222222222222-01",
                );
                headers.set(
                  "x-agentos-request-attempt-id",
                  attemptRecord.id,
                );
              } else {
                headers.traceparent =
                  "00-11111111111111111111111111111111-2222222222222222-01";
                headers["x-agentos-request-attempt-id"] =
                  attemptRecord.id;
              }
              attemptRecord.headers = Object.fromEntries(
                headers instanceof Headers
                  ? headers.entries()
                  : Object.entries(headers),
              );
              });
            },
            end(outcome) {
              return Effect.sync(() => {
                attemptEnds.push(attemptRecord.id);
                attemptRecord.outcome = outcome;
              });
            },
          };
          return attempt;
          });
        },
        end(outcome) {
          return Effect.sync(() => {
            operationEnds.push(operation.id);
            record.outcome = outcome;
          });
        },
      };
      return operation;
      });
    },
    shutdown: Effect.void,
  };
  return { attemptEnds, operationEnds, operations, telemetry };
}

function assistantMessage(
  stopReason: "stop" | "error" | "aborted",
  errorMessage = "SEED_PROMPT provider-private body",
) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "SEED_PROMPT private output" }],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    errorMessage,
    timestamp: 1_785_648_000_000,
  };
}

function configureContext(
  fake: Effect.Success<ReturnType<typeof makePiTestHarness>>,
  entries: unknown[] = [],
) {
  Object.assign(fake.context, {
    model: {
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      baseUrl: "http://ai-gateway:8787/v1",
    },
    sessionManager: {
      getEntries: () => entries,
      getSessionFile: () => "/home/agent/.pi/session.jsonl",
    },
  });
}

describe("Pi provider observability extension", () => {
  it.effect("records one safe main attempt and propagates correlation headers", () => Effect.gen(function*() {
    const fake = yield* makePiTestHarness();
    configureContext(fake, [{ type: "message" }]);
    const recorded = recorder();
    yield* registerAgentOSObservabilityEffect(fake.pi, {
      telemetry: recorded.telemetry,
      runtimeVersion: "0.81.1",
    });

    yield* fake.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "SEED_PROMPT sk-seeded-secret",
      systemPrompt: "private system prompt",
      systemPromptOptions: {},
    });
    const headers: Record<string, string> = {};
    yield* fake.emit("before_provider_headers", {
      type: "before_provider_headers",
      headers,
    });
    yield* fake.emit("after_provider_response", {
      type: "after_provider_response",
      status: 200,
      headers: {
        "x-request-id": "req_safe_1",
        authorization: "Bearer provider-secret",
      },
    });
    yield* fake.emit("message_end", {
      type: "message_end",
      message: assistantMessage("stop"),
    });
    yield* fake.emit("agent_settled", { type: "agent_settled" });

    expect(headers.traceparent).toBe(
      "00-11111111111111111111111111111111-2222222222222222-01",
    );
    expect(headers["x-agentos-request-attempt-id"]).toBe("attempt-2");
    expect(recorded.operations).toHaveLength(1);
    expect(recorded.operations[0]?.input).toEqual({
      modelFamily: "gpt-5",
      providerFamily: "openai",
      route: "ai_gateway",
      runtime: "pi",
      runtimeVersion: "0.81.1",
      sessionState: "resumed",
    });
    expect(recorded.operations[0]?.attempts).toEqual([
      {
        headers: {
          traceparent:
            "00-11111111111111111111111111111111-2222222222222222-01",
          "x-agentos-request-attempt-id": "attempt-2",
        },
        id: "attempt-2",
        input: {
          requestKind: "main",
          retryCount: 0,
          streamMode: "streaming",
        },
        outcome: {
          bytes: undefined,
          chunks: undefined,
          error: undefined,
          inputTokens: 10,
          outputTokens: 20,
          providerRequestId: "req_safe_1",
          status: 200,
          streamOutcome: "completed",
        },
      },
    ]);
    expect(recorded.operations[0]?.outcome).toEqual({
      error: undefined,
      status: 200,
    });
    const encoded = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Unknown),
    )(recorded.operations);
    expect(encoded).not.toContain("SEED_PROMPT");
    expect(encoded).not.toContain(
      "provider-secret",
    );
  }));

  it.effect("treats a new persistent session's initial model metadata as fresh", () => Effect.gen(function*() {
    const fake = yield* makePiTestHarness();
    configureContext(fake, [
      { type: "model_change" },
      { type: "thinking_level_change" },
    ]);
    const recorded = recorder();
    yield* registerAgentOSObservabilityEffect(fake.pi, {
      telemetry: recorded.telemetry,
    });

    yield* fake.emit("before_provider_headers", {
      type: "before_provider_headers",
      headers: {},
    });
    yield* fake.emit("message_end", {
      type: "message_end",
      message: assistantMessage("stop"),
    });
    yield* fake.emit("agent_settled", { type: "agent_settled" });

    expect(recorded.operations[0]?.input.sessionState).toBe("fresh");
  }));

  it.effect("numbers every upstream retry exactly once and resets the next operation", () => Effect.gen(function*() {
    const fake = yield* makePiTestHarness();
    configureContext(fake);
    const recorded = recorder();
    yield* registerAgentOSObservabilityEffect(fake.pi, {
      telemetry: recorded.telemetry,
    });

    yield* fake.emit("before_provider_headers", {
      type: "before_provider_headers",
      headers: {},
    });
    yield* fake.emit("after_provider_response", {
      type: "after_provider_response",
      status: 503,
      headers: {},
    });
    yield* fake.emit("message_end", {
      type: "message_end",
      message: assistantMessage("error"),
    });
    yield* fake.emit("before_provider_headers", {
      type: "before_provider_headers",
      headers: {},
    });
    yield* fake.emit("after_provider_response", {
      type: "after_provider_response",
      status: 200,
      headers: {},
    });
    yield* fake.emit("message_end", {
      type: "message_end",
      message: assistantMessage("stop"),
    });
    yield* fake.emit("agent_settled", { type: "agent_settled" });

    yield* fake.emit("before_provider_headers", {
      type: "before_provider_headers",
      headers: {},
    });
    yield* fake.emit("after_provider_response", {
      type: "after_provider_response",
      status: 200,
      headers: {},
    });
    yield* fake.emit("message_end", {
      type: "message_end",
      message: assistantMessage("stop"),
    });
    yield* fake.emit("agent_settled", { type: "agent_settled" });

    expect(recorded.operations.map(({ attempts }) =>
      attempts.map(({ input }) => input.retryCount)
    )).toEqual([[0, 1], [0]]);
    expect(recorded.attemptEnds).toEqual([
      "attempt-2",
      "attempt-3",
      "attempt-5",
    ]);
  }));

  it.effect("serializes duplicate terminal events so an attempt and operation end once", () => Effect.gen(function*() {
    const fake = yield* makePiTestHarness();
    configureContext(fake);
    const recorded = recorder();
    yield* registerAgentOSObservabilityEffect(fake.pi, {
      telemetry: recorded.telemetry,
    });

    yield* fake.emit("before_provider_headers", {
      type: "before_provider_headers",
      headers: {},
    });
    yield* fake.emit("after_provider_response", {
      type: "after_provider_response",
      status: 200,
      headers: {},
    });
    yield* Effect.all([
      fake.emit("message_end", {
        type: "message_end",
        message: assistantMessage("stop"),
      }),
      fake.emit("message_end", {
        type: "message_end",
        message: assistantMessage("stop"),
      }),
      fake.emit("agent_settled", { type: "agent_settled" }),
      fake.emit("session_shutdown", { type: "session_shutdown" }),
    ], { concurrency: "unbounded" });

    expect(recorded.attemptEnds).toEqual(["attempt-2"]);
    expect(recorded.operationEnds).toEqual(["operation-1"]);
  }));

  it.effect("classifies a failed stream without copying Pi error text", () => Effect.gen(function*() {
    const fake = yield* makePiTestHarness();
    configureContext(fake);
    const recorded = recorder();
    yield* registerAgentOSObservabilityEffect(fake.pi, {
      telemetry: recorded.telemetry,
    });

    yield* fake.emit("before_provider_headers", {
      type: "before_provider_headers",
      headers: {},
    });
    yield* fake.emit("after_provider_response", {
      type: "after_provider_response",
      status: 503,
      headers: {},
    });
    yield* fake.emit("message_end", {
      type: "message_end",
      message: assistantMessage("error"),
    });
    yield* fake.emit("agent_settled", { type: "agent_settled" });

    const attempt = recorded.operations[0]?.attempts[0];
    expect(attempt?.outcome).toMatchObject({
      status: 503,
      streamOutcome: "upstream_error",
    });
    expect(attempt?.outcome?.error).toEqual({ name: "ProviderError" });
    expect(recorded.operations[0]?.outcome).toEqual({
      error: { name: "ProviderError" },
      status: 503,
    });
    const encoded = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Unknown),
    )(recorded.operations);
    expect(encoded).not.toContain(
      "provider-private body",
    );
  }));

  it.effect("covers authentication, rate limit, overload, timeout, and abort outcomes without raw errors", () => Effect.gen(function*() {
    const cases: ReadonlyArray<{
      readonly errorMessage: string;
      readonly expected: ReturnType<typeof classifyAIError>;
      readonly status: number | undefined;
      readonly stopReason: "error" | "aborted";
    }> = [
      { status: 401, stopReason: "error", errorMessage: "private auth body", expected: "authentication" },
      { status: 429, stopReason: "error", errorMessage: "private quota body", expected: "rate_limit" },
      { status: 503, stopReason: "error", errorMessage: "private overload body", expected: "overload" },
      { status: undefined, stopReason: "error", errorMessage: "request timed out after private endpoint", expected: "timeout" },
      { status: undefined, stopReason: "aborted", errorMessage: "private cancelled body", expected: "abort" },
    ];

    for (const testCase of cases) {
      const fake = yield* makePiTestHarness();
      configureContext(fake);
      const recorded = recorder();
      yield* registerAgentOSObservabilityEffect(fake.pi, {
        telemetry: recorded.telemetry,
      });
      yield* fake.emit("before_provider_headers", {
        type: "before_provider_headers",
        headers: {},
      });
      if (testCase.status !== undefined) {
        yield* fake.emit("after_provider_response", {
          type: "after_provider_response",
          status: testCase.status,
          headers: {},
        });
      }
      yield* fake.emit("message_end", {
        type: "message_end",
        message: assistantMessage(testCase.stopReason, testCase.errorMessage),
      });
      yield* fake.emit("agent_settled", { type: "agent_settled" });

      const outcome = recorded.operations[0]?.attempts[0]?.outcome;
      expect(classifyAIError(outcome?.error, outcome?.status)).toBe(
        testCase.expected,
      );
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(recorded.operations);
      expect(encoded).not.toContain(testCase.errorMessage);
    }
  }));

  it.effect("fails open within a bounded hook budget when telemetry never initializes", () =>
    TestClock.withLive(Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      configureContext(fake);
      yield* registerAgentOSObservabilityEffect(fake.pi, {
        telemetry: Effect.never,
      });

      const result = yield* fake.emit("before_provider_headers", {
        type: "before_provider_headers",
        headers: {},
      }).pipe(Effect.timeoutOption(100));

      expect(Option.isSome(result)).toBe(true);
    })));

  it.effect("fails open within a bounded hook budget when operation recording stalls", () =>
    TestClock.withLive(Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      configureContext(fake);
      const recorded = recorder();
      yield* registerAgentOSObservabilityEffect(fake.pi, {
        telemetry: {
          ...recorded.telemetry,
          startOperation: () => Effect.never,
        },
      });

      const result = yield* fake.emit("before_provider_headers", {
        type: "before_provider_headers",
        headers: {},
      }).pipe(Effect.timeoutOption(100));

      expect(Option.isSome(result)).toBe(true);
      expect(recorded.operations).toEqual([]);
    })));

  it.effect("fails open when telemetry defects", () => Effect.gen(function*() {
    const fake = yield* makePiTestHarness();
    configureContext(fake);
    yield* registerAgentOSObservabilityEffect(fake.pi, {
      telemetry: Effect.die("private exporter defect"),
    });

    yield* fake.emit("before_provider_headers", {
      type: "before_provider_headers",
      headers: {},
    });
    yield* fake.emit("message_end", {
      type: "message_end",
      message: assistantMessage("stop"),
    });
    yield* fake.emit("agent_settled", { type: "agent_settled" });
  }));

  it.effect("classifies a stream without a terminal message as a provider failure", () => Effect.gen(function*() {
    const fake = yield* makePiTestHarness();
    configureContext(fake);
    const recorded = recorder();
    yield* registerAgentOSObservabilityEffect(fake.pi, {
      telemetry: recorded.telemetry,
    });

    yield* fake.emit("before_provider_headers", {
      type: "before_provider_headers",
      headers: {},
    });
    yield* fake.emit("after_provider_response", {
      type: "after_provider_response",
      status: 200,
      headers: {},
    });
    yield* fake.emit("agent_settled", { type: "agent_settled" });

    const attempt = recorded.operations[0]?.attempts[0];
    expect(attempt?.outcome).toMatchObject({
      status: 200,
      streamOutcome: "upstream_error",
      error: { name: "ProviderError" },
    });
    expect(recorded.operations[0]?.outcome).toEqual({
      error: { name: "ProviderError" },
      status: 200,
    });
  }));

  it.effect("can run alone as the explicit extension-disabled control", () => Effect.gen(function*() {
    const fake = yield* makePiTestHarness();
    const recorded = recorder();
    yield* registerAgentOSObservabilityEffect(fake.pi, {
      telemetry: recorded.telemetry,
    });

    expect(
      [...fake.extension.handlers.keys()],
    ).toEqual([
      "before_agent_start",
      "before_provider_headers",
      "after_provider_response",
      "message_end",
      "agent_settled",
      "session_shutdown",
    ]);
    expect(
      [...fake.extension.commands.keys(), ...fake.extension.tools.keys()],
    ).toEqual([]);
    expect(fake.extension.handlers.has("before_provider_request")).toBe(false);
  }));
});
