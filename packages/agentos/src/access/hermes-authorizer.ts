import { Context, Effect, Layer, Schema } from "effect";

import type { ProviderAuthorizationRouteV1 } from "./http-authorizer.ts";
import {
  decodeHermesProviderAccessConfigMapV1,
  HermesProviderAccessPolicyError,
  loadHermesProviderAccessConfigMapV1,
  matchHermesProviderAccessConfigMapV1,
  type HermesProviderAccessGrantV1,
} from "./kubernetes-workload-policy.ts";
import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  KubernetesBoundServiceAccountAuthenticator,
  type WorkloadAuthenticationError,
  type WorkloadIdentityDependencyUnavailable,
} from "./identity.ts";

const ResponsesRequestModelSchema = Schema.fromJsonString(Schema.Struct({
  model: Schema.String,
}));

export class HermesProviderAccessPolicyDependencyUnavailable extends Schema.TaggedErrorClass<HermesProviderAccessPolicyDependencyUnavailable>()(
  "HermesProviderAccessPolicyDependencyUnavailable",
  { operation: Schema.Literal("get_policy") },
) {}

export class HermesProviderAccessPolicySource extends Context.Service<
  HermesProviderAccessPolicySource,
  {
    readonly current: Effect.Effect<
      unknown,
      HermesProviderAccessPolicyDependencyUnavailable
    >;
  }
>()("agentos/access/HermesProviderAccessPolicySource") {}

export interface HermesProviderAuthorizationRequest {
  readonly bearerToken: string;
  readonly route: ProviderAuthorizationRouteV1;
  readonly body: string | undefined;
  readonly atMillis: number;
}

export interface HermesProviderAuthorizationResult {
  readonly kind: "authorized";
  readonly tokenExpiresAtMillis: number;
  readonly policyExpiresAtMillis: number | null;
  readonly grant: HermesProviderAccessGrantV1;
  readonly workloadIdentity?: {
    readonly serviceAccountUid: string;
    readonly podName: string;
    readonly podUid: string;
  };
}

export interface HermesProviderAuthorization {
  readonly authorize: (
    request: HermesProviderAuthorizationRequest,
  ) => Effect.Effect<
    HermesProviderAuthorizationResult,
    | WorkloadAuthenticationError
    | WorkloadIdentityDependencyUnavailable
    | HermesProviderAccessPolicyDependencyUnavailable
    | HermesProviderAccessPolicyError
  >;
}

export const createHermesProviderAuthorization = Effect.fn(
  "agentos.access.createHermesProviderAuthorization",
)(function*() {
  const boundServiceAccounts = yield* KubernetesBoundServiceAccountAuthenticator;
  const policies = yield* HermesProviderAccessPolicySource;

  return {
    authorize: Effect.fn("agentos.access.authorizeHermesProvider")(function*(
      request: HermesProviderAuthorizationRequest,
    ) {
      const bound = yield* boundServiceAccounts.authenticate({
        bearerToken: request.bearerToken,
        audience: AGENTOS_EGRESS_TOKEN_AUDIENCE,
      });
      const configMap = yield* policies.current;
      const policy = yield* decodeHermesProviderAccessConfigMapV1(configMap);
      const exactBinding = policy.bindings.some((binding) =>
        binding.principal.namespace === bound.kubernetesNamespace &&
        binding.principal.serviceAccountName === bound.serviceAccountName
      );
      if (!exactBinding) {
        return yield* HermesProviderAccessPolicyError.make({
          code: "binding_not_found",
        });
      }
      const bindingResult = yield* Effect.result(
        loadHermesProviderAccessConfigMapV1(configMap, {
          namespace: bound.kubernetesNamespace,
          serviceAccountName: bound.serviceAccountName,
          atMillis: request.atMillis,
        }),
      );
      if (bindingResult._tag === "Failure") {
        return yield* bindingResult.failure;
      }
      if (request.route.provider !== "openai" || request.body === undefined) {
        return yield* HermesProviderAccessPolicyError.make({
          code: "access_denied",
        });
      }
      const payload = yield* Schema.decodeUnknownEffect(
        ResponsesRequestModelSchema,
        { onExcessProperty: "ignore" },
      )(request.body).pipe(
        Effect.mapError(() =>
          HermesProviderAccessPolicyError.make({
            code: "invalid_access_request",
          })
        ),
      );
      const capability = request.route.capability === "openai.responses.create"
        ? "responses.create"
        : request.route.capability === "openai.responses.compact"
        ? "responses.compact"
        : null;
      if (capability === null) {
        return yield* HermesProviderAccessPolicyError.make({
          code: "access_denied",
        });
      }
      const principal = bindingResult.success.principal;
      const grant = yield* matchHermesProviderAccessConfigMapV1(configMap, {
        namespace: bound.kubernetesNamespace,
        serviceAccountName: bound.serviceAccountName,
        policyRevision: principal.policyRevision,
        policyResourceVersion: principal.policyResourceVersion,
        provider: request.route.provider,
        credentialDomain: request.route.credentialDomain,
        model: payload.model,
        capability,
        atMillis: request.atMillis,
      });
      const authorized: HermesProviderAuthorizationResult = {
        kind: "authorized",
        tokenExpiresAtMillis: bound.tokenExpiresAtMillis,
        policyExpiresAtMillis: bindingResult.success.expiresAtMillis,
        grant,
        workloadIdentity: {
          serviceAccountUid: bound.serviceAccountUid,
          podName: bound.kubernetesPod,
          podUid: bound.podUid,
        },
      };
      return authorized;
    }),
  } satisfies HermesProviderAuthorization;
});

export class HermesProviderAuthorizer extends Context.Service<
  HermesProviderAuthorizer,
  HermesProviderAuthorization
>()("agentos/access/HermesProviderAuthorizer") {
  static readonly layer = Layer.effect(
    HermesProviderAuthorizer,
    createHermesProviderAuthorization().pipe(
      Effect.map(HermesProviderAuthorizer.of),
    ),
  );
}
