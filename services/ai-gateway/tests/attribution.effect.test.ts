import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import { assert, describe, layer } from "@effect/vitest";
import type { ProviderAuthorizationGrantV1 } from "@akua-dev/agentos";
import { Effect } from "effect";

import {
  attributedSessionKey,
  gatewayRequestAttribution,
} from "../src/attribution.ts";

const AgentId = "10000000-0000-4000-8000-000000000001";
const AssignmentId = "20000000-0000-4000-8000-000000000001";

function grant(
  assignmentId: string | null = AssignmentId,
): Extract<ProviderAuthorizationGrantV1, { readonly profile: unknown }> {
  return {
    schemaVersion: 1,
    correlationId: "corr_44444444444444444444444444444444",
    decisionRef: "decision_22222222222222222222222222222222",
    expiresAtMillis: 1_785_586_015_000,
    credentialDomain: "openai-responses",
    identity: {
      agentId: AgentId,
      role: assignmentId === null ? "second_mate" : "crewmate",
      fleet: "agentos",
      domain: "engineering",
      assignmentId,
    },
    capability: "openai.responses.create",
    resource: {
      kind: "provider_service",
      provider: "openai",
      service: "responses",
    },
    profile: { profileId: "openai-responses", profileVersion: 7 },
    ceiling: {
      ceilingId: "ceiling_33333333333333333333333333333333",
      revision: 9,
    },
    rateClass: "standard",
  };
}

function workloadGrant(): Extract<
  ProviderAuthorizationGrantV1,
  { readonly model: string }
> {
  return {
    schemaVersion: 1,
    correlationId: "corr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    decisionRef: "decision_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    expiresAtMillis: 1_785_586_015_000,
    credentialDomain: "openai-responses",
    identity: {
      kind: "kubernetes_workload",
      namespace: "hermes-workers",
      serviceAccountName: "hermes-codex",
      policyRevision: 7,
      policyResourceVersion: "18422",
      hermesProfile: "default",
    },
    capability: "openai.responses.create",
    resource: { kind: "provider_service", provider: "openai", service: "responses" },
    rateClass: "standard",
    model: "gpt-5.6-sol",
    limits: {
      requestWindowMillis: 60_000,
      maximumRequests: 20,
      maximumConcurrent: 2,
      tokenWindowMillis: 60_000,
      maximumTokens: 100_000,
      spendWindowMillis: 3_600_000,
      maximumSpendMicros: 2_000_000,
    },
    pricing: { version: 1, inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 8_000_000 },
    requestedTokens: 1_024,
    requestedSpendMicros: 8_192,
  };
}

describe("Effect AI Gateway canonical request attribution", () => {
  layer(BunCryptoLayer)((it) => {
    it.effect("uses Assignment custody when present and otherwise the Mate identity", () =>
      Effect.gen(function*() {
        assert.deepStrictEqual(yield* gatewayRequestAttribution(grant()), {
          kind: "assignment",
          id: AssignmentId,
          key: `assignment:${AssignmentId}`,
          agentId: AgentId,
          profileId: "openai-responses",
          profileVersion: 7,
          rateClass: "standard",
          decisionRef: "decision_22222222222222222222222222222222",
        });
        assert.deepStrictEqual(yield* gatewayRequestAttribution(grant(null)), {
          kind: "mate",
          id: AgentId,
          key: `mate:${AgentId}`,
          agentId: AgentId,
          profileId: "openai-responses",
          profileVersion: 7,
          rateClass: "standard",
          decisionRef: "decision_22222222222222222222222222222222",
        });
      }));

    it.effect("namespaces sticky sessions by canonical custody within router bounds", () =>
      Effect.gen(function*() {
        const one = yield* attributedSessionKey("conversation-a", grant());
        const same = yield* attributedSessionKey("conversation-a", grant());
        const otherAssignment = yield* attributedSessionKey("conversation-a", {
          ...grant(),
          identity: {
            ...grant().identity,
            assignmentId: "20000000-0000-4000-8000-000000000002",
          },
        });
        const mate = yield* attributedSessionKey("conversation-a", grant(null));
        assert.strictEqual(one, same);
        assert.notStrictEqual(one, otherAssignment);
        assert.notStrictEqual(one, mate);
        assert.match(one ?? "", /^agentos-v1:assignment:[0-9a-f]{64}$/);
        assert.isBelow(
          (yield* attributedSessionKey("s".repeat(256), grant()))?.length ?? 0,
          128,
        );
        assert.isUndefined(yield* attributedSessionKey(undefined, grant()));
        assert.strictEqual(
          yield* attributedSessionKey("legacy", undefined),
          "legacy",
        );
      }));

    it.effect("attributes Hermes requests to the exact Kubernetes policy principal without an Agent id", () =>
      Effect.gen(function*() {
        assert.deepStrictEqual(yield* gatewayRequestAttribution(workloadGrant()), {
          kind: "kubernetes_workload",
          id: "hermes-workers:hermes-codex:7:18422:default",
          key: "kubernetes_workload:hermes-workers:hermes-codex:7:18422:default",
          agentId: null,
          profileId: "default",
          profileVersion: 7,
          rateClass: "standard",
          decisionRef: "decision_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        });
      }));
  });
});
