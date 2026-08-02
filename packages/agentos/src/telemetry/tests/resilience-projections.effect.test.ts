import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";

import type { ProtocolResilienceObservationV1 } from "../../protocol/resilience-conformance.ts";
import { compileSecondMateTopologyPlan } from "../../topology/second-mate.ts";
import {
  resilienceMetricAttributes,
  resilienceProtectedAttributes,
} from "../resilience-contract.ts";
import {
  projectAgentWorkloadPlan,
  projectAssignmentExecutionObservation,
  projectNativeSessionObservation,
  projectProtocolResilienceObservation,
  projectRuntimeJournalObservation,
  projectSecondMateTopologyPlan,
  projectSemanticReadinessDiagnostic,
} from "../resilience-projections.ts";

const FirstMateId = "10000000-0000-4000-8000-000000000001";
const SecondMateId = "20000000-0000-4000-8000-000000000001";
const AssignmentId = "30000000-0000-4000-8000-000000000001";
const OperationId = "40000000-0000-4000-8000-000000000001";
const ProposalId = "50000000-0000-4000-8000-000000000001";
const DigestA = "a".repeat(64);
const DigestB = "b".repeat(64);
const DigestC = "c".repeat(64);

function charter(summary: string, scope: string) {
  return {
    version: 1,
    summary,
    scope,
    projectAccess: "non_exclusive",
    crossDomainRouting: "common_ancestor",
  };
}

const currentCharter = charter(
  "Own platform reliability outcomes",
  "Coordinate runtime, deployment, and operational reliability across products.",
);
const desiredCharter = charter(
  "Own platform and delivery reliability outcomes",
  "Coordinate runtime, deployment, delivery, and operational reliability across products.",
);

const protocolObservation: ProtocolResilienceObservationV1 = {
  version: 1,
  scenario: "a2a.recovery_listener_herdr",
  protocol: "a2a",
  source: "effect_fixture",
  observed: "fallback_recovered",
  failureClass: "target_unavailable",
  recovery: "postgresql_listener_then_herdr_wake",
  elapsedMillis: 25,
  revocationMillis: null,
  durableMutations: {
    tasks: 0,
    assignments: 0,
    inbox: 0,
    executions: 0,
    reports: 0,
  },
  custody: {
    sessionAuthority: "not_applicable",
    nativeSessionAvailable: null,
    maximumActiveWriters: 0,
    herdrAttachable: true,
    canonicalWorkAuthority: "postgresql",
  },
  trace: {
    protected: true,
    agentId: SecondMateId,
    assignmentId: AssignmentId,
    workloadId: null,
    gatewayId: "gateway-01",
    protocolId: "a2a-task-01",
    adapterId: "adapter-01",
    recoveryId: "recovery-01",
  },
  metricDimensions: ["protocol", "outcome"],
  observedContent: [],
};

