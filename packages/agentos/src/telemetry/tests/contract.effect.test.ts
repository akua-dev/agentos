import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  AGENTOS_ACCESS_ADAPTERS,
  AGENTOS_ACCESS_METRICS,
  AGENTOS_ACCESS_PROVIDER_OUTCOMES,
  AGENTOS_ACCESS_ROUTES,
  AGENTOS_AI_COMPACTION_PATHS,
  AGENTOS_AI_ERROR_CLASSES,
  AGENTOS_AI_METRICS,
  AGENTOS_AI_REQUEST_KINDS,
  AGENTOS_AI_QUOTA_OUTCOMES,
  AGENTOS_AI_ROUTE_OPERATIONS,
  AGENTOS_AI_ROUTES,
  AGENTOS_AI_RUNTIMES,
  AGENTOS_AI_STATUS_CLASSES,
  AGENTOS_AI_STREAM_OUTCOMES,
  AGENTOS_AI_TELEMETRY_CONTRACT_VERSION,
  AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS,
  AGENTOS_TELEMETRY_CONTRACT_VERSION,
  AGENTOS_TELEMETRY_DOMAINS,
  AGENTOS_TELEMETRY_EVENT_DEFINITIONS,
  AGENTOS_TELEMETRY_FORBIDDEN_ATTRIBUTE_KEYS,
  AGENTOS_TELEMETRY_METRIC_DEFINITIONS,
  AGENTOS_TELEMETRY_PROTECTED_ATTRIBUTE_KEYS,
  AGENTOS_TELEMETRY_SPANS,
  AgentOSTelemetryAttributeDefinitionV1Schema,
  AgentOSTelemetryEventDefinitionV1Schema,
  AgentOSTelemetryMetricDefinitionV1Schema,
} from "../contract.ts";
import {
  classifyAIError,
  classifyAIStatus,
  safeEventAttributes,
  safeMetricAttributes,
  safeTelemetryAttributes,
  type AgentOSTelemetrySignal,
} from "../privacy.ts";

