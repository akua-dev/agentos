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
): ProviderAuthorizationGrantV1 {
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
  });
});