layer(BunCrypto.layer)("resilience evidence projections", (it) => {
  it.effect("projects every bounded topology reason without private reasoning", () =>
    Effect.gen(function*() {
      const plan = yield* compileSecondMateTopologyPlan({
        version: 1,
        proposalId: ProposalId,
        proposedByAgentId: FirstMateId,
        action: "expand",
        observedAtMillis: 1_785_600_000_000,
        validUntilMillis: 1_785_686_400_000,
        sources: [{ agentId: SecondMateId, expectedCharter: currentCharter }],
        destinations: [{
          kind: "existing",
          agentId: SecondMateId,
          desiredCharter,
        }],
        reasons: ["persistent_load", "routing_ambiguity"],
        signals: [{
          authority: "postgresql",
          kind: "assignment_load",
          observation: "observed",
          trend: "rising",
        }],
        invariants: {
          projectAccess: "non_exclusive",
          crossDomainRouting: "common_ancestor",
          lateralDelivery: "forbidden",
          automaticScheduling: "forbidden",
        },
      });
      const observations = yield* projectSecondMateTopologyPlan(plan, {
        assignmentId: null,
        operationId: OperationId,
      });

      expect(observations.map(({ topologyReason }) => topologyReason)).toEqual([
        "persistent_load",
        "routing_ambiguity",
      ]);
      expect(observations[0]).toMatchObject({
        phase: "topology_decision",
        source: "topology_plan",
        topologyAction: "expand",
        protected: {
          agentId: FirstMateId,
          assignmentId: null,
          operationId: OperationId,
          proposalId: ProposalId,
        },
      });
      expect(JSON.stringify(observations)).not.toContain(currentCharter.scope);
      expect(JSON.stringify(observations)).not.toContain(desiredCharter.scope);
    }),
  );

  it.effect("projects workload spec and overlay digests without calling either a render or apply boundary", () =>
    Effect.gen(function*() {
      const observation = yield* projectAgentWorkloadPlan({
        action: "provision",
        operationId: OperationId,
        summary: {
          agentId: SecondMateId,
          assignmentId: AssignmentId,
          profileId: "interactive-crewmate@v1",
          specVersion: 1,
          specDigest: DigestA,
          overlayDigest: DigestB,
        },
      });

      expect(observation).toMatchObject({
        source: "workload_plan",
        phase: "workload_plan",
        runtimeAction: "provision",
        workloadSpecDigest: DigestA,
        workloadOverlayDigest: DigestB,
        renderedManifestDigest: null,
      });
      expect(JSON.stringify(observation)).not.toContain("apiVersion");
    }),
  );

  it.effect("maps the SQL journal phase and reviewed render digest into repair-forward evidence", () =>
    Effect.gen(function*() {
      const observation = yield* projectRuntimeJournalObservation({
        version: 1,
        action: "recover",
        phase: "recovery_required",
        attempt: 2,
        cause: "placement",
        recovery: "repair_forward",
        agentId: SecondMateId,
        assignmentId: AssignmentId,
        operationId: OperationId,
        renderedManifestDigest: DigestC,
        podUid: null,
        pvcUid: "60000000-0000-4000-8000-000000000001",
        sessionId: "pi-session-01",
      });

      expect(observation).toMatchObject({
        source: "runtime_journal",
        phase: "reconciliation",
        outcome: "degraded",
        cause: "placement",
        recovery: "repair_forward",
        runtimeAction: "recover",
        journalPhase: "recovery_required",
        renderedManifestDigest: DigestC,
      });
    }),
  );

  it.effect("rejects journal states whose cause and recovery contradict the durable phase", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(projectRuntimeJournalObservation({
        version: 1,
        action: "rollout",
        phase: "applied",
        attempt: 1,
        cause: "placement",
        recovery: "repair_forward",
        agentId: SecondMateId,
        assignmentId: AssignmentId,
        operationId: OperationId,
        renderedManifestDigest: DigestC,
        podUid: null,
        pvcUid: null,
        sessionId: null,
      }));

      expect(error).toMatchObject({
        _tag: "ResilienceProjectionError",
        code: "invalid_input",
        field: "$.phase",
      });
    }),
  );

  it.effect("maps semantic readiness reasons to one bounded cause class", () =>
    Effect.gen(function*() {
      const observation = yield* projectSemanticReadinessDiagnostic({
        diagnostic: {
          version: 1,
          role: "second_mate",
          mode: "ready",
          status: "not_ready",
          checks: [{ component: "coordination", status: "fail" }],
          reasons: [{
            component: "coordination",
            code: "coordination_listener_missing",
          }],
        },
        attempt: 1,
        protected: {
          agentId: SecondMateId,
          assignmentId: AssignmentId,
          operationId: OperationId,
          proposalId: null,
          podUid: null,
          pvcUid: null,
          sessionId: "pi-session-01",
          protocolId: null,
        },
      });

      expect(observation).toMatchObject({
        source: "semantic_readiness",
        phase: "readiness",
        outcome: "failed",
        cause: "listener",
        recovery: "retry",
      });
      expect(JSON.stringify(observation)).not.toContain(
        "coordination_listener_missing",
      );
    }),
  );

  it.effect("decodes semantic readiness through its closed Effect Schema", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(projectSemanticReadinessDiagnostic({
        diagnostic: {
          version: 1,
          role: "second_mate",
          mode: "ready",
          status: "not_ready",
          checks: [{ component: "coordination", status: "fail" }],
          reasons: [{
            component: "coordination",
            code: "arbitrary_private_reason",
          }],
        },
        attempt: 1,
        protected: {
          agentId: SecondMateId,
          assignmentId: AssignmentId,
          operationId: OperationId,
          proposalId: null,
          podUid: null,
          pvcUid: null,
          sessionId: "pi-session-01",
          protocolId: null,
        },
      }));

      expect(error).toMatchObject({
        _tag: "ResilienceProjectionError",
        code: "invalid_input",
        field: "$.diagnostic",
      });
    }),
  );

  it.effect("projects native-session availability without transcript or pane payload", () =>
    Effect.gen(function*() {
      const observation = yield* projectNativeSessionObservation({
        version: 1,
        state: "resumed",
        attempt: 1,
        agentId: SecondMateId,
        assignmentId: AssignmentId,
        operationId: OperationId,
        sessionId: "pi-session-01",
      });
      expect(observation).toMatchObject({
        source: "native_session",
        phase: "session",
        evidence: "observed",
        outcome: "recovered",
        cause: "native_session",
        recovery: "native_session_resume",
      });
    }),
  );

  it.effect("projects ACP/A2A fallback from the released conformance observation", () =>
    Effect.gen(function*() {
      const observation = yield* projectProtocolResilienceObservation(
        protocolObservation,
        { operationId: OperationId },
      );
      expect(observation).toMatchObject({
        source: "a2a",
        phase: "protocol",
        evidence: "observed",
        outcome: "recovered",
        cause: "protocol_adapter",
        recovery: "postgresql_listener_then_herdr_wake",
        protocol: "a2a",
        protected: {
          agentId: SecondMateId,
          assignmentId: AssignmentId,
          operationId: OperationId,
          protocolId: "a2a-task-01",
        },
      });
    }),
  );

  it.effect("projects retry exhaustion and recovery without high-cardinality metric labels", () =>
    Effect.gen(function*() {
      const exhausted = yield* projectAssignmentExecutionObservation({
        version: 1,
        state: "exhausted",
        failureClass: "transport",
        retryCeiling: 5,
        attemptsObserved: 5,
        recoveryAction: null,
        agentId: SecondMateId,
        assignmentId: AssignmentId,
        operationId: OperationId,
        nativeSessionRef: "codex:thread-retry-1",
        replacementAssignmentId: null,
      });
      expect(exhausted).toMatchObject({
        source: "assignment",
        phase: "outcome",
        outcome: "blocked",
        cause: "retry_exhausted",
        failureClass: "transport",
        recovery: "awaiting_supervisor",
        attempt: 5,
      });

      const resumed = yield* projectAssignmentExecutionObservation({
        version: 1,
        state: "resumed",
        failureClass: "transport",
        retryCeiling: 5,
        attemptsObserved: 5,
        recoveryAction: "resume",
        agentId: SecondMateId,
        assignmentId: AssignmentId,
        operationId: OperationId,
        nativeSessionRef: "codex:thread-retry-1",
        replacementAssignmentId: null,
      });
      expect(resumed).toMatchObject({
        outcome: "recovered",
        recovery: "native_session_resume",
      });

      const metricAttributes = resilienceMetricAttributes(resumed);
      expect(metricAttributes).toMatchObject({
        "agentos.resilience.attempt": 5,
        "agentos.resilience.failure.class": "transport",
        "agentos.resilience.recovery": "native_session_resume",
      });
      expect(JSON.stringify(metricAttributes)).not.toContain(SecondMateId);
      expect(JSON.stringify(metricAttributes)).not.toContain(AssignmentId);
      expect(JSON.stringify(metricAttributes)).not.toContain(OperationId);
      expect(JSON.stringify(metricAttributes)).not.toContain("codex:thread-retry-1");
      expect(resilienceProtectedAttributes(resumed)).toMatchObject({
        "agentos.identity.agent_id": SecondMateId,
        "agentos.identity.assignment_id": AssignmentId,
        "agentos.resilience.operation.id": OperationId,
        "agentos.resilience.session.id": "codex:thread-retry-1",
      });
    }),
  );
});
