import { Effect, Schema } from "effect";

import {
  AccessRateClassIdSchema,
  type KubernetesWorkloadPrincipalV1,
  KubernetesWorkloadPrincipalV1Schema,
} from "./contracts.ts";

const KubernetesName = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);
const PositiveInt = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
);
const NonNegativeInt = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);
const EpochMillis = NonNegativeInt;
const ResourceVersion = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(128), Schema.isPattern(/^[0-9A-Za-z._:-]+$/)),
);
const HermesProfile = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(96),
    Schema.isPattern(/^[a-z][a-z0-9._-]*$/),
  ),
);
const ProviderModel = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
);

export const HermesProviderLimitsV1Schema = Schema.Struct({
  requestWindowMillis: PositiveInt,
  maximumRequests: NonNegativeInt,
  maximumConcurrent: NonNegativeInt,
  tokenWindowMillis: PositiveInt,
  maximumTokens: NonNegativeInt,
  spendWindowMillis: PositiveInt,
  maximumSpendMicros: NonNegativeInt,
});

export const HermesProviderRuleV1Schema = Schema.Struct({
  provider: Schema.Literal("openai"),
  credentialDomains: Schema.NonEmptyArray(KubernetesName),
  models: Schema.NonEmptyArray(ProviderModel),
  capabilities: Schema.NonEmptyArray(
    Schema.Literals(["responses.create", "responses.compact"]),
  ),
  rateClass: AccessRateClassIdSchema,
  limits: HermesProviderLimitsV1Schema,
});

export const HermesProviderAccessBindingDocumentV1Schema = Schema.Struct({
  namespace: KubernetesName,
  serviceAccountName: KubernetesName,
  hermesProfile: HermesProfile,
  providers: Schema.NonEmptyArray(HermesProviderRuleV1Schema),
  expiresAtMillis: Schema.NullOr(EpochMillis),
  disabled: Schema.Boolean,
});

export const HermesProviderAccessPolicyDocumentV1Schema = Schema.Struct({
  apiVersion: Schema.Literal("agentos.akua.dev/hermes-provider-access/v1"),
  revision: PositiveInt,
  bindings: Schema.Array(HermesProviderAccessBindingDocumentV1Schema),
});

export const HermesProviderAccessConfigMapV1Schema = Schema.Struct({
  apiVersion: Schema.Literal("v1"),
  kind: Schema.Literal("ConfigMap"),
  metadata: Schema.Struct({
    name: Schema.Literal("agentos-hermes-provider-access-v1"),
    namespace: Schema.Literal("agentos"),
    resourceVersion: ResourceVersion,
  }),
  data: Schema.Struct({
    "policy.json": Schema.fromJsonString(HermesProviderAccessPolicyDocumentV1Schema),
  }),
});

export class HermesProviderAccessPolicyError extends Schema.TaggedErrorClass<HermesProviderAccessPolicyError>()(
  "HermesProviderAccessPolicyError",
  {
    code: Schema.Literals([
      "binding_ambiguous",
      "binding_disabled",
      "binding_expired",
      "binding_not_found",
      "duplicate_binding",
      "invalid_config_map",
      "invalid_load_request",
      "invalid_provider_policy",
    ]),
  },
) {}

function hasDuplicates(values: ReadonlyArray<string>) {
  return new Set(values).size !== values.length;
}

function hasValidProviderLimits(rule: typeof HermesProviderRuleV1Schema.Type) {
  const maxima = [
    rule.limits.maximumRequests,
    rule.limits.maximumConcurrent,
    rule.limits.maximumTokens,
    rule.limits.maximumSpendMicros,
  ];
  return rule.rateClass === "disabled"
    ? maxima.every((value) => value === 0)
    : maxima.every((value) => value > 0);
}

export interface HermesProviderAccessBindingV1 {
  readonly principal: KubernetesWorkloadPrincipalV1;
  readonly providers: ReadonlyArray<typeof HermesProviderRuleV1Schema.Type>;
  readonly expiresAtMillis: number | null;
  readonly disabled: boolean;
}

export interface HermesProviderAccessPolicyV1 {
  readonly apiVersion: "agentos.akua.dev/hermes-provider-access/v1";
  readonly revision: number;
  readonly resourceVersion: string;
  readonly bindings: ReadonlyArray<HermesProviderAccessBindingV1>;
}

