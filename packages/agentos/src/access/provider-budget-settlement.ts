import { Context, Effect, Layer, Schema } from "effect";

import { AccessProviderIdSchema } from "./contracts.ts";
import {
  KubernetesBoundServiceAccountAuthenticator,
  WorkloadAuthenticationError,
} from "./identity.ts";

const KubernetesName = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);
const KubernetesUid = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[0-9A-Za-z](?:[0-9A-Za-z_.:-]*[0-9A-Za-z])?$/),
  ),
);
const CredentialDomain = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);

export const AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_AUDIENCE =
  "agentos-provider-budget-settlement";
export const AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_MOUNT_PATH =
  "/var/run/secrets/agentos-budget-settlement";
export const AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_PATH =
  `${AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_MOUNT_PATH}/token`;
export const AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_EXPIRATION_SECONDS = 600;

export const ProviderBudgetSettlementCallerDefinitionV1Schema = Schema.Struct({
  provider: AccessProviderIdSchema,
  credentialDomain: CredentialDomain,
  kubernetesNamespace: KubernetesName,
  serviceAccountName: KubernetesName,
});

export const ProviderBudgetSettlementCallerV1Schema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  provider: AccessProviderIdSchema,
  credentialDomain: CredentialDomain,
  kubernetesNamespace: KubernetesName,
  kubernetesPod: KubernetesName,
  podUid: KubernetesUid,
  serviceAccountName: KubernetesName,
  serviceAccountUid: KubernetesUid,
});

export type ProviderBudgetSettlementCallerDefinitionV1 =
  typeof ProviderBudgetSettlementCallerDefinitionV1Schema.Type;
export type ProviderBudgetSettlementCallerV1 =
  typeof ProviderBudgetSettlementCallerV1Schema.Type;

export const providerBudgetSettlementCallersV1: readonly [
  ProviderBudgetSettlementCallerDefinitionV1,
  ProviderBudgetSettlementCallerDefinitionV1,
] = Object.freeze([
  Object.freeze({
    provider: "github",
    credentialDomain: "github",
    kubernetesNamespace: "agentos",
    serviceAccountName: "github-broker",
  }),
  Object.freeze({
    provider: "openai",
    credentialDomain: "openai-responses",
    kubernetesNamespace: "agentos",
    serviceAccountName: "ai-gateway",
  }),
]);

export class ProviderBudgetSettlementCallerAuthenticationError extends Schema.TaggedErrorClass<ProviderBudgetSettlementCallerAuthenticationError>()(
  "ProviderBudgetSettlementCallerAuthenticationError",
  {
    outcome: Schema.Literals([
      "unauthorized",
      "forbidden",
      "dependency_unavailable",
    ]),
  },
) {}

export class ProviderBudgetSettlementCallerAuthenticator extends Context.Service<
  ProviderBudgetSettlementCallerAuthenticator,
  {
    readonly authenticate: (
      bearerToken: string,
    ) => Effect.Effect<
      ProviderBudgetSettlementCallerV1,
      ProviderBudgetSettlementCallerAuthenticationError
    >;
  }
>()("agentos/access/ProviderBudgetSettlementCallerAuthenticator") {
  static readonly layer = Layer.effect(
    ProviderBudgetSettlementCallerAuthenticator,
    Effect.gen(function*() {
      const boundServiceAccounts =
        yield* KubernetesBoundServiceAccountAuthenticator;
      return ProviderBudgetSettlementCallerAuthenticator.of({
        authenticate: Effect.fn(
          "ProviderBudgetSettlementCallerAuthenticator.authenticate",
        )(function*(bearerToken) {
          const identity = yield* boundServiceAccounts.authenticate({
            bearerToken,
            audience: AGENTOS_PROVIDER_BUDGET_SETTLEMENT_TOKEN_AUDIENCE,
          }).pipe(
            Effect.mapError((error) =>
              ProviderBudgetSettlementCallerAuthenticationError.make({
                outcome: error instanceof WorkloadAuthenticationError
                  ? "unauthorized"
                  : "dependency_unavailable",
              })
            ),
          );
          const definition = providerBudgetSettlementCallersV1.find(
            (candidate) =>
              candidate.kubernetesNamespace ===
                identity.kubernetesNamespace &&
              candidate.serviceAccountName === identity.serviceAccountName,
          );
          if (definition === undefined) {
            return yield* ProviderBudgetSettlementCallerAuthenticationError.make({
              outcome: "forbidden",
            });
          }
          yield* Effect.annotateCurrentSpan({
            "agentos.provider": definition.provider,
            "agentos.credential_domain": definition.credentialDomain,
            "agentos.namespace": identity.kubernetesNamespace,
          });
          return {
            schemaVersion: 1,
            provider: definition.provider,
            credentialDomain: definition.credentialDomain,
            kubernetesNamespace: identity.kubernetesNamespace,
            kubernetesPod: identity.kubernetesPod,
            podUid: identity.podUid,
            serviceAccountName: identity.serviceAccountName,
            serviceAccountUid: identity.serviceAccountUid,
          } satisfies ProviderBudgetSettlementCallerV1;
        }),
      });
    }),
  );
}
