import { assert, describe, it } from "@effect/vitest";
import { layer as BunCryptoLayer } from "@effect/platform-bun/BunCrypto";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Ref,
} from "effect";
import { TestClock } from "effect/testing";

import {
  ProviderPolicyDecisionError,
  ProviderPolicyDecisionPoint,
  type ProviderPolicyDecisionRequestV1,
} from "../credential-delivery.ts";
import {
  OpenFgaAuthorizationApi,
  OpenFgaDependencyUnavailable,
  openFgaCapabilityRelation,
  openFgaCeiling,
  openFgaProfile,
  openFgaSubject,
  openFgaTarget,
  type OpenFgaApiCheckRequest,
  type OpenFgaDeploymentV1,
} from "../openfga.ts";
import {
  type AccessBindingSubjectV1,
  type AccessPermissionV1,
  type AuthorizationResourceV1,
} from "../contracts.ts";
import {
  ProviderPolicySnapshotStore,
  ProviderPolicySnapshotUnavailable,
  type ProviderPolicySnapshotV1,
} from "../postgres-identity.ts";
import {
  ProviderBudgetEnforcementError,
  ProviderBudgetEnforcer,
  type ProviderBudgetReservationInputV1,
  type ProviderBudgetReservationV1,
} from "../provider-budget.ts";
import {
  ProviderDecisionReferenceGenerator,
  ProviderDecisionReferenceGeneratorLiveLayer,
  makeProviderPolicyDecisionPointLayer,
} from "../policy-decision.ts";

const Now = Date.parse("2026-08-01T12:00:00.000Z");
const Deployment: OpenFgaDeploymentV1 = {
  storeId: "01K1J6T8NS7B4K5AT9E1YH8D5R",
  authorizationModelId: "01K1J6V6Z3S94FWX6H3M1TDME4",
};
const Subject: AccessBindingSubjectV1 = {
  kind: "mate",
  fleet: "agentos",
  domain: "platform",
  agentId: "11111111-1111-4111-8111-111111111111",
};
const Resource: AuthorizationResourceV1 = {
  kind: "github_repository",
  owner: "akua-dev",
  repository: "agentos",
};
const Permission: AccessPermissionV1 = {
  capability: "github.issue.write",
  resource: Resource,
  environment: "production",
  expiresAtMillis: Now + 60_000,
  rateClass: "standard",
};
const Snapshot: ProviderPolicySnapshotV1 = {
  schemaVersion: 1,
  binding: {
    bindingId: "binding_11111111111111111111111111111111",
    subject: Subject,
    createdAtMillis: Now - 60_000,
    expiresAtMillis: Now + 50_000,
  },
  profile: {
    profileId: "github-maintainer",
    profileVersion: 7,
    previousProfileVersion: 6,
    targetScope: {
      kind: "domain",
      fleet: "agentos",
      domain: "platform",
    },
    permissions: [Permission],
    issuedUnderCeiling: {
      ceilingId: "ceiling_22222222222222222222222222222222",
      revision: 9,
    },
  },
  ceiling: {
    ceilingId: "ceiling_22222222222222222222222222222222",
    revision: 9,
    scope: {
      kind: "domain",
      fleet: "agentos",
      domain: "platform",
    },
    effectiveAtMillis: Now - 120_000,
    permissions: [{ ...Permission, rateClass: "high" }],
  },
};
const Request: ProviderPolicyDecisionRequestV1 = {
  schemaVersion: 1,
  correlationId: "corr_33333333333333333333333333333333",
  credentialDomain: "github",
  provider: "github",
  capability: "github.issue.write",
  resource: Resource,
  subject: Subject,
};

