import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  AGENTOS_AI_COMPACTION_PATHS,
  AGENTOS_AI_ERROR_CLASSES,
  AGENTOS_AI_REQUEST_KINDS,
  AGENTOS_AI_ROUTES,
  AGENTOS_AI_RUNTIMES,
  AGENTOS_AI_STATUS_CLASSES,
  AGENTOS_AI_STREAM_OUTCOMES,
  AGENTOS_AI_TELEMETRY_CONTRACT_VERSION,
} from "../contract.ts";
import {
  classifyAIError,
  classifyAIStatus,
  safeTelemetryAttributes,
} from "../privacy.ts";

describe("AgentOS AI telemetry contract v1", () => {
  it.effect("publishes the complete bounded vocabulary", () => Effect.sync(() => {
    expect(AGENTOS_AI_TELEMETRY_CONTRACT_VERSION).toBe(1);
    expect(AGENTOS_AI_RUNTIMES).toEqual(["pi", "codex"]);
    expect(AGENTOS_AI_ROUTES).toEqual(["direct", "ai_gateway"]);
    expect(AGENTOS_AI_REQUEST_KINDS).toEqual([
      "main",
      "compaction",
      "memory_extract",
      "memory_consolidate",
      "extension",
    ]);
    expect(AGENTOS_AI_COMPACTION_PATHS).toEqual([
      "portable_summary",
      "native_server",
    ]);
    expect(AGENTOS_AI_STATUS_CLASSES).toEqual([
      "success",
      "client_error",
      "server_error",
      "cancelled",
      "error",
    ]);
    expect(AGENTOS_AI_ERROR_CLASSES).toEqual([
      "none",
      "authentication",
      "rate_limit",
      "overload",
      "timeout",
      "abort",
      "transport",
      "protocol",
      "decode",
      "unavailable",
      "unknown",
    ]);
    expect(AGENTOS_AI_STREAM_OUTCOMES).toEqual([
      "not_streamed",
      "completed",
      "client_disconnect",
      "aborted",
      "upstream_error",
    ]);
  }));

  it.effect("classifies provider and transport failures without serializing error text", () => Effect.sync(() => {
    expect(classifyAIError(undefined, 401)).toBe("authentication");
    expect(classifyAIError(undefined, 403)).toBe("authentication");
    expect(classifyAIError(undefined, 429)).toBe("rate_limit");
    expect(classifyAIError(undefined, 503)).toBe("overload");
    expect(classifyAIError(undefined, 500)).toBe("unavailable");
    expect(classifyAIError({ name: "AbortError" })).toBe("abort");
    expect(classifyAIError({ name: "TimeoutError" })).toBe("timeout");
    expect(classifyAIError({ code: "ECONNRESET" })).toBe("transport");
    expect(classifyAIError({ code: "HPE_INVALID_HEADER_TOKEN" })).toBe("protocol");
    expect(classifyAIError({ code: "Z_DATA_ERROR" })).toBe("decode");
    expect(
      classifyAIError(
        Object.defineProperty({}, "name", {
          get() {
            return Option.getOrThrow(Option.none());
          },
        }),
      ),
    ).toBe("unknown");
    expect(
      classifyAIError(new Error("seeded prompt and provider-private error body")),
    ).toBe("unknown");
    expect(classifyAIStatus(200, { name: "ProviderError" })).toBe("error");
  }));

  it.effect("keeps only allowlisted, bounded attributes for each signal", () => Effect.sync(() => {
    const seededPrompt = "SEED_PROMPT: explain the private launch";
    const seededToken = "sk-seeded-secret";
    const seededProviderIdentity = "provider-account@example.test";
    const input = {
      "agentos.ai.runtime": "pi",
      "agentos.ai.route": "ai_gateway",
      "agentos.ai.request.kind": "main",
      "agentos.ai.compaction.path": "native_server",
      "agentos.ai.status_class": "success",
      "agentos.ai.error.class": "none",
      "agentos.ai.stream.outcome": "completed",
      "agentos.ai.request.attempt_id": "018f-safe-opaque",
      "agentos.ai.provider.request_id": "req_safe_opaque",
      "agentos.ai.route.slot": "slot-03",
      "agentos.ai.model.family": "gpt-5",
      "http.request.body": seededPrompt,
      "gen_ai.prompt": seededPrompt,
      authorization: `Bearer ${seededToken}`,
      "provider.account.id": seededProviderIdentity,
      "error.message": `upstream said ${seededPrompt}`,
      "tool.arguments": `{"token":"${seededToken}"}`,
      "unbounded.attribute": "x".repeat(10_000),
    };

    const span = safeTelemetryAttributes(input, "span");
    const metric = safeTelemetryAttributes(input, "metric");
    const log = safeTelemetryAttributes(input, "log");

    expect(span).toEqual({
      "agentos.ai.error.class": "none",
      "agentos.ai.compaction.path": "native_server",
      "agentos.ai.model.family": "gpt-5",
      "agentos.ai.provider.request_id": "req_safe_opaque",
      "agentos.ai.request.attempt_id": "018f-safe-opaque",
      "agentos.ai.request.kind": "main",
      "agentos.ai.route": "ai_gateway",
      "agentos.ai.route.slot": "slot-03",
      "agentos.ai.runtime": "pi",
      "agentos.ai.status_class": "success",
      "agentos.ai.stream.outcome": "completed",
    });
    expect(metric).toEqual({
      "agentos.ai.error.class": "none",
      "agentos.ai.compaction.path": "native_server",
      "agentos.ai.model.family": "gpt-5",
      "agentos.ai.request.kind": "main",
      "agentos.ai.route": "ai_gateway",
      "agentos.ai.runtime": "pi",
      "agentos.ai.status_class": "success",
      "agentos.ai.stream.outcome": "completed",
    });
    expect(log).toEqual(span);

    const serialized = JSON.stringify({ span, metric, log });
    expect(serialized).not.toContain(seededPrompt);
    expect(serialized).not.toContain(seededToken);
    expect(serialized).not.toContain(seededProviderIdentity);
  }));

  it.effect("rejects invalid values even when their keys are allowlisted", () => Effect.sync(() => {
    expect(
      safeTelemetryAttributes(
        {
          "agentos.ai.runtime": "pi-or-secret",
          "agentos.ai.route": "provider-account@example.test",
          "agentos.ai.request.kind": "arbitrary-extension-name",
          "agentos.ai.compaction.path": "request-body",
          "agentos.ai.model.family": "SEED_PROMPT",
          "agentos.ai.route.slot": "../provider-private",
          "agentos.ai.request.attempt_id": "x".repeat(129),
        },
        "span",
      ),
    ).toEqual({});
  }));

  it.effect("keeps canonical workload attribution correlated but out of metric labels", () => Effect.sync(() => {
    const input = {
      "agentos.identity.agent_id":
        "10000000-0000-4000-8000-000000000001",
      "agentos.identity.assignment_id":
        "20000000-0000-4000-8000-000000000001",
      "agentos.authz.decision_ref":
        "decision_22222222222222222222222222222222",
      "agentos.authz.profile_id": "openai-responses",
      "agentos.authz.profile_version": 7,
      "agentos.authz.rate_class": "standard",
    };
    expect(safeTelemetryAttributes(input, "span")).toEqual(input);
    expect(safeTelemetryAttributes(input, "log")).toEqual(input);
    expect(safeTelemetryAttributes(input, "metric")).toEqual({});
  }));
});