describe("AgentOS Fleet telemetry contract v1", () => {
  it.effect("keeps provider-access correlation finite on metrics and detailed on spans", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(AGENTOS_ACCESS_ROUTES, [
        "openai_responses",
        "openai_compaction",
        "github_rest",
        "github_graphql",
        "github_git",
        "unknown",
      ]);
      assert.includeMembers([...AGENTOS_ACCESS_ADAPTERS], [
        "egress_authz",
        "agentgateway_openai",
        "agentgateway_github",
        "ai_gateway",
        "github_broker",
      ]);
      assert.deepStrictEqual(AGENTOS_ACCESS_PROVIDER_OUTCOMES, [
        "unobserved",
        "not_forwarded",
        "completed",
        "provider_rejected",
        "transport_failed",
        "cancelled",
      ]);
      const input = {
        "agentos.access.route": "github_rest",
        "agentos.access.adapter": "github_broker",
        "agentos.access.provider": "github",
        "agentos.access.provider.outcome": "completed",
        "agentos.identity.agent_id":
          "10000000-0000-4000-8000-000000000001",
        "agentos.identity.assignment_id":
          "20000000-0000-4000-8000-000000000001",
        "agentos.authz.decision_ref":
          "decision_22222222222222222222222222222222",
        "agentos.authz.profile_id": "github-maintainer",
      };
      assert.deepStrictEqual(
        safeMetricAttributes(AGENTOS_ACCESS_METRICS.providerOperations, input),
        {
          "agentos.access.adapter": "github_broker",
          "agentos.access.provider": "github",
          "agentos.access.provider.outcome": "completed",
          "agentos.access.route": "github_rest",
        },
      );
      assert.deepStrictEqual(safeTelemetryAttributes(input, "span"), input);
    }));

  it.effect("publishes the complete bounded vocabulary", () => Effect.sync(() => {
    expect(AGENTOS_AI_TELEMETRY_CONTRACT_VERSION).toBe(1);
    expect(AGENTOS_AI_RUNTIMES).toEqual(["pi", "codex"]);
    expect(AGENTOS_AI_ROUTES).toEqual(["direct", "ai_gateway"]);
    expect(AGENTOS_AI_ROUTE_OPERATIONS).toEqual([
      "acquire",
      "reserve",
      "block",
      "release",
    ]);
    expect(AGENTOS_AI_QUOTA_OUTCOMES).toEqual([
      "cache_hit",
      "fresh",
      "stale",
      "failed",
    ]);
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
    expect(classifyAIError({ code: "provider_unavailable" })).toBe(
      "transport",
    );
    expect(classifyAIError({ code: "provider_stream_failed" })).toBe(
      "transport",
    );
    expect(classifyAIError({ code: "provider_timeout" })).toBe("timeout");
    expect(classifyAIError({ code: "provider_transport_failed" })).toBe(
      "transport",
    );
    expect(classifyAIError({ code: "provider_protocol_failed" })).toBe(
      "protocol",
    );
    expect(classifyAIError({ code: "provider_decode_failed" })).toBe(
      "decode",
    );
    expect(classifyAIError({ code: "request_invalid" })).toBe("protocol");
    expect(classifyAIError({ code: "invalid_configuration" })).toBe(
      "protocol",
    );
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

  it.effect("allows bounded runtime identity on resources without metric leakage", () =>
    Effect.sync(() => {
      const input = {
        "agentos.telemetry.contract.version": 1,
        "agentos.ai.runtime": "pi",
        "agentos.ai.runtime.version": "0.81.1",
      };
      assert.deepStrictEqual(
        safeTelemetryAttributes(input, "resource"),
        input,
      );
      assert.deepStrictEqual(
        safeMetricAttributes(AGENTOS_AI_METRICS.operations, input),
        { "agentos.ai.runtime": "pi" },
      );
    }));

  it.effect("publishes one Fleet contract across every instrumentation domain", () =>
    Effect.sync(() => {
      assert.strictEqual(AGENTOS_TELEMETRY_CONTRACT_VERSION, 1);
      assert.strictEqual(
        AGENTOS_AI_TELEMETRY_CONTRACT_VERSION,
        AGENTOS_TELEMETRY_CONTRACT_VERSION,
      );
      assert.deepStrictEqual(AGENTOS_TELEMETRY_DOMAINS, [
        "runtime",
        "ai",
        "compaction",
        "memory",
        "access",
        "protocol",
        "topology",
        "readiness",
        "recovery",
        "telemetry_pipeline",
      ]);
      assert.deepStrictEqual(AGENTOS_TELEMETRY_SPANS, {
        accessAgentGateway: "agentos.access.agentgateway",
        accessAuthorization: "agentos.access.authorization",
        accessCredentialRelease: "agentos.access.credential.release",
        accessHttp: "agentos.access.http",
        accessMcp: "agentos.access.mcp",
        accessProvider: "agentos.access.provider",
        accessProviderAdapter: "agentos.access.provider_adapter",
        aiGatewayAuthenticate: "ai-gateway.authenticate",
        aiGatewayRequest: "ai-gateway.request",
        aiGatewayQuotaRefresh: "ai-gateway.quota.refresh",
        aiGatewayRouteAcquire: "ai-gateway.route.acquire",
        aiGatewayRouteRelease: "ai-gateway.route.release",
        aiGatewayStream: "ai-gateway.stream",
        aiGatewayUpstream: "ai-gateway.upstream",
        aiOperation: "agentos.ai.operation",
        aiProviderAttempt: "agentos.ai.provider.attempt",
        compactionOperation: "agentos.compaction.operation",
        memoryOperation: "agentos.memory.operation",
        protocolOperation: "agentos.protocol.operation",
        readinessCheck: "agentos.readiness.check",
        resilienceApply: "agentos.resilience.apply",
        resilienceCapacity: "agentos.resilience.capacity",
        resilienceListener: "agentos.resilience.listener",
        resilienceOperation: "agentos.resilience.operation",
        resilienceOutcome: "agentos.resilience.outcome",
        resiliencePlacement: "agentos.resilience.placement",
        resilienceProtocol: "agentos.resilience.protocol",
        resilienceProvider: "agentos.resilience.provider",
        resilienceReadiness: "agentos.resilience.readiness",
        resilienceReconciliation: "agentos.resilience.reconciliation",
        resilienceRender: "agentos.resilience.render",
        resilienceSession: "agentos.resilience.session",
        resilienceTopologyDecision: "agentos.resilience.topology_decision",
        resilienceWorkloadPlan: "agentos.resilience.workload_plan",
        telemetryPipeline: "agentos.telemetry.pipeline",
        topologyDecision: "agentos.topology.decision",
      });
    }));

  it.effect("defines sensitivity, cardinality, source, and value rules for every attribute", () =>
    Effect.gen(function*() {
      const definitions = Object.values(
        AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS,
      );
      assert.isAbove(definitions.length, 40);
      for (const [key, definition] of Object.entries(
        AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS,
      )) {
        assert.strictEqual(key, definition.name);
        const decoded = yield* Schema.decodeUnknownEffect(
          AgentOSTelemetryAttributeDefinitionV1Schema,
          { onExcessProperty: "error" },
        )(definition);
        assert.strictEqual(decoded.name, definition.name);
        assert.include(AGENTOS_TELEMETRY_DOMAINS, definition.owner);
        if (definition.signals.includes("metric")) {
          assert.notStrictEqual(definition.cardinality, "unbounded");
          assert.notStrictEqual(definition.sensitivity, "restricted");
        }
      }
    }));

  it.effect("owns every resilience projection and the protected correlation boundary", () =>
    Effect.sync(() => {
      for (const name of [
        "agentos.resilience.failure.class",
        "agentos.resilience.attempt",
        "agentos.resilience.topology.action",
        "agentos.resilience.topology.reason",
        "agentos.resilience.runtime.action",
        "agentos.resilience.workload.profile",
        "agentos.resilience.workload.spec_version",
        "agentos.resilience.journal.phase",
        "agentos.resilience.protocol",
        "agentos.resilience.topology.proposal_id",
        "agentos.resilience.pod.uid",
        "agentos.resilience.pvc.uid",
        "agentos.resilience.session.id",
        "agentos.resilience.protocol.id",
      ]) {
        assert.isDefined(AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS[name], name);
      }

      const protectedFromDefinitions = Object.values(
        AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS,
      )
        .filter((definition) =>
          definition.sensitivity === "restricted" ||
          definition.cardinality === "unbounded"
        )
        .map(({ name }) => name)
        .sort();
      assert.deepStrictEqual(
        [...AGENTOS_TELEMETRY_PROTECTED_ATTRIBUTE_KEYS].sort(),
        protectedFromDefinitions,
      );
      assert.include(
        AGENTOS_TELEMETRY_PROTECTED_ATTRIBUTE_KEYS,
        "agentos.identity.agent_id",
      );
      assert.include(
        AGENTOS_TELEMETRY_PROTECTED_ATTRIBUTE_KEYS,
        "agentos.memory.topic_id",
      );
    }));

  it.effect("defines owned units, instruments, labels, buckets, and cost semantics per metric", () =>
    Effect.gen(function*() {
      const definitions = Object.values(AGENTOS_TELEMETRY_METRIC_DEFINITIONS);
      assert.isAbove(definitions.length, 20);
      for (const [key, definition] of Object.entries(
        AGENTOS_TELEMETRY_METRIC_DEFINITIONS,
      )) {
        assert.strictEqual(key, definition.name);
        assert.strictEqual(
          new Set(definition.labels).size,
          definition.labels.length,
        );
        const decoded = yield* Schema.decodeUnknownEffect(
          AgentOSTelemetryMetricDefinitionV1Schema,
          { onExcessProperty: "error" },
        )(definition);
        assert.strictEqual(decoded.name, definition.name);
        assert.isAbove(definition.labels.length, 0);
        for (const label of definition.labels) {
          const attribute = AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS[label];
          assert.isDefined(attribute);
          assert.include(attribute?.signals ?? [], "metric");
        }
        if (definition.instrument === "histogram") {
          assert.isAbove(definition.histogramBoundaries.length, 0);
        } else {
          assert.deepStrictEqual(definition.histogramBoundaries, []);
        }
      }

      assert.deepStrictEqual(
        AGENTOS_TELEMETRY_METRIC_DEFINITIONS[AGENTOS_AI_METRICS.operations],
        {
          name: "agentos.ai.operations",
          owner: "ai",
          instrument: "counter",
          unit: "{operation}",
          labels: [
            "agentos.ai.runtime",
            "agentos.ai.route",
            "agentos.ai.request.kind",
            "agentos.ai.model.family",
            "agentos.ai.status_class",
            "agentos.ai.error.class",
          ],
          histogramBoundaries: [],
          valueSemantics: "completed_operations",
        },
      );
      assert.deepStrictEqual(
        AGENTOS_TELEMETRY_METRIC_DEFINITIONS["agentos.ai.cost"],
        {
          name: "agentos.ai.cost",
          owner: "ai",
          instrument: "counter",
          unit: "{USD}",
          labels: [
            "agentos.ai.runtime",
            "agentos.ai.route",
            "agentos.ai.request.kind",
            "agentos.ai.cost.source",
          ],
          histogramBoundaries: [],
          valueSemantics: "modeled_catalog_cost_not_invoice_truth",
        },
      );
      assert.include(
        AGENTOS_TELEMETRY_METRIC_DEFINITIONS[
          AGENTOS_AI_METRICS.providerAttempts
        ]?.labels ?? [],
        "agentos.ai.compaction.path",
      );
      assert.deepStrictEqual(
        AGENTOS_TELEMETRY_METRIC_DEFINITIONS[
          AGENTOS_AI_METRICS.routeEvents
        ],
        {
          name: "agentos.ai.route.events",
          owner: "ai",
          instrument: "counter",
          unit: "{event}",
          labels: [
            "agentos.ai.route",
            "agentos.ai.route.operation",
            "agentos.ai.status_class",
            "agentos.ai.error.class",
          ],
          histogramBoundaries: [],
          valueSemantics: "completed_route_lifecycle_events",
        },
      );
      assert.deepStrictEqual(
        AGENTOS_TELEMETRY_METRIC_DEFINITIONS[
          AGENTOS_AI_METRICS.activeReservations
        ],
        {
          name: "agentos.ai.route.reservations.active",
          owner: "ai",
          instrument: "up_down_counter",
          unit: "{reservation}",
          labels: ["agentos.ai.route"],
          histogramBoundaries: [],
          valueSemantics: "currently_active_route_reservations",
        },
      );
      assert.deepStrictEqual(
        AGENTOS_TELEMETRY_METRIC_DEFINITIONS[
          AGENTOS_AI_METRICS.quotaRefreshes
        ],
        {
          name: "agentos.ai.quota.refreshes",
          owner: "ai",
          instrument: "counter",
          unit: "{refresh}",
          labels: [
            "agentos.ai.route",
            "agentos.ai.quota.outcome",
            "agentos.ai.error.class",
          ],
          histogramBoundaries: [],
          valueSemantics: "completed_quota_refresh_attempts",
        },
      );
      assert.deepStrictEqual(
        AGENTOS_TELEMETRY_METRIC_DEFINITIONS[AGENTOS_AI_METRICS.streams],
        {
          name: "agentos.ai.streams",
          owner: "ai",
          instrument: "counter",
          unit: "{stream}",
          labels: ["agentos.ai.route", "agentos.ai.stream.outcome"],
          histogramBoundaries: [],
          valueSemantics: "completed_streams",
        },
      );
    }));

  it.effect("defines owned structured log and audit events with exact attributes", () =>
    Effect.gen(function*() {
      const definitions = Object.values(AGENTOS_TELEMETRY_EVENT_DEFINITIONS);
      assert.isAbove(definitions.length, 8);
      assert.deepStrictEqual(
        new Set(definitions.map(({ signal }) => signal)),
        new Set(["log", "audit"]),
      );
      for (const [key, definition] of Object.entries(
        AGENTOS_TELEMETRY_EVENT_DEFINITIONS,
      )) {
        assert.strictEqual(key, definition.name);
        assert.strictEqual(
          new Set(definition.attributes).size,
          definition.attributes.length,
        );
        yield* Schema.decodeUnknownEffect(
          AgentOSTelemetryEventDefinitionV1Schema,
          { onExcessProperty: "error" },
        )(definition);
        for (const attributeName of definition.attributes) {
          const attribute =
            AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS[attributeName];
          assert.isDefined(attribute, attributeName);
          assert.include(attribute?.signals ?? [], definition.signal);
        }
      }
      assert.deepStrictEqual(
        safeEventAttributes("ai_gateway_failure", {
          "agentos.ai.runtime": "pi",
          "agentos.ai.route": "ai_gateway",
          "agentos.ai.status_class": "server_error",
          "agentos.ai.error.class": "overload",
          "agentos.ai.operation.id": "operation-1",
          "agentos.memory.query": "SEED_PRIVATE_MEMORY_QUERY",
          "agentos.identity.agent_id":
            "10000000-0000-4000-8000-000000000001",
        }),
        {
          "agentos.ai.error.class": "overload",
          "agentos.ai.operation.id": "operation-1",
          "agentos.ai.route": "ai_gateway",
          "agentos.ai.runtime": "pi",
          "agentos.ai.status_class": "server_error",
        },
      );
      assert.deepStrictEqual(safeEventAttributes("unknown", {}), {});
    }));

  it.effect("enforces the exact label set for each metric", () =>
    Effect.sync(() => {
      const input = {
        "agentos.ai.runtime": "pi",
        "agentos.ai.route": "ai_gateway",
        "agentos.ai.request.kind": "main",
        "agentos.ai.status_class": "success",
        "agentos.ai.error.class": "none",
        "agentos.ai.operation.id": "operation-private",
        "agentos.identity.agent_id":
          "10000000-0000-4000-8000-000000000001",
        "agentos.identity.assignment_id":
          "20000000-0000-4000-8000-000000000001",
        "agentos.authz.profile_id": "openai-responses",
      };

      assert.deepStrictEqual(
        safeMetricAttributes(AGENTOS_AI_METRICS.operations, input),
        {
          "agentos.ai.error.class": "none",
          "agentos.ai.request.kind": "main",
          "agentos.ai.route": "ai_gateway",
          "agentos.ai.runtime": "pi",
          "agentos.ai.status_class": "success",
        },
      );
      assert.deepStrictEqual(
        safeMetricAttributes("agentos.memory.operations", {
          "agentos.memory.operation": "retrieve",
          "agentos.memory.method": "hybrid",
          "agentos.memory.outcome": "degraded",
          "agentos.memory.degradation.class": "index_unavailable",
          "agentos.memory.query": "SEED_PRIVATE_MEMORY_QUERY",
          "agentos.memory.topic_id": "private-topic-id",
        }),
        {
          "agentos.memory.degradation.class": "index_unavailable",
          "agentos.memory.method": "hybrid",
          "agentos.memory.operation": "retrieve",
          "agentos.memory.outcome": "degraded",
        },
      );
      assert.deepStrictEqual(
        safeMetricAttributes("unknown.metric", input),
        {},
      );
    }));

  it.effect("rejects every seeded forbidden field from every supported signal", () =>
    Effect.sync(() => {
      const input = Object.fromEntries(
        AGENTOS_TELEMETRY_FORBIDDEN_ATTRIBUTE_KEYS.map((key, index) => [
          key,
          `SEED_PRIVATE_${index}`,
        ]),
      );
      const signals: ReadonlyArray<AgentOSTelemetrySignal> = [
        "resource",
        "span",
        "metric",
        "log",
        "audit",
      ];
      for (const signal of signals) {
        assert.deepStrictEqual(safeTelemetryAttributes(input, signal), {});
      }
      assert.deepStrictEqual(
        safeMetricAttributes("agentos.telemetry.pipeline.events", input),
        {},
      );
    }));
});
