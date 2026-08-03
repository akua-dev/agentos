import { Effect, Schema } from "effect";

const Uuid = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  ),
);
const ReleaseDigest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
);
const Revision = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[0-9A-Za-z._:-]+$/),
  ),
);
const PositiveInteger = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
);
const WorkloadComponent = Schema.Literals([
  "agentgateway",
  "authorizer",
  "provider_adapter",
]);

const ProviderAccessWorkloadRevisionV1Schema = Schema.Struct({
  component: WorkloadComponent,
  desiredRevision: ReleaseDigest,
  observedRevision: Schema.NullOr(ReleaseDigest),
  ready: Schema.Boolean,
});

export const ProviderAccessRolloutInputV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  operationId: Uuid,
  action: Schema.Literals(["install", "upgrade", "rollback", "restore"]),
  provider: Schema.Literals(["github", "openai"]),
  credentialDomain: Schema.String.pipe(
    Schema.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(63),
      Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
    ),
  ),
  desiredReleaseDigest: ReleaseDigest,
  verifiedReleaseDigests: Schema.Array(ReleaseDigest).pipe(
    Schema.check(Schema.isMaxLength(8)),
  ),
  workloads: Schema.Array(ProviderAccessWorkloadRevisionV1Schema).pipe(
    Schema.check(Schema.isMinLength(3), Schema.isMaxLength(3)),
  ),
  policy: Schema.Struct({
    operationPhase: Schema.Literals([
      "prepared",
      "verified",
      "completed",
      "failed",
    ]),
    desiredProfileVersion: PositiveInteger,
    observedProfileVersion: Schema.NullOr(PositiveInteger),
    desiredCeilingRevision: PositiveInteger,
    observedCeilingRevision: Schema.NullOr(PositiveInteger),
  }),
  credential: Schema.Struct({
    desiredRevision: Revision,
    observedRevision: Schema.NullOr(Revision),
    outcome: Schema.Literals([
      "credential_ready",
      "credential_rotating",
      "credential_unavailable",
      "credential_rejected",
      "credential_exchange_failed",
    ]),
  }),
  budget: Schema.Struct({
    desiredRevision: PositiveInteger,
    observedRevision: Schema.NullOr(PositiveInteger),
    enforced: Schema.Boolean,
  }),
});

export type ProviderAccessRolloutInputV1 =
  typeof ProviderAccessRolloutInputV1Schema.Type;

export interface ProviderAccessRolloutVerdictV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly provider: "github" | "openai";
  readonly credentialDomain: string;
  readonly action: "install" | "upgrade" | "rollback" | "restore";
  readonly status: "pending" | "verified" | "rollback_required";
  readonly reason:
    | "ready"
    | "configuration_unapplied"
    | "policy_unapplied"
    | "credential_unapplied"
    | "budget_unapplied"
    | "authority_failed"
    | "rollback_target_unverified";
  readonly acknowledged: boolean;
  readonly servingReleaseDigest: string | null;
}

export class ProviderAccessRolloutDecodeError extends Schema.TaggedErrorClass<ProviderAccessRolloutDecodeError>()(
  "ProviderAccessRolloutDecodeError",
  { boundary: Schema.Literal("provider_access_rollout") },
) {}

export const compileProviderAccessRolloutVerdict = Effect.fn(
  "agentos.access.compileProviderAccessRolloutVerdict",
)(function*(untrusted: unknown) {
  const input = yield* Schema.decodeUnknownEffect(
    ProviderAccessRolloutInputV1Schema,
    { onExcessProperty: "error" },
  )(untrusted).pipe(
    Effect.mapError(() => ProviderAccessRolloutDecodeError.make({
      boundary: "provider_access_rollout",
    })),
  );
  const components = new Set(input.workloads.map(({ component }) => component));
  if (
    components.size !== WorkloadComponent.literals.length ||
    WorkloadComponent.literals.some((component) => !components.has(component)) ||
    new Set(input.verifiedReleaseDigests).size !==
      input.verifiedReleaseDigests.length
  ) {
    return yield* ProviderAccessRolloutDecodeError.make({
      boundary: "provider_access_rollout",
    });
  }

  const servingReleaseDigest = input.verifiedReleaseDigests[0] ?? null;
  if (
    (input.action === "rollback" || input.action === "restore") &&
    !input.verifiedReleaseDigests.includes(input.desiredReleaseDigest)
  ) {
    return verdict(
      input,
      "rollback_required",
      "rollback_target_unverified",
      false,
      servingReleaseDigest,
    );
  }
  if (
    input.policy.operationPhase === "failed" ||
    input.credential.outcome === "credential_rejected" ||
    input.credential.outcome === "credential_exchange_failed" ||
    input.credential.outcome === "credential_unavailable"
  ) {
    return verdict(
      input,
      "rollback_required",
      "authority_failed",
      false,
      servingReleaseDigest,
    );
  }
  if (
    input.workloads.some((workload) =>
      !workload.ready ||
      workload.desiredRevision !== input.desiredReleaseDigest ||
      workload.observedRevision !== workload.desiredRevision
    )
  ) {
    return verdict(
      input,
      "pending",
      "configuration_unapplied",
      false,
      servingReleaseDigest,
    );
  }
  if (
    input.policy.operationPhase !== "completed" ||
    input.policy.observedProfileVersion !==
      input.policy.desiredProfileVersion ||
    input.policy.observedCeilingRevision !==
      input.policy.desiredCeilingRevision
  ) {
    return verdict(
      input,
      "pending",
      "policy_unapplied",
      false,
      servingReleaseDigest,
    );
  }
  if (
    input.credential.outcome !== "credential_ready" ||
    input.credential.observedRevision !== input.credential.desiredRevision
  ) {
    return verdict(
      input,
      "pending",
      "credential_unapplied",
      false,
      servingReleaseDigest,
    );
  }
  if (
    !input.budget.enforced ||
    input.budget.observedRevision !== input.budget.desiredRevision
  ) {
    return verdict(
      input,
      "pending",
      "budget_unapplied",
      false,
      servingReleaseDigest,
    );
  }
  return verdict(
    input,
    "verified",
    "ready",
    true,
    input.desiredReleaseDigest,
  );
});

function verdict(
  input: ProviderAccessRolloutInputV1,
  status: ProviderAccessRolloutVerdictV1["status"],
  reason: ProviderAccessRolloutVerdictV1["reason"],
  acknowledged: boolean,
  servingReleaseDigest: string | null,
): ProviderAccessRolloutVerdictV1 {
  return {
    schemaVersion: 1,
    operationId: input.operationId,
    provider: input.provider,
    credentialDomain: input.credentialDomain,
    action: input.action,
    status,
    reason,
    acknowledged,
    servingReleaseDigest,
  };
}
