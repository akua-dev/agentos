import assert from "node:assert/strict";

import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import { Effect, Layer, Redacted } from "effect";

import {
  OpenFgaAuthorizationApiHttpLayer,
  OpenFgaManagementApiHttpLayer,
  bootstrapOpenFgaAuthorization,
  makeOpenFgaHttpTransportLayer,
} from "../../../packages/agentos/src/access/openfga-http.ts";
import {
  OpenFgaAuthorizationApi,
  compileOpenFgaAuthorizationState,
  diffOpenFgaTuplePlans,
  openFgaCapabilityRelation,
  openFgaSubject,
  openFgaTarget,
  type OpenFgaApiCheckRequest,
} from "../../../packages/agentos/src/access/openfga.ts";
import type {
  AccessBindingV1,
  AccessCeilingV1,
  AccessPermissionV1,
  AccessProfileVersionV1,
  AuthorizationResourceV1,
} from "../../../packages/agentos/src/access/contracts.ts";

const baseUrl = process.env.OPENFGA_TEST_URL;
if (baseUrl === undefined) {
  throw new Error("OPENFGA_TEST_URL is required");
}

const Fleet = "agentos";
const OtherFleet = "other-fleet";
const MateId = "11111111-1111-4111-8111-111111111111";
const CaptainId = "22222222-2222-4222-8222-222222222222";
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

function profile(
  permissions: readonly [AccessPermissionV1, ...Array<AccessPermissionV1>] = [
    writeIssue,
    readIssue,
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

function ceiling(
  revision: number,
  permissions: readonly [AccessPermissionV1, ...Array<AccessPermissionV1>],
): AccessCeilingV1 {
  return {
    schemaVersion: 1,
    ceilingId: "ceiling_0123456789abcdef0123456789abcdef",
    revision,
    supersedesRevision: revision === 1 ? null : revision - 1,
    owner: { authority: "captain-platform", captainId: CaptainId },
    scope: { kind: "domain", fleet: Fleet, domain: "platform" },
    effectiveAtMillis: EffectiveAt,
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
      fleet: Fleet,
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

const transport = makeOpenFgaHttpTransportLayer({
  baseUrl,
  presharedKey: process.env.OPENFGA_TEST_PRESHARED_KEY === undefined
    ? null
    : Redacted.make(process.env.OPENFGA_TEST_PRESHARED_KEY),
  timeoutMillis: 5_000,
  maximumResponseBytes: 512 * 1_024,
}).pipe(Layer.provide(BunHttpClient.layer));
const services = Layer.merge(
  OpenFgaManagementApiHttpLayer.pipe(Layer.provide(transport)),
  OpenFgaAuthorizationApiHttpLayer.pipe(Layer.provide(transport)),
);

const program = Effect.gen(function*() {
  const deployment = yield* bootstrapOpenFgaAuthorization;
  const api = yield* OpenFgaAuthorizationApi;
  let assertions = 0;
  const check = Effect.fn("agentos.openfga.conformance.check")(
    function*(
      permission: AccessPermissionV1,
      fleet: string,
      currentTime: string,
    ) {
      return yield* api.check({
        ...deployment,
        user: openFgaSubject(binding().subject),
        relation: openFgaCapabilityRelation(permission.capability).allow,
        object: openFgaTarget(fleet, permission),
        context: { current_time: currentTime },
        consistency: "HIGHER_CONSISTENCY",
      } satisfies OpenFgaApiCheckRequest);
    },
  );

  const initial = yield* compileOpenFgaAuthorizationState({
    ceiling: ceiling(1, [writeIssue, readIssue]),
    profile: profile(),
    binding: binding(),
  });
  yield* api.mutateTuples({
    ...deployment,
    mutation: { writes: initial.tuples, deletes: [] },
  });
  assert.equal(
    yield* check(writeIssue, Fleet, "2026-08-01T12:00:00.000Z"),
    true,
    "domain membership, profile, and ceiling should allow",
  );
  assertions += 1;
  assert.equal(
    yield* check(writeIssue, OtherFleet, "2026-08-01T12:00:00.000Z"),
    false,
    "a cross-Fleet target should deny",
  );
  assertions += 1;
  assert.equal(
    yield* check(writeIssue, Fleet, "2026-08-02T00:00:00.000Z"),
    false,
    "an expired binding should deny at the exclusive boundary",
  );
  assertions += 1;

  const shrunken = yield* compileOpenFgaAuthorizationState({
    ceiling: ceiling(2, [readIssue]),
    profile: profile(),
    binding: binding(),
  });
  const shrinkMutation = yield* diffOpenFgaTuplePlans(initial, shrunken);
  yield* api.mutateTuples({ ...deployment, mutation: shrinkMutation });
  assert.equal(
    yield* check(writeIssue, Fleet, "2026-08-01T12:00:00.000Z"),
    false,
    "a ceiling shrink should revoke removed capability access",
  );
  assertions += 1;
  assert.equal(
    yield* check(readIssue, Fleet, "2026-08-01T12:00:00.000Z"),
    true,
    "a ceiling shrink should preserve retained capability access",
  );
  assertions += 1;

  const revoked = yield* compileOpenFgaAuthorizationState({
    ceiling: ceiling(2, [readIssue]),
    profile: profile(),
    binding: binding("revoked"),
  });
  yield* api.mutateTuples({
    ...deployment,
    mutation: yield* diffOpenFgaTuplePlans(shrunken, revoked),
  });
  assert.equal(
    yield* check(readIssue, Fleet, "2026-08-01T12:00:00.000Z"),
    false,
    "a revoked profile binding should deny",
  );
  assertions += 1;

  const overCeiling = yield* compileOpenFgaAuthorizationState({
    ceiling: ceiling(1, [{ ...writeIssue, rateClass: "standard" }]),
    profile: profile([{ ...writeIssue, rateClass: "high" }]),
    binding: binding(),
  });
  assert.equal(
    overCeiling.tuples.some(({ relation }) =>
      relation === openFgaCapabilityRelation(writeIssue.capability).allow),
    false,
    "a profile rate above the Captain ceiling must not materialize a grant",
  );
  assertions += 1;
  return { ...deployment, assertions };
});

const result = await Effect.runPromise(program.pipe(Effect.provide(services)));
console.log(JSON.stringify(result));
