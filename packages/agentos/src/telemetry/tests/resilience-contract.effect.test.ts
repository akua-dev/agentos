import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  decodeResilienceObservation,
  resilienceMetricAttributes,
  resilienceProtectedAttributes,
  type ResilienceObservationV1,
} from "../resilience-contract.ts";

const AgentId = "11111111-1111-4111-8111-111111111111";
const AssignmentId = "22222222-2222-4222-8222-222222222222";
const OperationId = "33333333-3333-4333-8333-333333333333";
const PodUid = "44444444-4444-4444-8444-444444444444";
const PvcUid = "55555555-5555-4555-8555-555555555555";
const ProposalId = "66666666-6666-4666-8666-666666666666";
const DigestA = "a".repeat(64);
const DigestB = "b".repeat(64);

const validObservation: ResilienceObservationV1 = {
  version: 1,
  source: "runtime_journal",
  phase: "reconciliation",
  evidence: "observed",
  outcome: "degraded",
  cause: "conflicting_workload_plan",
  failureClass: null,
  recovery: "repair_forward",
  attempt: 2,
  topologyAction: null,
  topologyReason: null,
  runtimeAction: "recover",
  workloadProfile: "persistent-mate@v1",
  workloadSpecVersion: 1,
  workloadSpecDigest: DigestA,
  workloadOverlayDigest: null,
  renderedManifestDigest: DigestB,
  journalPhase: "recovery_required",
  protocol: null,
  protected: {
    agentId: AgentId,
    assignmentId: AssignmentId,
    operationId: OperationId,
    proposalId: ProposalId,
    podUid: PodUid,
    pvcUid: PvcUid,
    sessionId: "pi-session-01",
    protocolId: null,
  },
};

describe("delegation and recovery telemetry contract", () => {
  it.effect("decodes one closed observed recovery event", () =>
    Effect.gen(function*() {
      const decoded = yield* decodeResilienceObservation(validObservation);
      expect(decoded).toEqual(validObservation);
    }),
  );

  it.effect("keeps dynamic IDs and digests only in protected attributes", () =>
    Effect.gen(function*() {
      const decoded = yield* decodeResilienceObservation(validObservation);
      const protectedAttributes = resilienceProtectedAttributes(decoded);
      const metricAttributes = resilienceMetricAttributes(decoded);

      expect(protectedAttributes).toMatchObject({
        "agentos.identity.agent_id": AgentId,
        "agentos.identity.assignment_id": AssignmentId,
        "agentos.resilience.operation.id": OperationId,
        "agentos.resilience.pod.uid": PodUid,
        "agentos.resilience.pvc.uid": PvcUid,
        "agentos.resilience.workload.spec_digest": DigestA,
        "agentos.resilience.workload.render_digest": DigestB,
      });
      expect(metricAttributes).toEqual({
        "agentos.resilience.attempt": 2,
        "agentos.resilience.cause": "conflicting_workload_plan",
        "agentos.resilience.evidence": "observed",
        "agentos.resilience.journal.phase": "recovery_required",
        "agentos.resilience.outcome": "degraded",
        "agentos.resilience.phase": "reconciliation",
        "agentos.resilience.recovery": "repair_forward",
        "agentos.resilience.runtime.action": "recover",
        "agentos.resilience.source": "runtime_journal",
        "agentos.resilience.workload.profile": "persistent-mate@v1",
        "agentos.resilience.workload.spec_version": 1,
        "agentos.telemetry.contract.version": 1,
      });
      expect(JSON.stringify(metricAttributes)).not.toContain(AgentId);
      expect(JSON.stringify(metricAttributes)).not.toContain(AssignmentId);
      expect(JSON.stringify(metricAttributes)).not.toContain(OperationId);
      expect(JSON.stringify(metricAttributes)).not.toContain(DigestA);
      expect(JSON.stringify(metricAttributes)).not.toContain(DigestB);
    }),
  );

  it.effect("retains explicit unobserved evidence without inventing success", () =>
    Effect.gen(function*() {
      const decoded = yield* decodeResilienceObservation({
        ...validObservation,
        source: "kubernetes",
        phase: "placement",
        evidence: "unobserved",
        outcome: "unobserved",
        cause: "none",
        recovery: "unobserved",
        attempt: 0,
        workloadProfile: null,
        workloadSpecVersion: null,
        workloadSpecDigest: null,
        workloadOverlayDigest: null,
        renderedManifestDigest: null,
        journalPhase: null,
        protected: {
          agentId: AgentId,
          assignmentId: AssignmentId,
          operationId: OperationId,
          proposalId: null,
          podUid: null,
          pvcUid: null,
          sessionId: null,
          protocolId: null,
        },
      });

      expect(resilienceMetricAttributes(decoded)).toMatchObject({
        "agentos.resilience.evidence": "unobserved",
        "agentos.resilience.outcome": "unobserved",
        "agentos.resilience.recovery": "unobserved",
      });
    }),
  );

  it.effect("rejects content, secrets, unknown fields, and unbounded classes", () =>
    Effect.gen(function*() {
      for (const candidate of [
        { ...validObservation, renderedYaml: "apiVersion: v1" },
        { ...validObservation, prompt: "SEED_PRIVATE_PROMPT" },
        { ...validObservation, secret: "sk-seeded-secret" },
        { ...validObservation, cause: "arbitrary-provider-error-body" },
        { ...validObservation, failureClass: "transport" },
        {
          ...validObservation,
          cause: "retry_exhausted",
          failureClass: null,
        },
        { ...validObservation, attempt: 33 },
        {
          ...validObservation,
          evidence: "unobserved",
          outcome: "succeeded",
        },
      ]) {
        expect(yield* Effect.result(decodeResilienceObservation(candidate))).toMatchObject({
          _tag: "Failure",
        });
      }
    }),
  );

  it.effect("requires phase-specific bounded evidence", () =>
    Effect.gen(function*() {
      const topologyWithoutAction = {
        ...validObservation,
        source: "topology_plan",
        phase: "topology_decision",
        topologyAction: null,
        topologyReason: "persistent_load",
      };
      const workloadWithoutDigests = {
        ...validObservation,
        source: "workload_plan",
        phase: "workload_plan",
        workloadSpecDigest: null,
        workloadOverlayDigest: null,
        renderedManifestDigest: null,
      };
      const protocolWithoutName = {
        ...validObservation,
        source: "a2a",
        phase: "protocol",
        protocol: null,
      };

      for (const candidate of [
        topologyWithoutAction,
        workloadWithoutDigests,
        protocolWithoutName,
      ]) {
        expect(yield* Effect.result(decodeResilienceObservation(candidate))).toMatchObject({
          _tag: "Failure",
        });
      }
    }),
  );
});
