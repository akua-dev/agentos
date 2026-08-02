import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";

import {
  type AccessBindingSubjectV1,
  type AccessPermissionV1,
  type AuthorizationResourceV1,
} from "../contracts.ts";
import type { WorkloadIdentityV1 } from "../identity.ts";
import {
  A2aPolicyAuthorizer,
  makeA2aPolicyAuthorizerLayer,
} from "../../protocol/a2a-runtime.ts";
import {
  OpenFgaAuthorizationApi,
  openFgaCapabilityRelation,
  openFgaCeiling,
  openFgaProfile,
  openFgaSubject,
  openFgaTarget,
  type OpenFgaApiCheckRequest,
  type OpenFgaDeploymentV1,
} from "../openfga.ts";
import {
  ProviderPolicySnapshotStore,
  type ProviderPolicySnapshotV1,
} from "../postgres-identity.ts";

const Now = Date.parse("2026-08-02T12:00:00.000Z");
const TargetAgentId = "22222222-2222-4222-8222-222222222222";
const CallerAgentId = "11111111-1111-4111-8111-111111111111";
const Deployment: OpenFgaDeploymentV1 = {
  storeId: "01K1J6T8NS7B4K5AT9E1YH8D5R",
  authorizationModelId: "01K1J6V6Z3S94FWX6H3M1TDME4",
};
const Identity: WorkloadIdentityV1 = {
  schemaVersion: 1,
  agentId: CallerAgentId,
  role: "second_mate",
  fleet: "fleet-alpha",
  domain: "platform",
  assignmentId: null,
  kubernetesNamespace: "agentos-platform",
  kubernetesPod: "platform-mate-0",
  podUid: "77777777-7777-4777-8777-777777777777",
  serviceAccountName: "platform-mate",
  serviceAccountUid: "88888888-8888-4888-8888-888888888888",
};
const Subject: AccessBindingSubjectV1 = {
  kind: "mate",
  fleet: "fleet-alpha",
  domain: "platform",
  agentId: CallerAgentId,
};
const Resource: AuthorizationResourceV1 = {
  kind: "agent_skill",
  targetAgentId: TargetAgentId,
  skillId: "repository.implementation@v1",
};
const Permission: AccessPermissionV1 = {
  capability: "agentos.a2a.send",
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
    profileId: "platform-builder",
    profileVersion: 3,
    previousProfileVersion: 2,
    targetScope: {
      kind: "domain",
      fleet: "fleet-alpha",
      domain: "platform",
    },
    permissions: [Permission],
    issuedUnderCeiling: {
      ceilingId: "ceiling_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      revision: 7,
    },
  },
  ceiling: {
    ceilingId: "ceiling_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    revision: 7,
    scope: {
      kind: "domain",
      fleet: "fleet-alpha",
      domain: "platform",
    },
    effectiveAtMillis: Now - 120_000,
    permissions: [{ ...Permission, rateClass: "high" }],
  },
};

function policyLayer(input?: {
  readonly snapshot?: ProviderPolicySnapshotV1;
  readonly check?: (
    request: OpenFgaApiCheckRequest,
  ) => Effect.Effect<boolean>;
}) {
  return makeA2aPolicyAuthorizerLayer({
    deployment: Deployment,
    environment: "production",
  }).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(ProviderPolicySnapshotStore, {
      findBySubject: () => Effect.succeed(input?.snapshot ?? Snapshot),
    }),
    Layer.succeed(OpenFgaAuthorizationApi, {
      mutateTuples: () => Effect.void,
      check: input?.check ?? (() => Effect.succeed(true)),
    }),
  )));
}

const authorize = Effect.gen(function*() {
  const policy = yield* A2aPolicyAuthorizer;
  return yield* policy.authorize({
    version: 1,
    identity: Identity,
    targetAgentId: TargetAgentId,
    skillId: "repository.implementation@v1",
    assignmentId: "66666666-6666-4666-8666-666666666666",
  });
});

describe("A2A reusable access-profile policy", () => {
  it.effect("requires the profile, Captain ceiling, and effective OpenFGA grant", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const checks = yield* Ref.make<ReadonlyArray<OpenFgaApiCheckRequest>>([]);
      const grant = yield* authorize.pipe(Effect.provide(policyLayer({
        check: (request) =>
          Ref.update(checks, (all) => [...all, request]).pipe(Effect.as(true)),
      })));
      const relation = openFgaCapabilityRelation("agentos.a2a.send");
      const target = openFgaTarget("fleet-alpha", Permission);
      assert.deepStrictEqual(yield* Ref.get(checks), [
        {
          ...Deployment,
          user: openFgaProfile("fleet-alpha", Snapshot.profile),
          relation: relation.profile,
          object: target,
          context: { current_time: "2026-08-02T12:00:00.000Z" },
          consistency: "HIGHER_CONSISTENCY",
        },
        {
          ...Deployment,
          user: openFgaCeiling("fleet-alpha", Snapshot.ceiling),
          relation: relation.ceiling,
          object: target,
          context: { current_time: "2026-08-02T12:00:00.000Z" },
          consistency: "HIGHER_CONSISTENCY",
        },
        {
          ...Deployment,
          user: openFgaSubject(Subject),
          relation: relation.allow,
          object: target,
          context: { current_time: "2026-08-02T12:00:00.000Z" },
          consistency: "HIGHER_CONSISTENCY",
        },
      ]);
      assert.deepStrictEqual(grant, {
        version: 1,
        callerAgentId: CallerAgentId,
        targetAgentId: TargetAgentId,
        skillId: "repository.implementation@v1",
        profileId: "platform-builder",
        profileVersion: 3,
        ceilingId: "ceiling_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ceilingRevision: 7,
      });
    }));

  it.effect("filters guessed, revoked, or ceiling-exceeding skills without enumeration", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const policy = yield* A2aPolicyAuthorizer;
      const allowed = yield* policy.filterAuthorizedSkills({
        version: 1,
        identity: Identity,
        targetAgentId: TargetAgentId,
        skillIds: [
          "repository.implementation@v1",
          "production.deployment@v1",
          "guessed.root@v1",
        ],
      });
      assert.deepStrictEqual(allowed, ["repository.implementation@v1"]);
    }).pipe(Effect.provide(policyLayer())));

  it.effect("fails closed when any strong OpenFGA check is denied", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const relation = openFgaCapabilityRelation("agentos.a2a.send");
      for (const deniedRelation of [
        relation.profile,
        relation.ceiling,
        relation.allow,
      ]) {
        const failure = yield* authorize.pipe(
          Effect.provide(policyLayer({
            check: (request) =>
              Effect.succeed(request.relation !== deniedRelation),
          })),
          Effect.flip,
        );
        assert.strictEqual(failure.outcome, "denied");
        assert.strictEqual(failure.retryable, false);
      }
    }));

  it.effect("reports PostgreSQL/OpenFGA availability through readiness", () =>
    Effect.gen(function*() {
      const policy = yield* A2aPolicyAuthorizer;
      assert.isTrue(yield* policy.ready);
    }).pipe(Effect.provide(policyLayer())));
});