function decisionLayer(input?: {
  readonly snapshot?: Effect.Effect<
    ProviderPolicySnapshotV1,
    ProviderPolicySnapshotUnavailable
  >;
  readonly check?: (
    request: OpenFgaApiCheckRequest,
  ) => Effect.Effect<boolean, OpenFgaDependencyUnavailable>;
  readonly environment?: string | null;
  readonly reserve?: ProviderBudgetEnforcer["Service"]["reserve"];
}) {
  const stores = Layer.mergeAll(
    Layer.succeed(ProviderPolicySnapshotStore, {
      findBySubject: () => input?.snapshot ?? Effect.succeed(Snapshot),
    }),
    Layer.succeed(OpenFgaAuthorizationApi, {
      mutateTuples: () => Effect.void,
      check: input?.check ?? (() => Effect.succeed(true)),
    }),
    Layer.succeed(ProviderDecisionReferenceGenerator, {
      next: Effect.succeed("44444444444444444444444444444444"),
    }),
    Layer.succeed(ProviderBudgetEnforcer, {
      reserve: input?.reserve ?? ((reservation) => Effect.succeed({
        schemaVersion: 1,
        decisionRef: reservation.decisionRef,
        budgetKey: `budget_${"5".repeat(64)}`,
        outcome: "reserved",
        effectiveRateClass: reservation.rateClass,
        requestWindowEndsAtMillis: reservation.nowMillis + 60_000,
        tokenWindowEndsAtMillis: reservation.nowMillis + 60_000,
        spendWindowEndsAtMillis: reservation.nowMillis + 3_600_000,
        leaseExpiresAtMillis: reservation.nowMillis + 900_000,
      })),
      settle: () => Effect.die("settlement not expected in PDP"),
    }),
  );
  return makeProviderPolicyDecisionPointLayer({
    deployment: Deployment,
    environment: input?.environment === undefined
      ? "production"
      : input.environment,
  }).pipe(Layer.provide(stores));
}

const decide = Effect.gen(function*() {
  const point = yield* ProviderPolicyDecisionPoint;
  return yield* point.decide(Request);
});

function policyError(
  effect: Effect.Effect<unknown, ProviderPolicyDecisionError>,
) {
  return Effect.flip(effect);
}

