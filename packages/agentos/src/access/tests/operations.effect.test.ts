import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  compileProviderAccessRolloutVerdict,
  ProviderAccessRolloutDecodeError,
  type ProviderAccessRolloutInputV1,
} from "../operations.ts";

const previous = `sha256:${"a".repeat(64)}`;
const desired = `sha256:${"b".repeat(64)}`;

function rollout(
  overrides: Partial<ProviderAccessRolloutInputV1> = {},
): ProviderAccessRolloutInputV1 {
  return {
    schemaVersion: 1,
    operationId: "10000000-0000-4000-8000-000000000001",
    action: "upgrade",
    provider: "github",
    credentialDomain: "github",
    desiredReleaseDigest: desired,
    verifiedReleaseDigests: [previous],
    workloads: [
      {
        component: "agentgateway",
        desiredRevision: desired,
        observedRevision: desired,
        ready: true,
      },
      {
        component: "authorizer",
        desiredRevision: desired,
        observedRevision: desired,
        ready: true,
      },
      {
        component: "provider_adapter",
        desiredRevision: desired,
        observedRevision: desired,
        ready: true,
      },
    ],
    policy: {
      operationPhase: "completed",
      desiredProfileVersion: 7,
      observedProfileVersion: 7,
      desiredCeilingRevision: 11,
      observedCeilingRevision: 11,
    },
    credential: {
      desiredRevision: "rv-44",
      observedRevision: "rv-44",
      outcome: "credential_ready",
    },
    budget: {
      desiredRevision: 9,
      observedRevision: 9,
      enforced: true,
    },
    ...overrides,
  };
}

describe("provider-access operations", () => {
  it.effect("acknowledges only one exact fully applied provider release", () =>
    Effect.gen(function*() {
      const verdict = yield* compileProviderAccessRolloutVerdict(rollout());
      assert.deepStrictEqual(verdict, {
        schemaVersion: 1,
        operationId: "10000000-0000-4000-8000-000000000001",
        provider: "github",
        credentialDomain: "github",
        action: "upgrade",
        status: "verified",
        reason: "ready",
        acknowledged: true,
        servingReleaseDigest: desired,
      });
    }));

  it.effect("refuses to acknowledge unapplied provider access authorities", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<readonly [
        ProviderAccessRolloutInputV1,
        "configuration_unapplied" | "policy_unapplied" |
          "credential_unapplied" | "budget_unapplied",
      ]> = [
        [
          rollout({
            workloads: rollout().workloads.map((item) =>
              item.component === "provider_adapter"
                ? { ...item, observedRevision: previous }
                : item
            ),
          }),
          "configuration_unapplied",
        ],
        [
          rollout({
            policy: { ...rollout().policy, operationPhase: "verified" },
          }),
          "policy_unapplied",
        ],
        [
          rollout({
            credential: {
              ...rollout().credential,
              outcome: "credential_rotating",
            },
          }),
          "credential_unapplied",
        ],
        [
          rollout({ budget: { ...rollout().budget, enforced: false } }),
          "budget_unapplied",
        ],
      ];
      for (const [input, reason] of cases) {
        const verdict = yield* compileProviderAccessRolloutVerdict(input);
        assert.strictEqual(verdict.status, "pending");
        assert.strictEqual(verdict.reason, reason);
        assert.strictEqual(verdict.acknowledged, false);
        assert.strictEqual(verdict.servingReleaseDigest, previous);
      }
    }));

  it.effect("permits rollback only to a previously verified release", () =>
    Effect.gen(function*() {
      const verified = yield* compileProviderAccessRolloutVerdict(rollout({
        action: "rollback",
        desiredReleaseDigest: previous,
        verifiedReleaseDigests: [previous],
        workloads: rollout().workloads.map((item) => ({
          ...item,
          desiredRevision: previous,
          observedRevision: previous,
        })),
      }));
      assert.strictEqual(verified.status, "verified");
      assert.strictEqual(verified.acknowledged, true);

      const unverified = yield* compileProviderAccessRolloutVerdict(rollout({
        action: "rollback",
        verifiedReleaseDigests: [previous],
      }));
      assert.strictEqual(unverified.status, "rollback_required");
      assert.strictEqual(unverified.reason, "rollback_target_unverified");
      assert.strictEqual(unverified.acknowledged, false);
      assert.strictEqual(unverified.servingReleaseDigest, previous);
    }));

  it.effect("rejects secret-shaped and unknown rollout fields", () =>
    Effect.gen(function*() {
      const failure = yield* compileProviderAccessRolloutVerdict({
        ...rollout(),
        credential: {
          ...rollout().credential,
          token: "must-not-enter-the-operation-journal",
        },
      }).pipe(Effect.flip);
      assert.instanceOf(failure, ProviderAccessRolloutDecodeError);
    }));
});