export type HermesProviderLimitsV1 = typeof HermesProviderLimitsV1Schema.Type;
export type HermesProviderRuleV1 = typeof HermesProviderRuleV1Schema.Type;
export type HermesProviderAccessBindingDocumentV1 =
  typeof HermesProviderAccessBindingDocumentV1Schema.Type;
export type HermesProviderAccessPolicyDocumentV1 =
  typeof HermesProviderAccessPolicyDocumentV1Schema.Type;

export const decodeHermesProviderAccessConfigMapV1 = Effect.fn(
  "agentos.access.decodeHermesProviderAccessConfigMapV1",
)(function*(input: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(
    HermesProviderAccessConfigMapV1Schema,
    { onExcessProperty: "error" },
  )(input).pipe(
    Effect.mapError(() =>
      HermesProviderAccessPolicyError.make({ code: "invalid_config_map" })
    ),
  );
  const policy = decoded.data["policy.json"];
  const principals = new Set<string>();
  for (const binding of policy.bindings) {
    const key = `${binding.namespace}/${binding.serviceAccountName}`;
    if (principals.has(key)) {
      return yield* HermesProviderAccessPolicyError.make({
        code: "duplicate_binding",
      });
    }
    principals.add(key);
    const providers = new Set<string>();
    for (const provider of binding.providers) {
      if (
        providers.has(provider.provider) ||
        hasDuplicates(provider.credentialDomains) ||
        hasDuplicates(provider.models) ||
        hasDuplicates(provider.capabilities) ||
        !hasValidProviderLimits(provider)
      ) {
        return yield* HermesProviderAccessPolicyError.make({
          code: "invalid_provider_policy",
        });
      }
      providers.add(provider.provider);
    }
  }
  return {
    apiVersion: policy.apiVersion,
    revision: policy.revision,
    resourceVersion: decoded.metadata.resourceVersion,
    bindings: policy.bindings.map((binding) => ({
      principal: {
        kind: "kubernetes_workload",
        namespace: binding.namespace,
        serviceAccountName: binding.serviceAccountName,
        policyRevision: policy.revision,
        hermesProfile: binding.hermesProfile,
      },
      providers: binding.providers,
      expiresAtMillis: binding.expiresAtMillis,
      disabled: binding.disabled,
    })),
  } satisfies HermesProviderAccessPolicyV1;
});

export const HermesProviderAccessLoadRequestV1Schema = Schema.Struct({
  namespace: KubernetesName,
  serviceAccountName: KubernetesName,
  atMillis: EpochMillis,
});
export type HermesProviderAccessLoadRequestV1 =
  typeof HermesProviderAccessLoadRequestV1Schema.Type;

export const loadHermesProviderAccessConfigMapV1 = Effect.fn(
  "agentos.access.loadHermesProviderAccessConfigMapV1",
)(function*(configMap: unknown, request: unknown) {
  const policy = yield* decodeHermesProviderAccessConfigMapV1(configMap);
  const target = yield* Schema.decodeUnknownEffect(
    HermesProviderAccessLoadRequestV1Schema,
    { onExcessProperty: "error" },
  )(request).pipe(
    Effect.mapError(() =>
      HermesProviderAccessPolicyError.make({ code: "invalid_load_request" })
    ),
  );
  const matches = policy.bindings.filter((binding) =>
    binding.principal.namespace === target.namespace &&
    binding.principal.serviceAccountName === target.serviceAccountName
  );
  if (matches.length === 0) {
    return yield* HermesProviderAccessPolicyError.make({
      code: "binding_not_found",
    });
  }
  if (matches.length !== 1) {
    return yield* HermesProviderAccessPolicyError.make({
      code: "binding_ambiguous",
    });
  }
  const binding = matches[0]!;
  if (binding.disabled) {
    return yield* HermesProviderAccessPolicyError.make({
      code: "binding_disabled",
    });
  }
  if (
    binding.expiresAtMillis !== null &&
    binding.expiresAtMillis <= target.atMillis
  ) {
    return yield* HermesProviderAccessPolicyError.make({
      code: "binding_expired",
    });
  }
  return binding;
});

export { KubernetesWorkloadPrincipalV1Schema };
