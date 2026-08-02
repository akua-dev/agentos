import {
  Clock,
  Context,
  Crypto,
  Effect,
  Layer,
  Schema,
} from "effect";

import {
  accessCapabilitiesV1,
  authorizationResourceName,
  authorizationSubjectName,
  type AccessBindingSubjectV1,
  type AccessPermissionV1,
  type AccessRateClassId,
} from "./contracts.ts";
import {
  ProviderPolicyDecisionError,
  ProviderPolicyDecisionPoint,
  ProviderPolicyDecisionRefV1Schema,
  type ProviderPolicyDecisionRequestV1,
} from "./credential-delivery.ts";
import {
  OpenFgaAuthorizationApi,
  type OpenFgaDeploymentV1,
  openFgaCapabilityRelation,
  openFgaCeiling,
  openFgaProfile,
  openFgaSubject,
  openFgaTarget,
} from "./openfga.ts";
import {
  ProviderPolicySnapshotStore,
  type ProviderPolicySnapshotUnavailable,
  type ProviderPolicySnapshotV1,
} from "./postgres-identity.ts";
import {
  ProviderBudgetEnforcementError,
  ProviderBudgetEnforcer,
} from "./provider-budget.ts";

export const PROVIDER_POLICY_DECISION_MAX_TTL_MILLIS = 15_000;

const RateClassRank: Readonly<Record<AccessRateClassId, number>> =
  Object.freeze({
    disabled: 0,
    low: 1,
    standard: 2,
    high: 3,
  });

export interface ProviderPolicyDecisionPointOptions {
  readonly deployment: OpenFgaDeploymentV1;
  readonly environment: string | null;
  readonly maximumDecisionTtlMillis?: number;
}

function decisionError(
  outcome: ProviderPolicyDecisionError["outcome"],
  retryable: boolean,
) {
  return ProviderPolicyDecisionError.make({ outcome, retryable });
}

function mapSnapshotFailure(
  error: ProviderPolicySnapshotUnavailable,
): ProviderPolicyDecisionError {
  switch (error.code) {
    case "database_unavailable":
    case "invalid_response":
    case "binding_ambiguous":
      return decisionError("database_unavailable", true);
    case "binding_not_found":
    case "binding_pending":
    case "binding_expired":
    case "binding_not_effective":
    case "subject_mismatch":
      return decisionError("identity_rejected", false);
    case "profile_stale":
    case "reference_mismatch":
    case "ceiling_reconciliation_pending":
    case "ceiling_inactive":
    case "ceiling_not_effective":
    case "operation_unreconciled":
      return decisionError("policy_stale", true);
  }
}

function mapBudgetFailure(
  error: ProviderBudgetEnforcementError,
): ProviderPolicyDecisionError {
  switch (error.outcome) {
    case "rate_class_disabled":
    case "rate_limited":
    case "budget_exhausted":
      return decisionError(error.outcome, error.retryable);
    case "database_unavailable":
      return decisionError("database_unavailable", true);
    case "invalid_reservation":
    case "invalid_settlement":
    case "policy_stale":
      return decisionError("policy_stale", true);
  }
}

function asBindingSubject(
  request: ProviderPolicyDecisionRequestV1,
): Effect.Effect<AccessBindingSubjectV1, ProviderPolicyDecisionError> {
  return request.subject.kind === "mate" || request.subject.kind === "assignment"
    ? Effect.succeed(request.subject)
    : Effect.fail(decisionError("identity_rejected", false));
}

function routeIsCanonical(request: ProviderPolicyDecisionRequestV1) {
  const capability = accessCapabilitiesV1.find(({ id }) =>
    id === request.capability
  );
  if (
    capability === undefined ||
    capability.provider !== request.provider ||
    !capability.resourceKinds.includes(request.resource.kind)
  ) {
    return false;
  }
  if (
    request.resource.kind === "provider_service" ||
    request.resource.kind === "provider_account" ||
    request.resource.kind === "provider_adapter"
  ) {
    return request.resource.provider === request.provider;
  }
  if (request.resource.kind === "agent_skill") {
    return request.provider === "agentos";
  }
  return request.provider === "github";
}

function sameSubject(
  left: AccessBindingSubjectV1,
  right: AccessBindingSubjectV1,
) {
  return authorizationSubjectName(left) === authorizationSubjectName(right);
}

function sameScope(
  left: ProviderPolicySnapshotV1["profile"]["targetScope"],
  right: ProviderPolicySnapshotV1["ceiling"]["scope"],
) {
  return left.kind === right.kind && left.fleet === right.fleet &&
    (left.kind === "fleet" ||
      (right.kind === "domain" && left.domain === right.domain));
}

