import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import {
  AGENTOS_OPENFGA_MODEL_VERSION,
  AgentOSOpenFgaAuthorizationModelV1,
  OpenFgaAuthorizationApi,
  OpenFgaMutationVerificationError,
  applyOpenFgaMutationAndVerify,
  compileOpenFgaAuthorizationState,
  diffOpenFgaTuplePlans,
  openFgaCapabilityRelation,
  openFgaSubject,
  openFgaTarget,
  type OpenFgaApiCheckRequest,
  type OpenFgaApiTupleMutationRequest,
} from "../openfga.ts";
import {
  accessCapabilitiesV1,
  type AccessBindingV1,
  type AccessCeilingV1,
  type AccessPermissionV1,
  type AccessProfileVersionV1,
  type AuthorizationResourceV1,
} from "../contracts.ts";

const MateId = "11111111-1111-4111-8111-111111111111";
const CaptainId = "22222222-2222-4222-8222-222222222222";
const AssignmentId = "33333333-3333-4333-8333-333333333333";
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
  ],
  revision = 1,
  scope: AccessCeilingV1["scope"] = {
    kind: "domain",
    fleet: "agentos",
    domain: "platform",
  },
): AccessCeilingV1 {
  return {
    schemaVersion: 1,
    ceilingId: "ceiling_0123456789abcdef0123456789abcdef",
    revision,
    supersedesRevision: revision === 1 ? null : revision - 1,
    owner: { authority: "captain-platform", captainId: CaptainId },
    scope,
    effectiveAtMillis: EffectiveAt,
    permissions,
  };
}

function profile(
  permissions: readonly [AccessPermissionV1, ...Array<AccessPermissionV1>] = [
    writeIssue,
  ],
): AccessProfileVersionV1 {
  return {
    schemaVersion: 1,
    compatibility: "agentos-access-v1",
    profileId: "github-maintainer",
    profileVersion: 1,
    previousProfileVersion: null,
    publishedBy: "first-mate-control-plane",
    permissions,
  };
}

function binding(
  overrides: Partial<AccessBindingV1> = {},
): AccessBindingV1 {
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
    state: "active",
    ...overrides,
  };
}

