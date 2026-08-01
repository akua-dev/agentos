import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";

import {
  ACCESS_POLICY_RELOAD_SLO_MILLIS,
  ACCESS_POLICY_REVOCATION_SLO_MILLIS,
  AccessControlIdentityCache,
  AccessControlJournal,
  AccessControlOperationGuard,
  AccessControlOperationPlanMismatch,
  AccessControlAuditDecodeError,
  AccessControlOperationSloExceeded,
  AccessControlPolicyError,
  decodeAccessControlMutationRecord,
  effectiveAccessForBinding,
  executeAccessControlOperation,
  prepareAccessCeilingReconciliation,
  prepareAccessControlTupleTransition,
  publishAccessProfileVersion,
  type AccessControlOperationV1,
  type PublishAccessProfileVersionInput,
} from "../control-plane.ts";
import {
  OpenFgaAuthorizationApi,
  openFgaCapabilityRelation,
  openFgaTarget,
  type OpenFgaApiCheckRequest,
  type OpenFgaApiTupleMutationRequest,
  type OpenFgaDeploymentV1,
} from "../openfga.ts";
import type {
  AccessBindingV1,
  AccessCeilingV1,
  AccessPermissionV1,
  AccessProfileVersionV1,
  AuthorizationResourceV1,
} from "../contracts.ts";

const MateId = "11111111-1111-4111-8111-111111111111";
const CaptainId = "22222222-2222-4222-8222-222222222222";
const ServiceAccountUid = "33333333-3333-4333-8333-333333333333";
const EffectiveAt = Date.parse("2026-08-01T00:00:00.000Z");
const ExpiresAt = Date.parse("2026-08-02T00:00:00.000Z");

const repository: AuthorizationResourceV1 = {
  kind: "github_repository",
  owner: "akua-dev",
  repository: "agentos",
};
const writeIssue: AccessPermissionV1 = {
  capability: "github.issue.write",
  resource: repository,
  environment: "production",
  expiresAtMillis: ExpiresAt,
  rateClass: "standard",
};
const readIssue: AccessPermissionV1 = {
  ...writeIssue,
  capability: "github.issue.read",
};

function ceiling(
  permissions: readonly [AccessPermissionV1, ...Array<AccessPermissionV1>] = [
    writeIssue,
    readIssue,
  ],
  revision = 1,
): AccessCeilingV1 {
  return {
    schemaVersion: 1,
    ceilingId: "ceiling_0123456789abcdef0123456789abcdef",
    revision,
    supersedesRevision: revision === 1 ? null : revision - 1,
    owner: { authority: "captain-platform", captainId: CaptainId },
    scope: { kind: "domain", fleet: "agentos", domain: "platform" },
    effectiveAtMillis: EffectiveAt,
    permissions,
  };
}

function profile(
  permissions: readonly [AccessPermissionV1, ...Array<AccessPermissionV1>] = [
    writeIssue,
    readIssue,
  ],
  profileVersion = 1,
): AccessProfileVersionV1 {
  return {
    schemaVersion: 1,
    compatibility: "agentos-access-v1",
    profileId: "github-maintainer",
    profileVersion,
    previousProfileVersion: profileVersion === 1 ? null : profileVersion - 1,
    publishedBy: "first-mate-control-plane",
    permissions,
  };
}

function binding(state: "active" | "revoked" = "active"): AccessBindingV1 {
  return {
    schemaVersion: 1,
    bindingId: "binding_0123456789abcdef0123456789abcdef",
    profile: { profileId: "github-maintainer", profileVersion: 1 },
    subject: {
      kind: "mate",
      fleet: "agentos",
      domain: "platform",
      agentId: MateId,
    },
    issuedUnderCeiling: {
      ceilingId: "ceiling_0123456789abcdef0123456789abcdef",
      revision: 1,
    },
    createdAtMillis: EffectiveAt,
    expiresAtMillis: ExpiresAt,
    state,
  };
}

