import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import {
  AGENTOS_PROVIDER_CREDENTIAL_NAMESPACE,
  ProviderCredentialPlanError,
  ProviderCredentialRouteStateV1Schema,
  ProviderPolicyDecisionRequestV1Schema,
  ProviderRouteOutcomeV1Schema,
  compileProviderCredentialPlan,
  resolveProviderCredentialRouteState,
  type ProviderCredentialMechanismV1,
  type ProviderCredentialPlanInput,
  type ProviderCredentialRouteStateInput,
  type ProviderRouteOutcomeV1,
} from "../credential-delivery.ts";

const staticHeaderInput = {
  schemaVersion: 1,
  credentialDomain: "github-api",
  provider: "github",
  capability: "github.repository.read",
  resource: {
    kind: "provider_service",
    provider: "github",
    service: "rest",
  },
  upstreamHosts: ["api.github.com"],
  mechanism: {
    kind: "static_header",
    headerName: "authorization",
    prefix: "Bearer ",
    secretRef: {
      namespace: "agentos",
      name: "agentgateway-github-app-token",
      key: "token",
      resourceVersion: "18422",
    },
  },
} satisfies ProviderCredentialPlanInput;

describe("provider-isolated credential delivery", () => {
  it.effect("separates PEP, PDP, and credential delivery without a secret-bearing decision", () =>
    Effect.gen(function*() {
      const plan = yield* compileProviderCredentialPlan(staticHeaderInput);

      assert.deepStrictEqual(plan.policyEnforcement, {
        service: "agentos-egress-pep",
        authenticateWith: "pod_bound_service_account_token",
        onDeny: "do_not_forward",
      });
      assert.deepStrictEqual(plan.policyDecision, {
        service: "agentos-egress-authz",
        capability: "github.repository.read",
        resource: staticHeaderInput.resource,
        consistency: "strong",
        output: "bounded_decision_reference",
      });
      assert.strictEqual(plan.credentialDelivery.kind, "agentgateway_static_header");
      assert.strictEqual(plan.credentialDelivery.forwardOnly, true);

      const encoded = JSON.stringify(plan);
      assert.notInclude(encoded, "secretValue");
      assert.notInclude(encoded, "upstreamToken");
      assert.notInclude(encoded, "credentialPayload");
    }));

  it.effect("gives the PDP a closed canonical subject contract with no credential field", () =>
    Effect.gen(function*() {
      const decode = Schema.decodeUnknownEffect(
        ProviderPolicyDecisionRequestV1Schema,
        { onExcessProperty: "error" },
      );
      const request = {
        schemaVersion: 1,
        correlationId: "corr_11111111111111111111111111111111",
        credentialDomain: "github",
        provider: "github",
        capability: "github.repository.read",
        resource: staticHeaderInput.resource,
        subject: {
          kind: "mate",
          fleet: "agentos",
          domain: "platform",
          agentId: "11111111-1111-4111-8111-111111111111",
        },
      };
      const decoded = yield* decode(request);
      assert.strictEqual(decoded.subject.kind, "mate");

      const invalid = yield* Effect.exit(
        decode({ ...request, upstreamSecret: "do-not-accept" }),
      );
      assert(Exit.isFailure(invalid));
    }));

  it.effect("mounts one exact Secret only into its provider adapter", () =>
    Effect.gen(function*() {
      const plan = yield* compileProviderCredentialPlan(staticHeaderInput);
      assert.deepStrictEqual(plan.isolation, {
        adapterServiceAccount: "agentgateway-github-api",
        credentialDomain: "github-api",
        acceptedRouteHosts: ["api.github.com"],
        secretCount: 1,
        crossDomainCredentialAccess: "none",
      });
      const delivery = plan.credentialDelivery;
      if (delivery.kind !== "agentgateway_static_header") {
        return yield* Effect.fail("expected static-header delivery");
      }
      assert.deepStrictEqual(delivery.secretProjection, {
        secretRef: staticHeaderInput.mechanism.secretRef,
        mountPath:
          "/var/run/secrets/agentos-provider/github-api/credential",
        mode: 0o440,
        readOnly: true,
      });
      assert.strictEqual(
        delivery.secretProjection.secretRef.namespace,
        AGENTOS_PROVIDER_CREDENTIAL_NAMESPACE,
      );
      assert.notMatch(
        delivery.secretProjection.secretRef.namespace,
        /^agentos-domain-/,
      );
    }));

  it.effect("uses a provider-local rolling restart for deterministic static-secret rotation", () =>
    Effect.gen(function*() {
      const plan = yield* compileProviderCredentialPlan(staticHeaderInput);
      assert.deepStrictEqual(plan.rotation, {
        trigger: "secret_resource_version_change",
        reload: "rolling_restart_provider_adapter",
        replicas: 2,
        maxUnavailable: 0,
        agentRestart: false,
        maxStaleCredentialMillis: 60_000,
        terminateGracePeriodMillis: 30_000,
        rollback: "restore_previous_secret_revision_and_roll_adapter",
      });
    }));

  it.effect("selects native OAuth exchange only for an explicitly supported identity chain", () =>
    Effect.gen(function*() {
      const plan = yield* compileProviderCredentialPlan({
        ...staticHeaderInput,
        credentialDomain: "openai-oauth",
        mechanism: {
          kind: "oauth_token_exchange",
          upstreamSupportsTokenExchange: true,
          clientId: "agentos-openai",
          clientAuthentication: "client_secret_basic",
          tokenEndpoint: "https://identity.example.test/oauth2/token",
          subjectTokenAudience: "agentos-egress-authz",
          secretRef: {
            namespace: "agentos",
            name: "openai-oauth-client",
            key: "client-secret",
            resourceVersion: "9",
          },
        },
      });
      assert.strictEqual(
        plan.credentialDelivery.kind,
        "agentgateway_oauth_token_exchange",
      );
      if (plan.credentialDelivery.kind !== "agentgateway_oauth_token_exchange") {
        return yield* Effect.fail("expected OAuth token-exchange delivery");
      }
      assert.strictEqual(
        plan.credentialDelivery.clientSecretFile,
        "/var/run/secrets/agentos-provider/openai-oauth/credential",
      );
    }));

  it.effect("rejects an OAuth exchange that the upstream cannot honor", () =>
    Effect.gen(function*() {
      const failure = yield* compileProviderCredentialPlan({
        ...staticHeaderInput,
        mechanism: {
          kind: "oauth_token_exchange",
          upstreamSupportsTokenExchange: false,
          clientId: "agentos-openai",
          clientAuthentication: "client_secret_basic",
          tokenEndpoint: "https://identity.example.test/oauth2/token",
          subjectTokenAudience: "agentos-egress-authz",
          secretRef: {
            namespace: "agentos",
            name: "openai-oauth-client",
            key: "client-secret",
            resourceVersion: "9",
          },
        },
      }).pipe(Effect.flip);
      assert.strictEqual(failure.code, "unsupported_identity_chain");
    }));

  it.effect("uses cloud workload identity without mounting a Secret", () =>
    Effect.gen(function*() {
      const mechanisms: ReadonlyArray<ProviderCredentialMechanismV1> = [
        { kind: "aws_workload_identity", roleArn: "arn:aws:iam::123456789012:role/agentos-openai" },
        { kind: "gcp_workload_identity", audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/agentos/providers/kubernetes" },
      ];
      for (const mechanism of mechanisms) {
        const plan = yield* compileProviderCredentialPlan({
          ...staticHeaderInput,
          mechanism,
        });
        assert.strictEqual(plan.credentialDelivery.kind, mechanism.kind);
        assert.strictEqual(plan.isolation.secretCount, 0);
        assert.notProperty(plan.credentialDelivery, "secretProjection");
      }
    }));

  it.effect("routes GitHub App and refresh-token flows through one narrow broker", () =>
    Effect.gen(function*() {
      const mechanisms: ReadonlyArray<ProviderCredentialMechanismV1> = [
        {
          kind: "github_app",
          brokerService: "github-app-broker",
          secretRef: {
            namespace: "agentos",
            name: "github-app-platform",
            key: "private-key",
            resourceVersion: "44",
          },
        },
        {
          kind: "refresh_token",
          brokerService: "ai-gateway",
          secretRef: {
            namespace: "agentos",
            name: "ai-gateway-refresh-token",
            key: "refresh-token",
            resourceVersion: "73",
          },
        },
      ];
      for (const mechanism of mechanisms) {
        if (
          mechanism.kind !== "github_app" &&
          mechanism.kind !== "refresh_token"
        ) {
          return yield* Effect.fail("expected broker mechanism");
        }
        const plan = yield* compileProviderCredentialPlan({
          ...staticHeaderInput,
          mechanism,
        });
        assert.strictEqual(plan.credentialDelivery.kind, "provider_broker");
        if (plan.credentialDelivery.kind !== "provider_broker") {
          return yield* Effect.fail("expected provider-broker delivery");
        }
        assert.strictEqual(plan.credentialDelivery.forwardOnly, true);
        assert.strictEqual(
          plan.credentialDelivery.secretProjection.secretRef.name,
          mechanism.secretRef.name,
        );
        assert.strictEqual(plan.isolation.secretCount, 1);
      }
    }));

  it.effect("fails closed for unsupported native clients instead of handing out a token", () =>
    Effect.gen(function*() {
      const failure = yield* compileProviderCredentialPlan({
        ...staticHeaderInput,
        mechanism: {
          kind: "unsupported_native_client",
          client: "vendor-cli",
        },
      }).pipe(Effect.flip);
      assert.instanceOf(failure, ProviderCredentialPlanError);
      assert.strictEqual(failure._tag, "ProviderCredentialPlanError");
      assert.strictEqual(failure.code, "provider_broker_required");
      assert.strictEqual(failure.boundary, "credential_delivery");
    }));

  it.effect("rejects cross-provider resources and any Secret outside the core namespace", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<{
        readonly input: ProviderCredentialPlanInput;
        readonly code: string;
      }> = [
        {
          input: {
            ...staticHeaderInput,
            resource: {
              kind: "provider_service",
              provider: "openai",
              service: "api",
            },
          },
          code: "provider_resource_mismatch",
        },
        {
          input: {
            ...staticHeaderInput,
            mechanism: {
              ...staticHeaderInput.mechanism,
              secretRef: {
                ...staticHeaderInput.mechanism.secretRef,
                namespace: "agentos-domain-platform",
              },
            },
          },
          code: "secret_namespace_forbidden",
        },
      ];

      for (const testCase of cases) {
        const failure = yield* compileProviderCredentialPlan(
          testCase.input,
        ).pipe(Effect.flip);
        assert.strictEqual(failure.code, testCase.code);
      }
    }));

  it.effect("keeps provider failures bounded and credential-free", () =>
    Effect.gen(function*() {
      const decodeOutcome = Schema.decodeUnknownEffect(
        ProviderRouteOutcomeV1Schema,
        { onExcessProperty: "error" },
      );
      const outcomes: ReadonlyArray<ProviderRouteOutcomeV1["outcome"]> = [
        "credential_unavailable",
        "credential_rejected",
        "credential_rotating",
        "credential_exchange_failed",
      ];
      for (const code of outcomes) {
        const outcome = yield* decodeOutcome({
          schemaVersion: 1,
          provider: "openai",
          credentialDomain: "openai-responses",
          outcome: code,
          retryable: code !== "credential_rejected",
          correlationId: "corr_11111111111111111111111111111111",
        });
        assert.strictEqual(outcome.outcome, code);
      }

      const invalid = yield* Effect.exit(
        decodeOutcome({
          schemaVersion: 1,
          provider: "openai",
          credentialDomain: "openai-responses",
          outcome: "credential_unavailable",
          retryable: true,
          correlationId: "corr_11111111111111111111111111111111",
          upstreamPayload: "Bearer do-not-persist",
        }),
      );
      assert(Exit.isFailure(invalid));
    }));

  it.effect("expires only the stale provider route at the deterministic rotation deadline", () =>
    Effect.gen(function*() {
      const base: Omit<ProviderCredentialRouteStateInput, "status"> = {
        schemaVersion: 1,
        provider: "openai",
        credentialDomain: "openai",
        desiredResourceVersion: "20",
        rotationStartedAtMillis: 1_000,
        nowMillis: 60_999,
        correlationId: "corr_11111111111111111111111111111111",
      };
      const rotating = yield* resolveProviderCredentialRouteState({
        ...base,
        status: { kind: "loaded", resourceVersion: "19" },
      });
      assert.strictEqual(rotating.outcome, "credential_rotating");

      const expired = yield* resolveProviderCredentialRouteState({
        ...base,
        nowMillis: 61_000,
        status: { kind: "loaded", resourceVersion: "19" },
      });
      assert.strictEqual(expired.outcome, "credential_unavailable");

      const otherProvider = yield* resolveProviderCredentialRouteState({
        schemaVersion: 1,
        provider: "github",
        credentialDomain: "github",
        desiredResourceVersion: "8",
        rotationStartedAtMillis: null,
        nowMillis: 61_000,
        correlationId: "corr_22222222222222222222222222222222",
        status: { kind: "loaded", resourceVersion: "8" },
      });
      assert.strictEqual(otherProvider.outcome, "credential_ready");

      const decoded = yield* Schema.decodeUnknownEffect(
        ProviderCredentialRouteStateV1Schema,
        { onExcessProperty: "error" },
      )(expired);
      assert.strictEqual(decoded.credentialDomain, "openai");
    }));

  it.effect("maps missing, rejected, and exchange failures to bounded provider outcomes", () =>
    Effect.gen(function*() {
      const cases: ReadonlyArray<{
        readonly kind: "missing" | "rejected" | "exchange_failed";
        readonly outcome: ProviderRouteOutcomeV1["outcome"];
      }> = [
        { kind: "missing", outcome: "credential_unavailable" },
        { kind: "rejected", outcome: "credential_rejected" },
        { kind: "exchange_failed", outcome: "credential_exchange_failed" },
      ];
      for (const testCase of cases) {
        const state = yield* resolveProviderCredentialRouteState({
          schemaVersion: 1,
          provider: "openai",
          credentialDomain: "openai",
          desiredResourceVersion: "20",
          rotationStartedAtMillis: null,
          nowMillis: 1_000,
          correlationId: "corr_11111111111111111111111111111111",
          status: { kind: testCase.kind },
        });
        assert.strictEqual(state.outcome, testCase.outcome);
      }
    }));
});
