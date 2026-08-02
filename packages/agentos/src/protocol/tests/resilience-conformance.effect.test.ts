import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  DISPOSABLE_PROTOCOL_RESILIENCE_SCENARIOS,
  PROTOCOL_RESILIENCE_SCENARIOS,
  ProtocolResilienceGateError,
  compileProtocolResilienceVerdict,
  protocolResilienceScenarioDefinition,
  type ProtocolResilienceObservationV1,
  type ProtocolResilienceRunV1,
  type ProtocolResilienceScenarioId,
} from "../resilience-conformance.ts";

const AgentId = "10000000-0000-4000-8000-000000000001";
const AssignmentId = "20000000-0000-4000-8000-000000000001";

function observation(
  scenario: ProtocolResilienceScenarioId,
): ProtocolResilienceObservationV1 {
  const definition = protocolResilienceScenarioDefinition(scenario);
  const protocol = scenario.startsWith("acp.") ? "acp" : "a2a";
  const requiresRevocationMeasurement = [
    "a2a.denied_inactive_assignment",
    "a2a.denied_revoked_profile",
    "a2a.denied_expired_identity",
  ].includes(scenario);
  return {
    version: 1,
    scenario,
    protocol,
    source: DISPOSABLE_PROTOCOL_RESILIENCE_SCENARIOS.some((candidate) =>
        candidate === scenario
      )
      ? "disposable_kubernetes"
      : "effect_fixture",
    observed: definition.expected,
    failureClass: definition.failureClass,
    recovery: definition.recovery,
    elapsedMillis: 25,
    revocationMillis: requiresRevocationMeasurement ? 15_000 : null,
    durableMutations: {
      tasks: 0,
      assignments: 0,
      inbox: 0,
      executions: 0,
      reports: 0,
    },
    custody: {
      sessionAuthority: protocol === "acp" ? "provider_native" : "not_applicable",
      nativeSessionAvailable: protocol === "acp" ? true : null,
      maximumActiveWriters: protocol === "acp" ? 1 : 0,
      herdrAttachable: true,
      canonicalWorkAuthority: "postgresql",
    },
    trace: {
      protected: true,
      agentId: AgentId,
      assignmentId: AssignmentId,
      workloadId: "workload-pod-uid-1",
      gatewayId: protocol === "a2a" ? "gateway-request-1" : null,
      protocolId: `protocol-${scenario.replaceAll(".", "-")}`,
      adapterId: "adapter-instance-1",
      recoveryId: definition.recovery === "not_required"
        ? null
        : "recovery-inbox-1",
    },
    metricDimensions: [
      "protocol",
      "operation",
      "outcome",
      "failure_class",
      "recovery",
    ],
    observedContent: [],
  };
}

function completeRun(): ProtocolResilienceRunV1 {
  return {
    version: 1,
    revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    environment: {
      isolation: "disposable",
      context: "kind-agentos-protocol-130",
      approvalReference: "approval:issue-130-disposable",
      productionEndpointContacted: false,
      destroyedAfterRun: true,
    },
    images: [
      { name: "agentos", digest: `sha256:${"a".repeat(64)}` },
      { name: "agentgateway", digest: `sha256:${"b".repeat(64)}` },
      { name: "openfga", digest: `sha256:${"c".repeat(64)}` },
      { name: "postgresql", digest: `sha256:${"d".repeat(64)}` },
      { name: "kubernetes-node", digest: `sha256:${"e".repeat(64)}` },
    ],
    observations: PROTOCOL_RESILIENCE_SCENARIOS.map(observation),
  };
}

function gateFailure(input: unknown) {
  return compileProtocolResilienceVerdict(input).pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => assert.instanceOf(failure, ProtocolResilienceGateError))
    ),
  );
}

