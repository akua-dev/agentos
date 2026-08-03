import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  DISPOSABLE_PROTOCOL_RESILIENCE_SCENARIOS,
  PROTOCOL_RESILIENCE_SCENARIOS,
  protocolResilienceScenarioDefinition,
  type ProtocolResilienceObservationV1,
  type ProtocolResilienceRunV1,
  type ProtocolResilienceScenarioId,
} from "../../protocol/resilience-conformance.ts";
import {
  AGENTOS_RESILIENCE_SCENARIOS,
  AgentOSResilienceGateError,
  agentOSResilienceScenarioDefinition,
  compileAgentOSResilienceVerdict,
  type AgentOSResilienceObservationV1,
  type AgentOSResilienceRunV1,
  type AgentOSResilienceScenarioId,
} from "../conformance.ts";

const Revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AgentId = "10000000-0000-4000-8000-000000000001";
const AssignmentId = "20000000-0000-4000-8000-000000000001";
const DigestA = `sha256:${"a".repeat(64)}`;
const DigestB = `sha256:${"b".repeat(64)}`;

function protocolObservation(
  scenario: ProtocolResilienceScenarioId,
): ProtocolResilienceObservationV1 {
  const definition = protocolResilienceScenarioDefinition(scenario);
  const protocol = scenario.startsWith("acp.") ? "acp" : "a2a";
  const revocation = [
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
    revocationMillis: revocation ? 15_000 : null,
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

function protocolRun(): ProtocolResilienceRunV1 {
  return {
    version: 1,
    revision: Revision,
    environment: {
      isolation: "disposable",
      context: "kind-agentos-resilience-84",
      approvalReference: "approval:issue-84-parent-gate",
      productionEndpointContacted: false,
      destroyedAfterRun: true,
    },
    images: [
      { name: "agentos", digest: DigestA },
      { name: "agentgateway", digest: DigestB },
      { name: "openfga", digest: `sha256:${"c".repeat(64)}` },
      { name: "postgresql", digest: `sha256:${"d".repeat(64)}` },
      { name: "kubernetes-node", digest: `sha256:${"e".repeat(64)}` },
    ],
    observations: PROTOCOL_RESILIENCE_SCENARIOS.map(protocolObservation),
  };
}

function observation(
  scenario: AgentOSResilienceScenarioId,
): AgentOSResilienceObservationV1 {
  const definition = agentOSResilienceScenarioDefinition(scenario);
  return {
    version: 1,
    scenario,
    source: definition.minimumSource,
    status: "observed",
    outcome: definition.outcome,
    failureClass: definition.failureClass,
    recovery: definition.recovery,
    rollback: definition.rollback,
    authorities: definition.authorities,
    attachable: definition.requiresAttachable,
    observable: true,
    workloadSpecDigest: definition.requiresWorkloadDigests ? DigestA : null,
    renderDigest: definition.requiresWorkloadDigests ? DigestB : null,
    trace: {
      protected: true,
      metricDimensions: [
        "component",
        "operation",
        "outcome",
        "failure_class",
        "recovery",
      ],
      observedContent: [],
    },
  };
}

function completeRun(): AgentOSResilienceRunV1 {
  return {
    version: 1,
    revision: Revision,
    environment: {
      isolation: "disposable",
      context: "kind-agentos-resilience-84",
      approvalReference: "approval:issue-84-parent-gate",
      productionEndpointContacted: false,
      destroyedAfterRun: true,
    },
    images: protocolRun().images,
    observations: AGENTOS_RESILIENCE_SCENARIOS.map(observation),
    protocol: protocolRun(),
  };
}

function gateFailure(input: unknown) {
  return compileAgentOSResilienceVerdict(input).pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => assert.instanceOf(failure, AgentOSResilienceGateError))
    ),
  );
}

