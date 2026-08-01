import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  AccessContractError,
  AccessProfileVersionV1Schema,
  accessCapabilitiesV1,
  authorizationResourceName,
  authorizationSubjectName,
  decodeAccessAuditEvent,
  decodeAccessBinding,
  decodeAccessCeiling,
  decodeAccessProfileVersion,
  evaluateAccessRequest,
  type AccessAuditEventV1,
  type AccessBindingSubjectV1,
  type AccessBindingV1,
  type AccessCeilingV1,
  type AccessPermissionV1,
  type AccessProfileVersionV1,
  type AuthorizationResourceV1,
} from "../contracts.ts";

const MateId = "11111111-1111-4111-8111-111111111111";
const CaptainId = "22222222-2222-4222-8222-222222222222";
const ServiceAccountUid = "33333333-3333-4333-8333-333333333333";

const subject: AccessBindingSubjectV1 = {
  kind: "mate",
  fleet: "agentos",
  domain: "platform",
  agentId: MateId,
};

const repository: AuthorizationResourceV1 = {
  kind: "github_repository",
  owner: "akua-dev",
  repository: "agentos",
};

const writeIssue: AccessPermissionV1 = {
  capability: "github.issue.write",
  resource: repository,
  environment: "production",
  expiresAtMillis: null,
  rateClass: "standard",
};