describe("ACP/A2A resilience conformance gate", () => {
  it.effect("accepts the complete disposable and deterministic protocol matrix", () =>
    Effect.gen(function*() {
      const verdict = yield* compileProtocolResilienceVerdict(completeRun());
      assert.deepStrictEqual(verdict, {
        version: 1,
        eligible: true,
        scenarioCount: PROTOCOL_RESILIENCE_SCENARIOS.length,
        effectFixtureCount:
          PROTOCOL_RESILIENCE_SCENARIOS.length -
          DISPOSABLE_PROTOCOL_RESILIENCE_SCENARIOS.length,
        disposableKubernetesCount:
          DISPOSABLE_PROTOCOL_RESILIENCE_SCENARIOS.length,
        revocationSloMillis: 60_000,
        workAuthority: "postgresql",
        sessionAuthority: "provider_native",
      });
    }));

  it.effect("blocks missing, duplicate, and semantically mismatched scenarios", () =>
    Effect.gen(function*() {
      const run = completeRun();
      const missing = yield* gateFailure({
        ...run,
        observations: run.observations.slice(1),
      });
      assert.strictEqual(missing.code, "scenario_missing");

      const duplicate = yield* gateFailure({
        ...run,
        observations: [...run.observations, run.observations[0]],
      });
      assert.strictEqual(duplicate.code, "scenario_duplicate");

      const mismatch = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "a2a.streaming_rejected"
            ? { ...item, observed: "succeeded" }
            : item
        ),
      });
      assert.strictEqual(mismatch.code, "outcome_mismatch");
    }));

  it.effect("blocks shadow durable state and ACP dual-writer custody", () =>
    Effect.gen(function*() {
      const run = completeRun();
      const shadowWrite = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "a2a.invoke"
            ? {
              ...item,
              durableMutations: { ...item.durableMutations, tasks: 1 },
            }
            : item
        ),
      });
      assert.strictEqual(shadowWrite.code, "custody_violation");

      const dualWriter = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "acp.pi.dual_writer_rejected"
            ? {
              ...item,
              custody: { ...item.custody, maximumActiveWriters: 2 },
            }
            : item
        ),
      });
      assert.strictEqual(dualWriter.code, "custody_violation");
    }));

  it.effect("blocks slow revocation, content leakage, dynamic metrics, and open traces", () =>
    Effect.gen(function*() {
      const run = completeRun();
      const slowRevocation = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "a2a.denied_revoked_profile"
            ? { ...item, revocationMillis: 60_001 }
            : item
        ),
      });
      assert.strictEqual(slowRevocation.code, "revocation_slo_exceeded");

      const contentLeak = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "a2a.privacy_rejection"
            ? { ...item, observedContent: ["prompt"] }
            : item
        ),
      });
      assert.strictEqual(contentLeak.code, "content_leak");

      const dynamicMetric = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "a2a.telemetry_cardinality"
            ? { ...item, metricDimensions: ["agent_id"] }
            : item
        ),
      });
      assert.strictEqual(dynamicMetric.code, "metric_cardinality_violation");

      const openTrace = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "acp.codex.resume"
            ? { ...item, trace: { ...item.trace, protected: false } }
            : item
        ),
      });
      assert.strictEqual(openTrace.code, "trace_not_protected");
    }));

  it.effect("requires exact disposable sources, image pins, and teardown evidence", () =>
    Effect.gen(function*() {
      const run = completeRun();
      const fixtureOnly = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) => ({
          ...item,
          source: "effect_fixture",
        })),
      });
      assert.strictEqual(fixtureOnly.code, "disposable_observation_missing");

      const notDestroyed = yield* gateFailure({
        ...run,
        environment: { ...run.environment, destroyedAfterRun: false },
      });
      assert.strictEqual(notDestroyed.code, "disposable_cleanup_missing");

      const missingImage = yield* gateFailure({
        ...run,
        images: run.images.filter(({ name }) => name !== "openfga"),
      });
      assert.strictEqual(missingImage.code, "image_pin_missing");
    }));

  it.effect("requires complete correlation on each protocol and recovery trace", () =>
    Effect.gen(function*() {
      const run = completeRun();
      const missingProtocolCorrelation = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "acp.pi.prompt"
            ? { ...item, trace: { ...item.trace, assignmentId: null } }
            : item
        ),
      });
      assert.strictEqual(
        missingProtocolCorrelation.code,
        "trace_continuity_missing",
      );

      const missingGatewayCorrelation = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "a2a.invoke"
            ? { ...item, trace: { ...item.trace, gatewayId: null } }
            : item
        ),
      });
      assert.strictEqual(
        missingGatewayCorrelation.code,
        "trace_continuity_missing",
      );

      const missingRecoveryCorrelation = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "acp.codex.adapter_loss"
            ? { ...item, trace: { ...item.trace, recoveryId: null } }
            : item
        ),
      });
      assert.strictEqual(
        missingRecoveryCorrelation.code,
        "trace_continuity_missing",
      );
    }));
});