describe("First Mate access control plane", () => {
  it.effect("publishes one contiguous immutable profile version inside the current ceiling", () =>
    Effect.gen(function*() {
      assert.strictEqual(ACCESS_POLICY_RELOAD_SLO_MILLIS, 15_000);
      assert.strictEqual(ACCESS_POLICY_REVOCATION_SLO_MILLIS, 60_000);
      const next = yield* publishAccessProfileVersion({
        ceiling: ceiling(),
        previousProfile: profile([readIssue]),
        expectedPreviousVersion: 1,
        profileId: "github-maintainer",
        permissions: [readIssue, writeIssue],
      });
      assert.strictEqual(next.profileVersion, 2);
      assert.strictEqual(next.previousProfileVersion, 1);
      assert.deepStrictEqual(next.permissions, [readIssue, writeIssue]);
      assert.isTrue(Object.isFrozen(next));
    }));

  it.effect("rejects permissions, rates, expiries, and concurrent edits outside the ceiling", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<{
        readonly input: PublishAccessProfileVersionInput;
        readonly code: AccessControlPolicyError["code"];
      }> = [
        {
          input: {
            ceiling: ceiling([readIssue]),
            previousProfile: null,
            expectedPreviousVersion: null,
            profileId: "github-maintainer",
            permissions: [writeIssue],
          },
          code: "ceiling_denied",
        },
        {
          input: {
            ceiling: ceiling([{ ...writeIssue, rateClass: "low" }]),
            previousProfile: null,
            expectedPreviousVersion: null,
            profileId: "github-maintainer",
            permissions: [{ ...writeIssue, rateClass: "high" }],
          },
          code: "rate_class_exceeded",
        },
        {
          input: {
            ceiling: ceiling([{ ...writeIssue, expiresAtMillis: ExpiresAt }]),
            previousProfile: null,
            expectedPreviousVersion: null,
            profileId: "github-maintainer",
            permissions: [{ ...writeIssue, expiresAtMillis: null }],
          },
          code: "expiry_exceeded",
        },
        {
          input: {
            ceiling: ceiling(),
            previousProfile: profile(),
            expectedPreviousVersion: null,
            profileId: "github-maintainer",
            permissions: [writeIssue],
          },
          code: "optimistic_conflict",
        },
      ];

      for (const testCase of cases) {
        const failure = yield* publishAccessProfileVersion(testCase.input).pipe(
          Effect.flip,
        );
        assert.instanceOf(failure, AccessControlPolicyError);
        assert.strictEqual(failure.code, testCase.code);
      }
    }));

  it.effect("prepares exact grant and revocation transitions with strong checks", () =>
    Effect.gen(function*() {
      const deployment: OpenFgaDeploymentV1 = {
        storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        authorizationModelId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      };
      const granted = yield* prepareAccessControlTupleTransition({
        deployment,
        previous: null,
        next: { ceiling: ceiling(), profile: profile(), binding: binding() },
      });
      assert.lengthOf(granted.verifications, 2);
      assert.isTrue(granted.verifications.every(({ expectedAllowed, request }) =>
        expectedAllowed && request.consistency === "HIGHER_CONSISTENCY"));
      assert.lengthOf(granted.stages, 1);
      assert.isTrue(granted.stages[0].mutation.writes.some(({ relation }) =>
        relation === openFgaCapabilityRelation(writeIssue.capability).allow));

      const revoked = yield* prepareAccessControlTupleTransition({
        deployment,
        previous: { ceiling: ceiling(), profile: profile(), binding: binding() },
        next: {
          ceiling: ceiling(),
          profile: profile(),
          binding: binding("revoked"),
        },
      });
      assert.lengthOf(revoked.verifications, 2);
      assert.isTrue(revoked.verifications.every(({ expectedAllowed }) =>
        !expectedAllowed));
      assert.lengthOf(revoked.stages, 1);
      assert.isTrue(revoked.stages[0].mutation.deletes.some(({ relation }) =>
        relation === openFgaCapabilityRelation(writeIssue.capability).allow));
    }));

  it.effect("reconciles a ceiling shrink without retaining the removed grant", () =>
    Effect.gen(function*() {
      const deployment: OpenFgaDeploymentV1 = {
        storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        authorizationModelId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      };
      const transition = yield* prepareAccessControlTupleTransition({
        deployment,
        previous: { ceiling: ceiling(), profile: profile(), binding: binding() },
        next: {
          ceiling: ceiling([readIssue], 2),
          profile: profile(),
          binding: binding(),
        },
      });
      const target = openFgaTarget("agentos", writeIssue);
      const relation = openFgaCapabilityRelation(writeIssue.capability).allow;
      assert.includeDeepMembers([...transition.stages[0].mutation.deletes], [{
        user: transition.subject,
        relation,
        object: target,
      }]);
      assert.isTrue(transition.verifications.some(({ expectedAllowed, request }) =>
        !expectedAllowed && request.relation === relation &&
        request.object === target));
    }));

  it.effect("compiles one ceiling operation across the complete active-subject set", () =>
    Effect.gen(function*() {
      const deployment: OpenFgaDeploymentV1 = {
        storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        authorizationModelId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      };
      const reconciliation = yield* prepareAccessCeilingReconciliation({
        deployment,
        previousCeiling: ceiling(),
        nextCeiling: ceiling([readIssue], 2),
        bindings: [{ profile: profile(), binding: binding() }],
      });
      assert.deepStrictEqual(reconciliation.subjects, [binding().subject]);
      assert.isTrue(reconciliation.stages[0].mutation.deletes.some(({ relation }) =>
        relation === openFgaCapabilityRelation(writeIssue.capability).allow));
      assert.isTrue(reconciliation.verifications.some((item) =>
        !item.expectedAllowed &&
        item.request.relation ===
          openFgaCapabilityRelation(writeIssue.capability).allow));
    }));

  it.effect("replaces changed tuple conditions through a persisted fail-closed stage", () =>
    Effect.gen(function*() {
      const deployment: OpenFgaDeploymentV1 = {
        storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        authorizationModelId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      };
      const transition = yield* prepareAccessControlTupleTransition({
        deployment,
        previous: { ceiling: ceiling(), profile: profile(), binding: binding() },
        next: {
          ceiling: {
            ...ceiling([writeIssue, readIssue], 2),
            effectiveAtMillis: EffectiveAt + 1_000,
          },
          profile: profile(),
          binding: binding(),
        },
      });
      const relation = openFgaCapabilityRelation(writeIssue.capability).allow;
      assert.lengthOf(transition.stages, 2);
      const replacementStage = transition.stages[1]!;
      assert.isTrue(transition.stages[0].mutation.deletes.some((tuple) =>
        tuple.relation === relation));
      assert.isTrue(transition.stages[0].verifications.some((item) =>
        item.request.relation === relation && !item.expectedAllowed));
      assert.isTrue(replacementStage.mutation.writes.some((tuple) =>
        tuple.relation === relation));
      assert.isTrue(replacementStage.verifications.some((item) =>
        item.request.relation === relation && item.expectedAllowed));
    }));

  it.effect("inspects only currently effective permissions", () =>
    Effect.gen(function*() {
      const access = yield* effectiveAccessForBinding({
        atMillis: EffectiveAt + 1,
        ceiling: ceiling([readIssue]),
        profile: profile(),
        binding: binding(),
      });
      assert.deepStrictEqual(access.map(({ capability }) => capability), [
        "github.issue.read",
      ]);
      assert.isTrue(access.every(({ decision }) => decision === "allow"));
    }));

  it.effect("rejects secret-shaped audit fields at the Effect boundary", () =>
    Effect.gen(function*() {
      const failure = yield* decodeAccessControlMutationRecord({
        schemaVersion: 1,
        eventId: "authz_0123456789abcdef0123456789abcdef",
        operationId: "44444444-4444-4444-8444-444444444444",
        timestampMillis: EffectiveAt,
        actor: { agentId: MateId, serviceAccountUid: ServiceAccountUid },
        correlationId: "corr_0123456789abcdef0123456789abcdef",
        kind: "profile_published",
        target: {
          profile: { profileId: "github-maintainer", profileVersion: 2 },
          ceiling: {
            ceilingId: "ceiling_0123456789abcdef0123456789abcdef",
            revision: 1,
          },
        },
        previousVersion: 1,
        newVersion: 2,
        mutationReason: "least_privilege",
        decision: "recorded",
        credential: "must-not-enter-audit",
      }).pipe(Effect.flip);
      assert.instanceOf(failure, AccessControlAuditDecodeError);
    }));

  it.effect("resumes an interrupted mutation without duplicate grants or audit", () =>
    Effect.gen(function*() {
      const deployment: OpenFgaDeploymentV1 = {
        storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        authorizationModelId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      };
      const transition = yield* prepareAccessControlTupleTransition({
        deployment,
        previous: null,
        next: { ceiling: ceiling(), profile: profile(), binding: binding() },
      });
      const operation: AccessControlOperationV1 = {
        schemaVersion: 1,
        operationId: "44444444-4444-4444-8444-444444444444",
        phase: "prepared",
        nextStageIndex: 0,
        kind: "binding_created",
        subjects: [binding().subject],
        stages: transition.stages,
        audit: {
          schemaVersion: 1,
          eventId: "authz_0123456789abcdef0123456789abcdef",
          operationId: "44444444-4444-4444-8444-444444444444",
          timestampMillis: EffectiveAt,
          actor: { agentId: MateId, serviceAccountUid: ServiceAccountUid },
          correlationId: "corr_0123456789abcdef0123456789abcdef",
          kind: "binding_created",
          target: {
            bindingId: binding().bindingId,
            subject: binding().subject,
            profile: binding().profile,
          },
          previousVersion: null,
          newVersion: 1,
          mutationReason: "assignment_requirement",
          decision: "recorded",
        },
      };
      const journalState = yield* Ref.make(operation);
      const mutations = yield* Ref.make<Array<OpenFgaApiTupleMutationRequest>>([]);
      const checks = yield* Ref.make<Array<OpenFgaApiCheckRequest>>([]);
      const invalidations = yield* Ref.make(0);
      const auditWrites = yield* Ref.make(0);
      const failCompletion = yield* Ref.make(true);

      const journal = Layer.succeed(AccessControlJournal, {
        load: () => Ref.get(journalState),
        advanceStage: () => Ref.update(
          journalState,
          (current) => withOperationPhase({
              ...current,
              nextStageIndex: current.nextStageIndex + 1,
            }, "verified"),
        ),
        complete: () => Effect.gen(function*() {
          if (yield* Ref.getAndSet(failCompletion, false)) {
            return yield* Effect.fail(new Error("disposable interruption"));
          }
          yield* Ref.update(auditWrites, (count) => count + 1);
          yield* Ref.update(
            journalState,
            (current) => withOperationPhase(current, "completed"),
          );
        }),
      });
      const openfga = Layer.succeed(OpenFgaAuthorizationApi, {
        mutateTuples: (request) => Ref.update(mutations, (items) => [
          ...items,
          request,
        ]),
        check: (request) => Effect.gen(function*() {
          yield* Ref.update(checks, (items) => [...items, request]);
          return true;
        }),
      });
      const identity = Layer.succeed(AccessControlIdentityCache, {
        invalidate: () => Ref.update(invalidations, (count) => count + 1),
      });
      const guard = Layer.succeed(AccessControlOperationGuard, {
        validate: () => Effect.void,
      });
      const layer = Layer.mergeAll(journal, openfga, identity, guard);

      yield* executeAccessControlOperation(operation.operationId).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      yield* executeAccessControlOperation(operation.operationId).pipe(
        Effect.provide(layer),
      );

      assert.lengthOf(yield* Ref.get(mutations), 1);
      assert.lengthOf(yield* Ref.get(checks), 2);
      assert.strictEqual(yield* Ref.get(invalidations), 2);
      assert.strictEqual(yield* Ref.get(auditWrites), 1);
      assert.strictEqual((yield* Ref.get(journalState)).phase, "completed");
    }));

  it.effect("interrupts a stalled revocation at the published SLO", () =>
    Effect.gen(function*() {
      const deployment: OpenFgaDeploymentV1 = {
        storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        authorizationModelId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      };
      const transition = yield* prepareAccessControlTupleTransition({
        deployment,
        previous: { ceiling: ceiling(), profile: profile(), binding: binding() },
        next: {
          ceiling: ceiling(),
          profile: profile(),
          binding: binding("revoked"),
        },
      });
      const operation = controlOperation(transition, "binding_revoked");
      const layer = Layer.mergeAll(
        Layer.succeed(AccessControlJournal, {
          load: () => Effect.succeed(operation),
          advanceStage: () => Effect.void,
          complete: () => Effect.void,
        }),
        Layer.succeed(OpenFgaAuthorizationApi, {
          mutateTuples: () => Effect.never,
          check: () => Effect.succeed(false),
        }),
        Layer.succeed(AccessControlIdentityCache, {
          invalidate: () => Effect.void,
        }),
        Layer.succeed(AccessControlOperationGuard, {
          validate: () => Effect.void,
        }),
      );
      const fiber = yield* Effect.forkChild(
        executeAccessControlOperation(operation.operationId).pipe(
          Effect.provide(layer),
        ),
      );
      yield* TestClock.adjust(ACCESS_POLICY_REVOCATION_SLO_MILLIS + 1);
      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.instanceOf(failure, AccessControlOperationSloExceeded);
      assert.strictEqual(failure.sloMillis, ACCESS_POLICY_REVOCATION_SLO_MILLIS);
    }));

  it.effect("rejects a noncanonical journal plan before contacting OpenFGA", () =>
    Effect.gen(function*() {
      const deployment: OpenFgaDeploymentV1 = {
        storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        authorizationModelId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      };
      const transition = yield* prepareAccessControlTupleTransition({
        deployment,
        previous: null,
        next: { ceiling: ceiling(), profile: profile(), binding: binding() },
      });
      const operation = controlOperation(transition, "binding_created");
      const mutations = yield* Ref.make(0);
      const layer = Layer.mergeAll(
        Layer.succeed(AccessControlJournal, {
          load: () => Effect.succeed(operation),
          advanceStage: () => Effect.void,
          complete: () => Effect.void,
        }),
        Layer.succeed(OpenFgaAuthorizationApi, {
          mutateTuples: () => Ref.update(mutations, (count) => count + 1),
          check: () => Effect.succeed(true),
        }),
        Layer.succeed(AccessControlIdentityCache, {
          invalidate: () => Effect.void,
        }),
        Layer.succeed(AccessControlOperationGuard, {
          validate: () => Effect.fail(AccessControlOperationPlanMismatch.make({
            operationId: operation.operationId,
          })),
        }),
      );
      const failure = yield* executeAccessControlOperation(operation.operationId).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      assert.instanceOf(failure, AccessControlOperationPlanMismatch);
      assert.strictEqual(yield* Ref.get(mutations), 0);
    }));
});