function ceiling(
  permissions: readonly [AccessPermissionV1, ...Array<AccessPermissionV1>] = [
    writeIssue,
  ],
  revision = 1,
): AccessCeilingV1 {
  return {
    schemaVersion: 1,
    ceilingId: "ceiling_0123456789abcdef0123456789abcdef",
    revision,
    supersedesRevision: revision === 1 ? null : revision - 1,
    owner: {
      authority: "captain-platform",
      captainId: CaptainId,
    },
    scope: {
      kind: "domain",
      fleet: "agentos",
      domain: "platform",
    },
    effectiveAtMillis: 1_785_556_800_000,
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

function binding(): AccessBindingV1 {
  return {
    schemaVersion: 1,
    bindingId: "binding_0123456789abcdef0123456789abcdef",
    profile: { profileId: "github-maintainer", profileVersion: 1 },
    subject,
    issuedUnderCeiling: {
      ceilingId: "ceiling_0123456789abcdef0123456789abcdef",
      revision: 1,
    },
    createdAtMillis: 1_785_556_800_100,
    expiresAtMillis: null,
    state: "active",
  };
}

describe("canonical provider capabilities and Captain ceilings", () => {
  it.effect(
    "publishes one finite action-specific registry with exact resource authorities",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(
          accessCapabilitiesV1.map(({ id }) => id),
          [
            "github.actions.dispatch",
            "github.actions.read",
            "github.contents.write",
            "github.issue.read",
            "github.issue.write",
            "github.project.read",
            "github.project.write",
            "github.pull_request.read",
            "github.pull_request.write",
            "github.repository.read",
            "openai.models.read",
            "openai.responses.compact",
            "openai.responses.create",
            "provider.secret.use",
          ],
        );
        assert.isTrue(Object.isFrozen(accessCapabilitiesV1));
        assert.isTrue(
          accessCapabilitiesV1.every(
            (capability) =>
              Object.isFrozen(capability) &&
              Object.isFrozen(capability.resourceKinds) &&
              capability.registryAuthority === "captain-platform" &&
              capability.grantAuthority === "first-mate-within-ceiling" &&
              capability.resourceKinds.length > 0 &&
              !capability.id.includes("*"),
          ),
        );
        assert.deepStrictEqual(
          accessCapabilitiesV1.find(({ id }) => id === "github.issue.write"),
          {
            id: "github.issue.write",
            provider: "github",
            action: "issue_write",
            resourceKinds: ["github_repository"],
            registryAuthority: "captain-platform",
            grantAuthority: "first-mate-within-ceiling",
          },
        );
        assert.deepStrictEqual(
          accessCapabilitiesV1.find(
            ({ id }) => id === "openai.responses.create",
          )?.resourceKinds,
          ["provider_service", "provider_account"],
        );

        const aiService: AuthorizationResourceV1 = {
          kind: "provider_service",
          provider: "openai",
          service: "fleet-ai-gateway",
        };
        const aiPermissions: readonly [AccessPermissionV1, AccessPermissionV1] =
          [
            {
              capability: "openai.responses.create",
              resource: aiService,
              environment: "production",
              expiresAtMillis: null,
              rateClass: "standard",
            },
            {
              capability: "openai.responses.compact",
              resource: aiService,
              environment: "production",
              expiresAtMillis: null,
              rateClass: "standard",
            },
          ];
        const aiProfile = yield* decodeAccessProfileVersion({
          ...profile(aiPermissions),
          profileId: "ai-responses",
        });
        assert.deepStrictEqual(
          aiProfile.permissions.map(({ capability }) => capability),
          ["openai.responses.create", "openai.responses.compact"],
        );
      }),
  );

  it.effect(
    "decodes and canonically names Fleet subjects and exact provider resources",
    () =>
      Effect.gen(function* () {
        const decodedCeiling = yield* decodeAccessCeiling(ceiling());
        const decodedProfile = yield* decodeAccessProfileVersion(profile());
        const decodedBinding = yield* decodeAccessBinding(binding());

        assert.strictEqual(
          authorizationSubjectName(decodedBinding.subject),
          `fleet:agentos/domain:platform/mate:${MateId}`,
        );
        assert.strictEqual(
          authorizationResourceName(decodedProfile.permissions[0]!.resource),
          "github:repository:akua-dev/agentos",
        );
        assert.strictEqual(decodedCeiling.owner.authority, "captain-platform");
        assert.deepStrictEqual(
          yield* Schema.encodeEffect(AccessProfileVersionV1Schema)(
            decodedProfile,
          ),
          profile(),
        );
      }),
  );

  it.effect(
    "lets the current Captain ceiling override an older profile and binding",
    () =>
      Effect.gen(function* () {
        const decodedProfile = yield* decodeAccessProfileVersion(profile());
        const decodedBinding = yield* decodeAccessBinding(binding());
        const initial = yield* decodeAccessCeiling(ceiling());
        const allowed = yield* evaluateAccessRequest({
          atMillis: 1_785_556_801_000,
          subject,
          ceiling: initial,
          profile: decodedProfile,
          binding: decodedBinding,
          capability: "github.issue.write",
          resource: repository,
          environment: "production",
        });
        assert.deepStrictEqual(allowed, {
          schemaVersion: 1,
          decision: "allow",
          reason: "allowed",
          capability: "github.issue.write",
          resource: repository,
          environment: "production",
          subject,
          profile: { profileId: "github-maintainer", profileVersion: 1 },
          ceiling: {
            ceilingId: "ceiling_0123456789abcdef0123456789abcdef",
            revision: 1,
          },
          rateClass: "standard",
        });

        const readOnlyPermission: AccessPermissionV1 = {
          ...writeIssue,
          capability: "github.issue.read",
        };
        const shrunken = yield* decodeAccessCeiling(
          ceiling([readOnlyPermission], 2),
        );
        const denied = yield* evaluateAccessRequest({
          atMillis: 1_785_556_801_000,
          subject,
          ceiling: shrunken,
          profile: decodedProfile,
          binding: decodedBinding,
          capability: "github.issue.write",
          resource: repository,
          environment: "production",
        });
        assert.strictEqual(denied.decision, "deny");
        assert.strictEqual(denied.reason, "ceiling_denied");
        assert.strictEqual(denied.ceiling.revision, 2);
      }),
  );

  it.effect(
    "enforces exact environment, expiry, rate class, subject, and profile version",
    () =>
      Effect.gen(function* () {
        const decodedBinding = yield* decodeAccessBinding(binding());
        const standardProfile = yield* decodeAccessProfileVersion(profile());
        const lowCeiling = yield* decodeAccessCeiling(
          ceiling([{ ...writeIssue, rateClass: "low" }]),
        );
        const rateDenied = yield* evaluateAccessRequest({
          atMillis: 1_785_556_801_000,
          subject,
          ceiling: lowCeiling,
          profile: standardProfile,
          binding: decodedBinding,
          capability: "github.issue.write",
          resource: repository,
          environment: "production",
        });
        assert.strictEqual(rateDenied.reason, "rate_class_exceeded");

        const disabled = yield* evaluateAccessRequest({
          atMillis: 1_785_556_801_000,
          subject,
          ceiling: yield* decodeAccessCeiling(
            ceiling([{ ...writeIssue, rateClass: "disabled" }]),
          ),
          profile: standardProfile,
          binding: decodedBinding,
          capability: "github.issue.write",
          resource: repository,
          environment: "production",
        });
        assert.strictEqual(disabled.reason, "rate_class_disabled");

        const expiredProfile = yield* decodeAccessProfileVersion(
          profile([{ ...writeIssue, expiresAtMillis: 1_785_556_800_500 }]),
        );
        const expired = yield* evaluateAccessRequest({
          atMillis: 1_785_556_801_000,
          subject,
          ceiling: yield* decodeAccessCeiling(ceiling()),
          profile: expiredProfile,
          binding: decodedBinding,
          capability: "github.issue.write",
          resource: repository,
          environment: "production",
        });
        assert.strictEqual(expired.reason, "profile_expired");

        const wrongEnvironment = yield* evaluateAccessRequest({
          atMillis: 1_785_556_801_000,
          subject,
          ceiling: yield* decodeAccessCeiling(ceiling()),
          profile: standardProfile,
          binding: decodedBinding,
          capability: "github.issue.write",
          resource: repository,
          environment: "staging",
        });
        assert.strictEqual(wrongEnvironment.reason, "profile_denied");

        const wrongSubject = yield* evaluateAccessRequest({
          atMillis: 1_785_556_801_000,
          subject: {
            ...subject,
            agentId: "44444444-4444-4444-8444-444444444444",
          },
          ceiling: yield* decodeAccessCeiling(ceiling()),
          profile: standardProfile,
          binding: decodedBinding,
          capability: "github.issue.write",
          resource: repository,
          environment: "production",
        });
        assert.strictEqual(wrongSubject.reason, "subject_mismatch");

        const broadBinding = yield* decodeAccessBinding({
          ...binding(),
          subject: {
            kind: "domain",
            fleet: "agentos",
            domain: "platform",
          },
        }).pipe(Effect.flip);
        assert.strictEqual(broadBinding.code, "invalid_field");
      }),
  );

  it.effect(
    "rejects unknown, wildcard, mismatched, duplicate, and ambiguous profile data",
    () =>
      Effect.gen(function* () {
        const invalidInputs: ReadonlyArray<{
          input: unknown;
          code: AccessContractError["code"];
        }> = [
          {
            input: {
              ...profile(),
              permissions: [{ ...writeIssue, capability: "github.root" }],
            },
            code: "invalid_field",
          },
          {
            input: {
              ...profile(),
              permissions: [
                {
                  ...writeIssue,
                  resource: { ...repository, repository: "*" },
                },
              ],
            },
            code: "invalid_field",
          },
          {
            input: {
              ...profile(),
              permissions: [
                {
                  ...writeIssue,
                  resource: {
                    kind: "provider_service",
                    provider: "openai",
                    service: "fleet-ai-gateway",
                  },
                },
              ],
            },
            code: "resource_mismatch",
          },
          {
            input: { ...profile(), permissions: [writeIssue, writeIssue] },
            code: "duplicate_permission",
          },
          {
            input: {
              ...profile(),
              profileVersion: 2,
              previousProfileVersion: null,
            },
            code: "ambiguous_version",
          },
        ];

        yield* Effect.forEach(invalidInputs, ({ input, code }) =>
          decodeAccessProfileVersion(input).pipe(
            Effect.flip,
            Effect.map((error) => {
              assert.instanceOf(error, AccessContractError);
              assert.strictEqual(error.code, code);
            }),
          ),
        );
      }),
  );

  it.effect(
    "keeps profile, ceiling, binding, and audit records payload-free",
    () =>
      Effect.gen(function* () {
        const audit: AccessAuditEventV1 = {
          schemaVersion: 1,
          eventId: "authz_0123456789abcdef0123456789abcdef",
          timestampMillis: 1_785_556_801_000,
          kind: "access_evaluated",
          actor: {
            agentId: MateId,
            serviceAccountUid: ServiceAccountUid,
          },
          subject,
          profile: { profileId: "github-maintainer", profileVersion: 1 },
          bindingId: "binding_0123456789abcdef0123456789abcdef",
          ceiling: {
            ceilingId: "ceiling_0123456789abcdef0123456789abcdef",
            revision: 2,
          },
          capability: "github.issue.write",
          resource: repository,
          environment: "production",
          decision: "deny",
          reason: "ceiling_denied",
          correlationId: "corr_0123456789abcdef0123456789abcdef",
        };
        const decoded = yield* decodeAccessAuditEvent(audit);
        assert.strictEqual(decoded.reason, "ceiling_denied");

        const ambiguousAudit = yield* decodeAccessAuditEvent({
          ...audit,
          kind: "binding_created",
        }).pipe(Effect.flip);
        assert.strictEqual(ambiguousAudit.code, "invalid_field");

        const forbiddenFields = [
          "authorization",
          "credential",
          "prompt",
          "providerResponseBody",
          "requestBody",
          "token",
        ];
        const records: ReadonlyArray<{
          readonly input: Readonly<Record<string, unknown>>;
          readonly decode: (
            input: unknown,
          ) => Effect.Effect<unknown, AccessContractError>;
        }> = [
          { input: ceiling(), decode: decodeAccessCeiling },
          { input: profile(), decode: decodeAccessProfileVersion },
          { input: binding(), decode: decodeAccessBinding },
          { input: audit, decode: decodeAccessAuditEvent },
        ];
        yield* Effect.forEach(records, ({ decode, input }) =>
          Effect.forEach(forbiddenFields, (field) =>
            decode({
              ...input,
              [field]: "Bearer protected-value-must-not-leak",
            }).pipe(
              Effect.flip,
              Effect.map((error) => {
                assert.strictEqual(error.code, "invalid_field");
                assert.notInclude(
                  JSON.stringify(error),
                  "protected-value-must-not-leak",
                );
              }),
            ),
          ),
        );
      }),
  );
});