describe("AgentOS OpenFGA authorization", () => {
  it.effect("freezes one explicit model relation for every released capability", () =>
    Effect.sync(() => {
      assert.strictEqual(AGENTOS_OPENFGA_MODEL_VERSION, "agentos-access-v1");
      assert.strictEqual(
        AgentOSOpenFgaAuthorizationModelV1.schema_version,
        "1.1",
      );
      const target = AgentOSOpenFgaAuthorizationModelV1.type_definitions.find(
        ({ type }) => type === "authorization_target",
      );
      const ceiling = AgentOSOpenFgaAuthorizationModelV1.type_definitions.find(
        ({ type }) => type === "access_ceiling",
      );
      assert.isDefined(target);
      assert.deepStrictEqual(ceiling?.relations?.subject, { this: {} });
      assert.deepStrictEqual(
        ceiling?.metadata?.relations.subject?.directly_related_user_types,
        [
          { type: "mate", condition: "active_window" },
          { type: "assignment", condition: "active_window" },
        ],
      );
      for (const capability of accessCapabilitiesV1) {
        const relation = openFgaCapabilityRelation(capability.id);
        assert.property(target!.relations, relation.allow);
        assert.deepStrictEqual(target!.relations?.[relation.allow], {
          this: {},
        });
        assert.property(target!.relations, relation.profile);
        assert.property(target!.relations, relation.ceiling);
      }
      assert.notProperty(target!.relations, "allow");
      assert.notInclude(JSON.stringify(target), "*");
    }));

  it.effect("compiles exact Fleet-scoped identity, target, and temporal tuples", () =>
    Effect.gen(function*() {
      const plan = yield* compileOpenFgaAuthorizationState({
        ceiling: ceiling(),
        profile: profile(),
        binding: binding(),
      });
      const subject = openFgaSubject(binding().subject);
      const target = openFgaTarget("agentos", writeIssue);
      const relation = openFgaCapabilityRelation(writeIssue.capability);

      assert.strictEqual(
        subject,
        `mate:fleet%3Aagentos%2Fdomain%3Aplatform%2Fmate%3A${MateId}`,
      );
      assert.strictEqual(
        target,
        "authorization_target:fleet%3Aagentos%7Cgithub%3Arepository%3Aakua-dev%2Fagentos%7Cenvironment%3Aproduction",
      );
      assert.deepStrictEqual(plan, {
        schemaVersion: 1,
        modelVersion: AGENTOS_OPENFGA_MODEL_VERSION,
        fleet: "agentos",
        subject,
        tuples: plan.tuples,
      });
      assert.includeDeepMembers(plan.tuples, [
        {
          user: `domain:fleet%3Aagentos%2Fdomain%3Aplatform`,
          relation: "domain",
          object: "fleet:fleet%3Aagentos",
          condition: null,
        },
        {
          user: subject,
          relation: "member",
          object: "domain:fleet%3Aagentos%2Fdomain%3Aplatform",
          condition: null,
        },
        {
          user: subject,
          relation: "subject",
          object:
            "access_profile:fleet%3Aagentos%2Fprofile%3Agithub-maintainer%40v1",
          condition: {
            name: "active_window",
            context: {
              effective_at: "2026-08-01T00:00:00.000Z",
              expires_at: "2026-08-02T00:00:00.000Z",
            },
          },
        },
        {
          user: subject,
          relation: "subject",
          object:
            "access_ceiling:fleet%3Aagentos%2Fceiling%3Aceiling_0123456789abcdef0123456789abcdef%40r1",
          condition: {
            name: "active_window",
            context: {
              effective_at: "2026-08-01T00:00:00.000Z",
              expires_at: "2026-08-02T00:00:00.000Z",
            },
          },
        },
        {
          user: "fleet:fleet%3Aagentos",
          relation: "fleet",
          object: target,
          condition: null,
        },
        {
          user:
            "access_profile:fleet%3Aagentos%2Fprofile%3Agithub-maintainer%40v1",
          relation: relation.profile,
          object: target,
          condition: {
            name: "active_window",
            context: {
              effective_at: "1970-01-01T00:00:00.000Z",
              expires_at: "2026-08-02T00:00:00.000Z",
            },
          },
        },
        {
          user:
            "access_ceiling:fleet%3Aagentos%2Fceiling%3Aceiling_0123456789abcdef0123456789abcdef%40r1",
          relation: relation.ceiling,
          object: target,
          condition: {
            name: "active_window",
            context: {
              effective_at: "2026-08-01T00:00:00.000Z",
              expires_at: "2026-08-02T00:00:00.000Z",
            },
          },
        },
        {
          user: subject,
          relation: relation.allow,
          object: target,
          condition: {
            name: "active_window",
            context: {
              effective_at: "2026-08-01T00:00:00.000Z",
              expires_at: "2026-08-02T00:00:00.000Z",
            },
          },
        },
      ]);
      assert.isTrue(
        plan.tuples.every(({ object, relation, user }) =>
          !object.includes("*") && !relation.includes("*") && !user.includes("*")),
      );
      assert.isFalse(
        plan.tuples.some(({ relation }) =>
          relation === "fleet_scope" || relation === "domain_scope"),
      );
    }));

  it.effect("does not materialize a grant above the Captain rate ceiling", () =>
    Effect.gen(function*() {
      const plan = yield* compileOpenFgaAuthorizationState({
        ceiling: ceiling([{ ...writeIssue, rateClass: "standard" }]),
        profile: profile([{ ...writeIssue, rateClass: "high" }]),
        binding: binding(),
      });
      const allow = openFgaCapabilityRelation(writeIssue.capability).allow;
      assert.isFalse(plan.tuples.some(({ relation }) => relation === allow));
    }));

  it.effect("uses separate targets and membership paths across Fleets", () =>
    Effect.gen(function*() {
      const otherBinding = binding({
        subject: {
          kind: "assignment",
          fleet: "other-fleet",
          domain: "platform",
          assignmentId: AssignmentId,
        },
      });
      const other = yield* compileOpenFgaAuthorizationState({
        ceiling: ceiling([writeIssue], 1, {
          kind: "fleet",
          fleet: "other-fleet",
        }),
        profile: profile(),
        binding: otherBinding,
      });
      assert.notStrictEqual(
        openFgaTarget("agentos", writeIssue),
        openFgaTarget("other-fleet", writeIssue),
      );
      assert.strictEqual(other.fleet, "other-fleet");
      assert.isTrue(
        other.tuples.every(({ object, user }) =>
          !object.includes("fleet%3Aagentos") &&
          !user.includes("fleet%3Aagentos")),
      );
    }));

  it.effect("removes revoked bindings and atomically replaces a shrunken ceiling", () =>
    Effect.gen(function*() {
      const before = yield* compileOpenFgaAuthorizationState({
        ceiling: ceiling([writeIssue]),
        profile: profile([writeIssue, readIssue]),
        binding: binding(),
      });
      const after = yield* compileOpenFgaAuthorizationState({
        ceiling: ceiling([readIssue], 2),
        profile: profile([writeIssue, readIssue]),
        binding: binding({ state: "revoked" }),
      });
      const mutation = yield* diffOpenFgaTuplePlans(before, after);
      const writeRelation = openFgaCapabilityRelation(
        "github.issue.write",
      );
      const readRelation = openFgaCapabilityRelation("github.issue.read");
      assert.isTrue(
        mutation.deletes.some(({ relation }) =>
          relation === writeRelation.ceiling),
      );
      assert.isTrue(
        mutation.writes.some(({ relation }) => relation === readRelation.ceiling),
      );
      assert.isTrue(
        mutation.deletes.some(({ relation, user }) =>
          relation === "subject" && user === before.subject),
      );
      assert.isFalse(
        mutation.writes.some(({ relation }) => relation === "subject"),
      );
    }));

  it.effect("acknowledges mutations only after a pinned higher-consistency check", () =>
    Effect.gen(function*() {
      const writes = yield* Ref.make<Array<OpenFgaApiTupleMutationRequest>>([]);
      const checks = yield* Ref.make<Array<OpenFgaApiCheckRequest>>([]);
      const api = Layer.succeed(OpenFgaAuthorizationApi)({
        mutateTuples: (request) =>
          Ref.update(writes, (requests) => [...requests, request]),
        check: (request) =>
          Ref.update(checks, (requests) => [...requests, request]).pipe(
            Effect.as(true),
          ),
      });
      const target = openFgaTarget("agentos", writeIssue);
      yield* applyOpenFgaMutationAndVerify({
        deployment: {
          storeId: "01K1J6T8NS7B4K5AT9E1YH8D5R",
          authorizationModelId: "01K1J6V6Z3S94FWX6H3M1TDME4",
        },
        mutation: { writes: [], deletes: [] },
        verification: {
          user: openFgaSubject(binding().subject),
          relation: openFgaCapabilityRelation(writeIssue.capability).allow,
          object: target,
          context: { current_time: "2026-08-01T12:00:00.000Z" },
          expectedAllowed: true,
        },
      }).pipe(Effect.provide(api));

      assert.lengthOf(yield* Ref.get(writes), 1);
      assert.deepStrictEqual(yield* Ref.get(checks), [{
        storeId: "01K1J6T8NS7B4K5AT9E1YH8D5R",
        authorizationModelId: "01K1J6V6Z3S94FWX6H3M1TDME4",
        user: openFgaSubject(binding().subject),
        relation: openFgaCapabilityRelation(writeIssue.capability).allow,
        object: target,
        context: { current_time: "2026-08-01T12:00:00.000Z" },
        consistency: "HIGHER_CONSISTENCY",
      }]);

      const mismatch = yield* applyOpenFgaMutationAndVerify({
        deployment: {
          storeId: "01K1J6T8NS7B4K5AT9E1YH8D5R",
          authorizationModelId: "01K1J6V6Z3S94FWX6H3M1TDME4",
        },
        mutation: { writes: [], deletes: [] },
        verification: {
          user: openFgaSubject(binding().subject),
          relation: openFgaCapabilityRelation(writeIssue.capability).allow,
          object: target,
          context: { current_time: "2026-08-01T12:00:00.000Z" },
          expectedAllowed: false,
        },
      }).pipe(Effect.provide(api), Effect.flip);
      assert.instanceOf(mismatch, OpenFgaMutationVerificationError);
    }));
});