function scopeContainsSubject(
  scope: ProviderPolicySnapshotV1["ceiling"]["scope"],
  subject: AccessBindingSubjectV1,
) {
  return scope.fleet === subject.fleet &&
    (scope.kind === "fleet" || scope.domain === subject.domain);
}

function validateSnapshot(
  snapshot: ProviderPolicySnapshotV1,
  subject: AccessBindingSubjectV1,
  now: number,
) {
  if (
    !sameSubject(snapshot.binding.subject, subject) ||
    snapshot.binding.createdAtMillis > now ||
    (snapshot.binding.expiresAtMillis !== null &&
      snapshot.binding.expiresAtMillis <= now)
  ) {
    return Effect.fail(decisionError("identity_rejected", false));
  }
  if (
    snapshot.profile.issuedUnderCeiling.ceilingId !==
      snapshot.ceiling.ceilingId ||
    snapshot.profile.issuedUnderCeiling.revision !==
      snapshot.ceiling.revision ||
    !sameScope(snapshot.profile.targetScope, snapshot.ceiling.scope) ||
    !scopeContainsSubject(snapshot.ceiling.scope, subject) ||
    snapshot.ceiling.effectiveAtMillis > now
  ) {
    return Effect.fail(decisionError("policy_stale", true));
  }
  return Effect.void;
}

function matchingPermissions(
  permissions: ReadonlyArray<AccessPermissionV1>,
  request: ProviderPolicyDecisionRequestV1,
  environment: string | null,
) {
  const resource = authorizationResourceName(request.resource);
  return permissions.filter((permission) =>
    permission.capability === request.capability &&
    authorizationResourceName(permission.resource) === resource &&
    permission.environment === environment
  );
}

function activePermission(
  permissions: ReadonlyArray<AccessPermissionV1>,
  request: ProviderPolicyDecisionRequestV1,
  environment: string | null,
  now: number,
  deniedOutcome: "profile_denied" | "ceiling_denied",
) {
  const matches = matchingPermissions(permissions, request, environment);
  if (matches.length === 0) {
    return Effect.fail(decisionError(deniedOutcome, false));
  }
  if (matches.length !== 1) {
    return Effect.fail(decisionError("policy_stale", true));
  }
  const permission = matches[0]!;
  if (
    permission.expiresAtMillis !== null &&
    permission.expiresAtMillis <= now
  ) {
    return Effect.fail(decisionError(deniedOutcome, false));
  }
  return Effect.succeed(permission);
}

function minimumExpiry(
  now: number,
  maximumDecisionTtlMillis: number,
  ...values: ReadonlyArray<number | null>
) {
  const finite = values.filter((value): value is number => value !== null);
  return Math.min(now + maximumDecisionTtlMillis, ...finite);
}

export class ProviderDecisionReferenceGenerator extends Context.Service<
  ProviderDecisionReferenceGenerator,
  {
    readonly next: Effect.Effect<string, ProviderPolicyDecisionError>;
  }
>()("agentos/access/ProviderDecisionReferenceGenerator") {}

export const ProviderDecisionReferenceGeneratorLiveLayer = Layer.effect(
  ProviderDecisionReferenceGenerator,
  Effect.gen(function*() {
    const crypto = yield* Crypto.Crypto;
    return ProviderDecisionReferenceGenerator.of({
      next: crypto.randomUUIDv4.pipe(
        Effect.map((id) => id.replaceAll("-", "")),
        Effect.mapError(() =>
          decisionError("decision_reference_unavailable", true)
        ),
      ),
    });
  }),
);

function openFgaChecks(input: {
  readonly deployment: OpenFgaDeploymentV1;
  readonly snapshot: ProviderPolicySnapshotV1;
  readonly subject: AccessBindingSubjectV1;
  readonly permission: AccessPermissionV1;
  readonly now: number;
}) {
  return Effect.gen(function*() {
    const api = yield* OpenFgaAuthorizationApi;
    const relation = openFgaCapabilityRelation(input.permission.capability);
    const target = openFgaTarget(input.subject.fleet, input.permission);
    const context = { current_time: new Date(input.now).toISOString() };
    const checked = yield* Effect.all([
      api.check({
        ...input.deployment,
        user: openFgaProfile(input.subject.fleet, input.snapshot.profile),
        relation: relation.profile,
        object: target,
        context,
        consistency: "HIGHER_CONSISTENCY",
      }),
      api.check({
        ...input.deployment,
        user: openFgaCeiling(input.subject.fleet, input.snapshot.ceiling),
        relation: relation.ceiling,
        object: target,
        context,
        consistency: "HIGHER_CONSISTENCY",
      }),
      api.check({
        ...input.deployment,
        user: openFgaSubject(input.subject),
        relation: relation.allow,
        object: target,
        context,
        consistency: "HIGHER_CONSISTENCY",
      }),
    ], { concurrency: "unbounded" }).pipe(
      Effect.mapError(() => decisionError("openfga_unavailable", true)),
    );
    if (!checked[0]) {
      return yield* decisionError("profile_denied", false);
    }
    if (!checked[1]) {
      return yield* decisionError("ceiling_denied", false);
    }
    if (!checked[2]) {
      return yield* decisionError("effective_policy_denied", false);
    }
  });
}