describe("provider policy decision point", () => {
  it.effect("generates opaque references through the Effect crypto service", () =>
    Effect.gen(function*() {
      const generator = yield* ProviderDecisionReferenceGenerator;
      const references = yield* Effect.all([
        generator.next,
        generator.next,
      ]);
      for (const reference of references) {
        assert.match(reference, /^[0-9a-f]{32}$/);
      }
      assert.notStrictEqual(references[0], references[1]);
    }).pipe(
      Effect.provide(ProviderDecisionReferenceGeneratorLiveLayer.pipe(
        Layer.provide(BunCryptoLayer),
      )),
    ));

  it.effect("requires profile, ceiling, and effective allow at the pinned model", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const checks = yield* Ref.make<ReadonlyArray<OpenFgaApiCheckRequest>>([]);
      const result = yield* decide.pipe(Effect.provide(decisionLayer({
        check: (request) =>
          Ref.update(checks, (current) => [...current, request]).pipe(
            Effect.as(true),
          ),
      })));

      const permission = { ...Permission };
      const target = openFgaTarget(Subject.fleet, permission);
      const relation = openFgaCapabilityRelation(Permission.capability);
      assert.deepStrictEqual(yield* Ref.get(checks), [
        {
          ...Deployment,
          user: openFgaProfile(Subject.fleet, Snapshot.profile),
          relation: relation.profile,
          object: target,
          context: { current_time: "2026-08-01T12:00:00.000Z" },
          consistency: "HIGHER_CONSISTENCY",
        },
        {
          ...Deployment,
          user: openFgaCeiling(Subject.fleet, Snapshot.ceiling),
          relation: relation.ceiling,
          object: target,
          context: { current_time: "2026-08-01T12:00:00.000Z" },
          consistency: "HIGHER_CONSISTENCY",
        },
        {
          ...Deployment,
          user: openFgaSubject(Subject),
          relation: relation.allow,
          object: target,
          context: { current_time: "2026-08-01T12:00:00.000Z" },
          consistency: "HIGHER_CONSISTENCY",
        },
      ]);
      assert.deepStrictEqual(result, {
        schemaVersion: 1,
        correlationId: Request.correlationId,
        decisionRef: "decision_44444444444444444444444444444444",
        decision: "allow",
        credentialDomain: "github",
        expiresAtMillis: Now + 15_000,
        profile: { profileId: "github-maintainer", profileVersion: 7 },
        ceiling: {
          ceilingId: "ceiling_22222222222222222222222222222222",
          revision: 9,
        },
        rateClass: "standard",
      });
    }));

  it.effect("rejects caller-controlled identity and invalid provider routes before dependencies", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const snapshotReads = yield* Ref.make(0);
      const checks = yield* Ref.make(0);
      const layer = decisionLayer({
        snapshot: Ref.update(snapshotReads, (count) => count + 1).pipe(
          Effect.andThen(Effect.succeed(Snapshot)),
        ),
        check: () => Ref.update(checks, (count) => count + 1).pipe(Effect.as(true)),
      });
      const point = yield* ProviderPolicyDecisionPoint.pipe(
        Effect.provide(layer),
      );
      const fleetFailure = yield* policyError(point.decide({
        ...Request,
        subject: { kind: "fleet", fleet: "agentos" },
      }));
      const routeFailure = yield* policyError(point.decide({
        ...Request,
        provider: "openai",
      }));

      assert.deepStrictEqual(
        [fleetFailure.outcome, fleetFailure.retryable],
        ["identity_rejected", false],
      );
      assert.deepStrictEqual(
        [routeFailure.outcome, routeFailure.retryable],
        ["invalid_route", false],
      );
      assert.strictEqual(yield* Ref.get(snapshotReads), 0);
      assert.strictEqual(yield* Ref.get(checks), 0);
    }));

  it.effect("keeps database, identity, and stale-policy snapshot failures distinct", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const cases: ReadonlyArray<readonly [
        ProviderPolicySnapshotUnavailable["code"],
        ProviderPolicyDecisionError["outcome"],
        boolean,
      ]> = [
        ["database_unavailable", "database_unavailable", true],
        ["invalid_response", "database_unavailable", true],
        ["binding_not_found", "identity_rejected", false],
        ["binding_expired", "identity_rejected", false],
        ["profile_stale", "policy_stale", true],
        ["ceiling_reconciliation_pending", "policy_stale", true],
        ["operation_unreconciled", "policy_stale", true],
      ];
      for (const [code, outcome, retryable] of cases) {
        const failure = yield* policyError(decide.pipe(Effect.provide(
          decisionLayer({
            snapshot: Effect.fail(ProviderPolicySnapshotUnavailable.make({
              dependency: "postgresql",
              operation: "find_policy_snapshot",
              code,
            })),
          }),
        )));
        assert.deepStrictEqual(
          [failure.outcome, failure.retryable],
          [outcome, retryable],
        );
        assert.deepStrictEqual(Object.keys(failure).sort(), [
          "_tag",
          "outcome",
          "retryable",
        ]);
      }
    }));

  it.effect("distinguishes permission, rate, and OpenFGA denials", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const missingProfile: ProviderPolicySnapshotV1 = {
        ...Snapshot,
        profile: {
          ...Snapshot.profile,
          permissions: [{ ...Permission, capability: "github.issue.read" }],
        },
      };
      const disabled: ProviderPolicySnapshotV1 = {
        ...Snapshot,
        profile: {
          ...Snapshot.profile,
          permissions: [{ ...Permission, rateClass: "disabled" }],
        },
      };
      const exceeded: ProviderPolicySnapshotV1 = {
        ...Snapshot,
        ceiling: {
          ...Snapshot.ceiling,
          permissions: [{ ...Permission, rateClass: "low" }],
        },
      };
      const failures = yield* Effect.all([
        policyError(decide.pipe(Effect.provide(decisionLayer({
          snapshot: Effect.succeed(missingProfile),
        })))),
        policyError(decide.pipe(Effect.provide(decisionLayer({
          snapshot: Effect.succeed(disabled),
        })))),
        policyError(decide.pipe(Effect.provide(decisionLayer({
          snapshot: Effect.succeed(exceeded),
        })))),
        policyError(decide.pipe(Effect.provide(decisionLayer({
          check: (request) => Effect.succeed(
            request.relation !== openFgaCapabilityRelation(
              Permission.capability,
            ).ceiling,
          ),
        })))),
      ]);
      assert.deepStrictEqual(failures.map(({ outcome }) => outcome), [
        "profile_denied",
        "rate_class_disabled",
        "rate_class_exceeded",
        "ceiling_denied",
      ]);
    }));

  it.effect("reserves durable budget capacity only after strong authorization", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const reservations = yield* Ref.make<
        ReadonlyArray<ProviderBudgetReservationInputV1>
      >([]);
      const result = yield* decide.pipe(Effect.provide(decisionLayer({
        reserve: (input) => {
          const reservation: ProviderBudgetReservationV1 = {
              schemaVersion: 1,
              decisionRef: input.decisionRef,
              budgetKey: `budget_${"5".repeat(64)}`,
              outcome: "reserved",
              effectiveRateClass: input.rateClass,
              requestWindowEndsAtMillis: Now + 60_000,
              tokenWindowEndsAtMillis: Now + 60_000,
              spendWindowEndsAtMillis: Now + 3_600_000,
              leaseExpiresAtMillis: Now + 900_000,
          };
          return Ref.update(reservations, (current) => [
            ...current,
            input,
          ]).pipe(Effect.as(reservation));
        },
      })));
      assert.strictEqual(result.decision, "allow");
      assert.deepStrictEqual(yield* Ref.get(reservations), [{
        schemaVersion: 1,
        decisionRef: result.decisionRef,
        correlationId: Request.correlationId,
        bindingId: Snapshot.binding.bindingId,
        subject: Subject,
        provider: Request.provider,
        credentialDomain: Request.credentialDomain,
        capability: Request.capability,
        resource: Resource,
        environment: "production",
        rateClass: "standard",
        nowMillis: Now,
      }]);
    }));

  it.effect("keeps budget exhaustion distinct from provider and policy failures", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const outcomes: ReadonlyArray<"rate_limited" | "budget_exhausted"> = [
        "rate_limited",
        "budget_exhausted",
      ];
      for (const outcome of outcomes) {
        const failure = yield* policyError(decide.pipe(Effect.provide(
          decisionLayer({
            reserve: () => Effect.fail(ProviderBudgetEnforcementError.make({
              outcome,
              retryable: true,
              retryAtMillis: Now + 60_000,
            })),
          }),
        )));
        assert.deepStrictEqual(
          [failure.outcome, failure.retryable],
          [outcome, true],
        );
        assert.deepStrictEqual(Object.keys(failure).sort(), [
          "_tag",
          "outcome",
          "retryable",
        ]);
      }
    }));

  it.effect("revalidates snapshot freshness, uniqueness, scope, and bounded expiry", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const expiredBinding: ProviderPolicySnapshotV1 = {
        ...Snapshot,
        binding: { ...Snapshot.binding, expiresAtMillis: Now },
      };
      const mismatchedCeiling: ProviderPolicySnapshotV1 = {
        ...Snapshot,
        profile: {
          ...Snapshot.profile,
          issuedUnderCeiling: {
            ...Snapshot.profile.issuedUnderCeiling,
            revision: Snapshot.ceiling.revision - 1,
          },
        },
      };
      const duplicatedPermission: ProviderPolicySnapshotV1 = {
        ...Snapshot,
        profile: {
          ...Snapshot.profile,
          permissions: [Permission, Permission],
        },
      };
      const shortPermission: ProviderPolicySnapshotV1 = {
        ...Snapshot,
        profile: {
          ...Snapshot.profile,
          permissions: [{ ...Permission, expiresAtMillis: Now + 7_000 }],
        },
      };
      const failures = yield* Effect.all([
        policyError(decide.pipe(Effect.provide(decisionLayer({
          snapshot: Effect.succeed(expiredBinding),
        })))),
        policyError(decide.pipe(Effect.provide(decisionLayer({
          snapshot: Effect.succeed(mismatchedCeiling),
        })))),
        policyError(decide.pipe(Effect.provide(decisionLayer({
          snapshot: Effect.succeed(duplicatedPermission),
        })))),
        policyError(decide.pipe(Effect.provide(decisionLayer({
          environment: "staging",
        })))),
      ]);
      assert.deepStrictEqual(failures.map(({ outcome }) => outcome), [
        "identity_rejected",
        "policy_stale",
        "policy_stale",
        "profile_denied",
      ]);

      const allowed = yield* decide.pipe(Effect.provide(decisionLayer({
        snapshot: Effect.succeed(shortPermission),
      })));
      assert.strictEqual(allowed.expiresAtMillis, Now + 7_000);
    }));

  it.effect("maps OpenFGA dependency failure without leaking request content", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const failure = yield* policyError(decide.pipe(Effect.provide(
        decisionLayer({
          check: () => Effect.fail(OpenFgaDependencyUnavailable.make({
            operation: "check",
          })),
        }),
      )));
      assert.deepStrictEqual(
        [failure.outcome, failure.retryable],
        ["openfga_unavailable", true],
      );
      const encoded = JSON.stringify(failure);
      assert.notInclude(encoded, Request.correlationId);
      assert.notInclude(encoded, Subject.agentId);
      assert.notInclude(encoded, Resource.repository);
    }));

  it.effect("never reaches provider forwarding after denial and preserves interruption", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const forwards = yield* Ref.make(0);
      const deniedProgram = Effect.gen(function*() {
        const point = yield* ProviderPolicyDecisionPoint;
        yield* point.decide(Request);
        yield* Ref.update(forwards, (count) => count + 1);
      }).pipe(Effect.provide(decisionLayer({
        check: () => Effect.succeed(false),
      })));
      yield* Effect.exit(deniedProgram);
      assert.strictEqual(yield* Ref.get(forwards), 0);

      const blocked = decide.pipe(Effect.provide(decisionLayer({
        snapshot: Effect.never,
      })));
      const fiber = yield* Effect.forkChild(blocked);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(
        Exit.isFailure(exit) &&
          exit.cause.reasons.some(Cause.isInterruptReason),
      );
    }));
});