describe("AgentOS resilience parent hard gate", () => {
  it.effect("accepts the complete exact-revision Effect evidence matrix", () =>
    Effect.gen(function*() {
      const verdict = yield* compileAgentOSResilienceVerdict(completeRun());
      assert.strictEqual(verdict.version, 1);
      assert.strictEqual(verdict.eligible, true);
      assert.strictEqual(
        verdict.scenarioCount,
        AGENTOS_RESILIENCE_SCENARIOS.length +
          PROTOCOL_RESILIENCE_SCENARIOS.length,
      );
      assert.strictEqual(verdict.revision, Revision);
      assert.strictEqual(verdict.workAuthority, "postgresql");
      assert.strictEqual(verdict.sessionAuthority, "provider_native");
    }));

  it.effect("blocks missing, duplicate, unobserved, failed, and mismatched evidence", () =>
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

      const unobserved = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "gateway.provider.transport_failure"
            ? { ...item, status: "unobserved" }
            : item
        ),
      });
      assert.strictEqual(unobserved.code, "scenario_unobserved");

      const failed = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "runtime.listener.loss"
            ? { ...item, status: "failed" }
            : item
        ),
      });
      assert.strictEqual(failed.code, "scenario_failed");

      const mismatch = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "access.identity.scope_mismatch"
            ? { ...item, outcome: "succeeded" }
            : item
        ),
      });
      assert.strictEqual(mismatch.code, "outcome_mismatch");
    }));

  it.effect("blocks weak proof sources and missing digest or rollback provenance", () =>
    Effect.gen(function*() {
      const run = completeRun();
      const weak = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "workload.pvc.existing_start"
            ? { ...item, source: "effect_fixture" }
            : item
        ),
      });
      assert.strictEqual(weak.code, "proof_source_too_weak");

      const missingDigest = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "workload.apply.interrupted"
            ? { ...item, renderDigest: null }
            : item
        ),
      });
      assert.strictEqual(missingDigest.code, "digest_continuity_missing");

      const rollbackMissing = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "supervision.retry.stopped"
            ? { ...item, rollback: "unobserved" }
            : item
        ),
      });
      assert.strictEqual(rollbackMissing.code, "rollback_missing");
    }));

  it.effect("blocks production contact, cleanup loss, image drift, and revision drift", () =>
    Effect.gen(function*() {
      const run = completeRun();
      const production = yield* gateFailure({
        ...run,
        environment: { ...run.environment, productionEndpointContacted: true },
      });
      assert.strictEqual(production.code, "production_boundary_contacted");

      const cleanup = yield* gateFailure({
        ...run,
        environment: { ...run.environment, destroyedAfterRun: false },
      });
      assert.strictEqual(cleanup.code, "disposable_cleanup_missing");

      const image = yield* gateFailure({
        ...run,
        images: run.images.filter(({ name }) => name !== "agentos"),
      });
      assert.strictEqual(image.code, "image_pin_missing");

      const revision = yield* gateFailure({
        ...run,
        protocol: {
          ...run.protocol,
          revision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      });
      assert.strictEqual(revision.code, "child_evidence_drift");
    }));

  it.effect("blocks privacy, cardinality, authority, observability, and attachability drift", () =>
    Effect.gen(function*() {
      const run = completeRun();
      const leaked = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "workload.secret.privacy"
            ? {
              ...item,
              trace: { ...item.trace, observedContent: ["credential"] },
            }
            : item
        ),
      });
      assert.strictEqual(leaked.code, "content_leak");

      const dynamicMetric = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "access.identity.revocation"
            ? {
              ...item,
              trace: { ...item.trace, metricDimensions: ["assignment_id"] },
            }
            : item
        ),
      });
      assert.strictEqual(dynamicMetric.code, "metric_cardinality_violation");

      const authority = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "runtime.harness.loss"
            ? {
              ...item,
              authorities: { ...item.authorities, session: "not_applicable" },
            }
            : item
        ),
      });
      assert.strictEqual(authority.code, "authority_violation");

      const invisible = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "runtime.listener.loss"
            ? { ...item, observable: false }
            : item
        ),
      });
      assert.strictEqual(invisible.code, "observability_missing");

      const detached = yield* gateFailure({
        ...run,
        observations: run.observations.map((item) =>
          item.scenario === "workload.crewmate.replacement"
            ? { ...item, attachable: false }
            : item
        ),
      });
      assert.strictEqual(detached.code, "attachability_missing");
    }));

  it.effect("cannot replace a failed ACP or A2A child gate with parent claims", () =>
    Effect.gen(function*() {
      const run = completeRun();
      const childMissing = yield* gateFailure({
        ...run,
        protocol: {
          ...run.protocol,
          observations: run.protocol.observations.slice(1),
        },
      });
      assert.strictEqual(childMissing.code, "protocol_gate_failed");
    }));
});