function withOperationPhase(
  operation: AccessControlOperationV1,
  phase: AccessControlOperationV1["phase"],
): AccessControlOperationV1 {
  return { ...operation, phase };
}

function controlOperation(
  transition: {
    readonly subject: string;
    readonly stages: AccessControlOperationV1["stages"];
    readonly verifications: AccessControlOperationV1["stages"][number]["verifications"];
  },
  kind: AccessControlOperationV1["kind"],
): AccessControlOperationV1 {
  return {
    schemaVersion: 1,
    operationId: "44444444-4444-4444-8444-444444444444",
    phase: "prepared",
    nextStageIndex: 0,
    kind,
    subjects: [binding().subject],
    stages: transition.stages,
    audit: {
      schemaVersion: 1,
      eventId: "authz_0123456789abcdef0123456789abcdef",
      operationId: "44444444-4444-4444-8444-444444444444",
      timestampMillis: EffectiveAt,
      actor: { agentId: MateId, serviceAccountUid: ServiceAccountUid },
      correlationId: "corr_0123456789abcdef0123456789abcdef",
      kind,
      target: {
        bindingId: binding().bindingId,
        subject: binding().subject,
        profile: binding().profile,
      },
      previousVersion: kind === "binding_revoked" ? 1 : null,
      newVersion: kind === "binding_created" ? 1 : null,
      mutationReason: kind === "binding_revoked"
        ? "assignment_ended"
        : "assignment_requirement",
      decision: "recorded",
    },
  };
}