export function makeProviderPolicyDecisionPointLayer(
  options: ProviderPolicyDecisionPointOptions,
) {
  const maximumDecisionTtlMillis = options.maximumDecisionTtlMillis ??
    PROVIDER_POLICY_DECISION_MAX_TTL_MILLIS;
  return Layer.effect(
    ProviderPolicyDecisionPoint,
    Effect.gen(function*() {
      const snapshots = yield* ProviderPolicySnapshotStore;
      const api = yield* OpenFgaAuthorizationApi;
      const decisionReferences = yield* ProviderDecisionReferenceGenerator;
      const budgets = yield* ProviderBudgetEnforcer;
      return ProviderPolicyDecisionPoint.of({
        decide: Effect.fn("agentos.providerPolicy.decide")(function*(
          request: ProviderPolicyDecisionRequestV1,
        ) {
          if (!routeIsCanonical(request)) {
            return yield* decisionError("invalid_route", false);
          }
          const subject = yield* asBindingSubject(request);
          const snapshot = yield* snapshots.findBySubject(subject).pipe(
            Effect.mapError(mapSnapshotFailure),
          );
          const now = yield* Clock.currentTimeMillis;
          yield* validateSnapshot(snapshot, subject, now);
          const profilePermission = yield* activePermission(
            snapshot.profile.permissions,
            request,
            options.environment,
            now,
            "profile_denied",
          );
          const ceilingPermission = yield* activePermission(
            snapshot.ceiling.permissions,
            request,
            options.environment,
            now,
            "ceiling_denied",
          );
          if (
            profilePermission.rateClass === "disabled" ||
            ceilingPermission.rateClass === "disabled"
          ) {
            return yield* decisionError("rate_class_disabled", false);
          }
          if (
            RateClassRank[profilePermission.rateClass] >
              RateClassRank[ceilingPermission.rateClass]
          ) {
            return yield* decisionError("rate_class_exceeded", false);
          }
          yield* openFgaChecks({
            deployment: options.deployment,
            snapshot,
            subject,
            permission: profilePermission,
            now,
          }).pipe(Effect.provideService(OpenFgaAuthorizationApi, api));
          const opaqueId = yield* decisionReferences.next;
          const decisionRef = `decision_${opaqueId}`;
          const expiresAtMillis = minimumExpiry(
            now,
            maximumDecisionTtlMillis,
            snapshot.binding.expiresAtMillis,
            profilePermission.expiresAtMillis,
            ceilingPermission.expiresAtMillis,
          );
          const reservation = yield* budgets.reserve({
            schemaVersion: 1,
            decisionRef,
            correlationId: request.correlationId,
            bindingId: snapshot.binding.bindingId,
            subject,
            provider: request.provider,
            credentialDomain: request.credentialDomain,
            capability: request.capability,
            resource: request.resource,
            environment: options.environment,
            rateClass: profilePermission.rateClass,
            nowMillis: now,
          }).pipe(Effect.mapError(mapBudgetFailure));
          return yield* Schema.decodeUnknownEffect(
            ProviderPolicyDecisionRefV1Schema,
            { onExcessProperty: "error" },
          )({
            schemaVersion: 1,
            correlationId: request.correlationId,
            decisionRef,
            decision: "allow",
            credentialDomain: request.credentialDomain,
            expiresAtMillis: Math.min(
              expiresAtMillis,
              reservation.leaseExpiresAtMillis,
            ),
            profile: {
              profileId: snapshot.profile.profileId,
              profileVersion: snapshot.profile.profileVersion,
            },
            ceiling: {
              ceilingId: snapshot.ceiling.ceilingId,
              revision: snapshot.ceiling.revision,
            },
            rateClass: reservation.effectiveRateClass,
          }).pipe(
            Effect.mapError(() =>
              decisionError("decision_reference_unavailable", true)
            ),
          );
        }),
      });
    }),
  );
}
