import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Ref,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  KubernetesTokenReviewer,
  KubernetesWorkloadIdentityLookup,
  WorkloadIdentityDependencyUnavailable,
} from "../identity.ts";
import {
  makeKubernetesApiHttpClientLayer,
  makeKubernetesWorkloadIdentityHttpLayer,
  type KubernetesWorkloadIdentityHttpOptions,
} from "../kubernetes-identity-http.ts";

const Namespace = "agentos-domain-platform";
const PodName = "agentos-platform-mate-0";
const PodUid = "44444444-4444-4444-8444-444444444444";
const ServiceAccountName = "agentos-platform-mate";
const ServiceAccountUid = "55555555-5555-4555-8555-555555555555";
const SubjectToken = "subject.workload.token";
const ClientTokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";

const options = {
  baseUrl: "https://kubernetes.default.svc",
  serviceAccountTokenPath: ClientTokenPath,
  timeoutMillis: 1_000,
  maximumResponseBytes: 1_024,
} satisfies KubernetesWorkloadIdentityHttpOptions;

function httpClientLayer(
  execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      execute(request).pipe(
        Effect.map((response) =>
          HttpClientResponse.fromWeb(request, response)
        ),
      )
    ),
  );
}

function tokenFileLayer(tokens: Ref.Ref<ReadonlyArray<string>>) {
  return FileSystem.layerNoop({
    readFileString: (path) =>
      path === ClientTokenPath
        ? Ref.modify(tokens, (values) => [
          values[0] ?? "",
          values.length > 1 ? values.slice(1) : values,
        ])
        : Effect.succeed(""),
  });
}

function provideAdapters<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  execute: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<Response>,
  tokens: Ref.Ref<ReadonlyArray<string>>,
) {
  return effect.pipe(
    Effect.provide(makeKubernetesWorkloadIdentityHttpLayer(options)),
    Effect.provide(Layer.merge(
      httpClientLayer(execute),
      tokenFileLayer(tokens),
    )),
  );
}

function decodeRequestBody(request: HttpClientRequest.HttpClientRequest) {
  if (request.body._tag !== "Uint8Array") return Effect.succeed(null);
  return Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Unknown),
  )(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie);
}

function tokenReviewResponse(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    apiVersion: "authentication.k8s.io/v1",
    kind: "TokenReview",
    status: {
      authenticated: true,
      audiences: [AGENTOS_EGRESS_TOKEN_AUDIENCE],
      user: {
        username:
          `system:serviceaccount:${Namespace}:${ServiceAccountName}`,
        uid: ServiceAccountUid,
        extra: {
          "authentication.kubernetes.io/pod-name": [PodName],
          "authentication.kubernetes.io/pod-uid": [PodUid],
        },
      },
      ...overrides,
    },
  };
}

function review() {
  return Effect.gen(function*() {
    const reviewer = yield* KubernetesTokenReviewer;
    return yield* reviewer.review({
      token: SubjectToken,
      audiences: [AGENTOS_EGRESS_TOKEN_AUDIENCE],
    });
  });
}

describe("Effect-native Kubernetes workload identity HTTP", () => {
  it.effect("rereads the client token and sends the exact TokenReview contract", () =>
    Effect.gen(function*() {
      const tokens = yield* Ref.make<ReadonlyArray<string>>([
        "client-token-one",
        "client-token-two",
      ]);
      const requests = yield* Ref.make<ReadonlyArray<{
        readonly method: string;
        readonly url: string;
        readonly authorization: string | null;
        readonly body: unknown;
      }>>([]);
      const execute = (request: HttpClientRequest.HttpClientRequest) =>
        Effect.gen(function*() {
          const body = yield* decodeRequestBody(request);
          yield* Ref.update(requests, (values) => [...values, {
            method: request.method,
            url: request.url,
            authorization: request.headers.authorization ?? null,
            body,
          }]);
          return new Response(JSON.stringify(tokenReviewResponse()), {
            status: 201,
          });
        });

      const reviewed = yield* provideAdapters(review(), execute, tokens);
      yield* provideAdapters(review(), execute, tokens);

      assert.deepStrictEqual(reviewed, {
        authenticated: true,
        audiences: [AGENTOS_EGRESS_TOKEN_AUDIENCE],
        username:
          `system:serviceaccount:${Namespace}:${ServiceAccountName}`,
        serviceAccountUid: ServiceAccountUid,
        podNames: [PodName],
        podUids: [PodUid],
      });
      const captured = yield* Ref.get(requests);
      assert.deepStrictEqual(
        captured.map(({ authorization }) => authorization),
        ["Bearer client-token-one", "Bearer client-token-two"],
      );
      assert.deepNestedInclude(captured[0], {
        method: "POST",
        url:
          "https://kubernetes.default.svc/apis/authentication.k8s.io/v1/tokenreviews",
        body: {
          apiVersion: "authentication.k8s.io/v1",
          kind: "TokenReview",
          spec: {
            token: SubjectToken,
            audiences: [AGENTOS_EGRESS_TOKEN_AUDIENCE],
          },
        },
      });
    }));

  it.effect("normalizes live Pod and ServiceAccount objects and treats only 404 as absence", () =>
    Effect.gen(function*() {
      const tokens = yield* Ref.make<ReadonlyArray<string>>(["client-token"]);
      const requests = yield* Ref.make<ReadonlyArray<string>>([]);
      const execute = (request: HttpClientRequest.HttpClientRequest) =>
        Ref.update(requests, (values) => [...values, request.url]).pipe(
          Effect.as(request.url.endsWith(`/pods/${PodName}`)
            ? new Response(JSON.stringify({
              apiVersion: "v1",
              kind: "Pod",
              metadata: {
                namespace: Namespace,
                name: PodName,
                uid: PodUid,
              },
              spec: { serviceAccountName: ServiceAccountName },
              status: { phase: "Running" },
            }), { status: 200 })
            : new Response(JSON.stringify({
              apiVersion: "v1",
              kind: "ServiceAccount",
              metadata: {
                namespace: Namespace,
                name: ServiceAccountName,
                uid: ServiceAccountUid,
                deletionTimestamp: "2026-08-01T12:00:00.000Z",
              },
            }), { status: 200 })),
        );
      const program = Effect.gen(function*() {
        const lookup = yield* KubernetesWorkloadIdentityLookup;
        const pod = yield* lookup.getPod({ namespace: Namespace, name: PodName });
        const serviceAccount = yield* lookup.getServiceAccount({
          namespace: Namespace,
          name: ServiceAccountName,
        });
        return { pod, serviceAccount };
      });

      const result = yield* provideAdapters(program, execute, tokens);
      assert.deepStrictEqual(result, {
        pod: {
          namespace: Namespace,
          name: PodName,
          uid: PodUid,
          serviceAccountName: ServiceAccountName,
          phase: "Running",
          deletionTimestampMillis: null,
        },
        serviceAccount: {
          namespace: Namespace,
          name: ServiceAccountName,
          uid: ServiceAccountUid,
          deletionTimestampMillis: 1_785_585_600_000,
        },
      });
      assert.deepStrictEqual(yield* Ref.get(requests), [
        `https://kubernetes.default.svc/api/v1/namespaces/${Namespace}/pods/${PodName}`,
        `https://kubernetes.default.svc/api/v1/namespaces/${Namespace}/serviceaccounts/${ServiceAccountName}`,
      ]);

      const missing = yield* provideAdapters(
        Effect.gen(function*() {
          const lookup = yield* KubernetesWorkloadIdentityLookup;
          return yield* lookup.getPod({ namespace: Namespace, name: PodName });
        }),
        () => Effect.succeed(new Response("not found", { status: 404 })),
        tokens,
      );
      assert.isNull(missing);
    }));

  it.effect("keeps status, malformed, oversized, and credential failures typed and secret-free", () =>
    Effect.gen(function*() {
      const clientSecret = "client-super-secret";
      const tokens = yield* Ref.make<ReadonlyArray<string>>([clientSecret]);
      const cases: ReadonlyArray<{
        readonly response: Response;
        readonly code: string;
        readonly status: number | null;
      }> = [
        ...[401, 403, 404, 409, 429, 503].map((status) => ({
          response: new Response(JSON.stringify({
            apiVersion: "v1",
            kind: "Status",
            status: "Failure",
            reason: "Forbidden",
            code: status,
          }), { status }),
          code: "unexpected_status",
          status,
        })),
        {
          response: new Response("not-json", { status: 200 }),
          code: "invalid_response",
          status: 200,
        },
        {
          response: new Response("oversized", {
            status: 200,
            headers: { "content-length": "4096" },
          }),
          code: "response_too_large",
          status: 200,
        },
        {
          response: new Response("x".repeat(options.maximumResponseBytes + 1), {
            status: 200,
          }),
          code: "response_too_large",
          status: 200,
        },
      ];

      yield* Effect.forEach(cases, ({ response, code, status }) =>
        provideAdapters(review(), () => Effect.succeed(response), tokens)
          .pipe(
            Effect.flip,
            Effect.map((error) => {
              assert.instanceOf(error, WorkloadIdentityDependencyUnavailable);
              assert.strictEqual(error.code, code);
              assert.strictEqual(error.status, status);
              const rendered = JSON.stringify(error);
              assert.notInclude(rendered, clientSecret);
              assert.notInclude(rendered, SubjectToken);
              assert.notInclude(rendered, "Forbidden");
            }),
          )
      );

      const missingToken = yield* Ref.make<ReadonlyArray<string>>([""]);
      const credentialError = yield* provideAdapters(
        review(),
        () => Effect.succeed(new Response("unused")),
        missingToken,
      ).pipe(Effect.flip);
      assert.instanceOf(
        credentialError,
        WorkloadIdentityDependencyUnavailable,
      );
      assert.strictEqual(credentialError.code, "credential_unavailable");
      assert.strictEqual(credentialError.status, null);
    }));

  it.effect("requires the mounted CA before constructing the Kubernetes HTTP client", () =>
    Effect.gen(function*() {
      const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
      const obtainClient = Effect.gen(function*() {
        yield* HttpClient.HttpClient;
        return true;
      });
      const missing = yield* obtainClient.pipe(
        Effect.provide(makeKubernetesApiHttpClientLayer({
          serviceAccountCaPath: caPath,
        })),
        Effect.provide(FileSystem.layerNoop({
          readFileString: () => Effect.succeed(""),
        })),
        Effect.flip,
      );
      assert.instanceOf(missing, WorkloadIdentityDependencyUnavailable);
      assert.strictEqual(missing.operation, "configure_client");
      assert.strictEqual(missing.code, "trust_unavailable");

      assert.isTrue(yield* obtainClient.pipe(
        Effect.provide(makeKubernetesApiHttpClientLayer({
          serviceAccountCaPath: caPath,
        })),
        Effect.provide(FileSystem.layerNoop({
          readFileString: (path) =>
            Effect.succeed(
              path === caPath ? "-----BEGIN CERTIFICATE-----\nfixture\n" : "",
            ),
        })),
      ));
    }));

  it.effect("rejects insecure configuration and malformed live objects before identity", () =>
    Effect.gen(function*() {
      const tokens = yield* Ref.make<ReadonlyArray<string>>(["client-token"]);
      const calls = yield* Ref.make(0);
      const invalidLayer = makeKubernetesWorkloadIdentityHttpLayer({
        ...options,
        baseUrl: "http://kubernetes.default.svc/unsafe-path",
      });
      const invalidConfiguration = yield* review().pipe(
        Effect.provide(invalidLayer),
        Effect.provide(Layer.merge(
          httpClientLayer(() =>
            Ref.update(calls, (value) => value + 1).pipe(
              Effect.as(new Response("unused")),
            )
          ),
          tokenFileLayer(tokens),
        )),
        Effect.flip,
      );
      assert.instanceOf(
        invalidConfiguration,
        WorkloadIdentityDependencyUnavailable,
      );
      assert.strictEqual(invalidConfiguration.code, "invalid_configuration");
      assert.strictEqual(invalidConfiguration.operation, "configure_client");
      assert.strictEqual(yield* Ref.get(calls), 0);

      const malformedPod = yield* provideAdapters(
        Effect.gen(function*() {
          const lookup = yield* KubernetesWorkloadIdentityLookup;
          return yield* lookup.getPod({ namespace: Namespace, name: PodName });
        }),
        () => Effect.succeed(new Response(JSON.stringify({
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            namespace: Namespace,
            name: PodName,
            uid: PodUid,
            deletionTimestamp: "not-a-timestamp",
          },
          spec: { serviceAccountName: ServiceAccountName },
          status: { phase: "Running" },
        }), { status: 200 })),
        tokens,
      ).pipe(Effect.flip);
      assert.instanceOf(malformedPod, WorkloadIdentityDependencyUnavailable);
      assert.strictEqual(malformedPod.operation, "get_pod");
      assert.strictEqual(malformedPod.code, "invalid_response");
      assert.strictEqual(malformedPod.status, 200);
    }));

  it.effect("times out and remains interruptible without caching a failed review", () =>
    Effect.gen(function*() {
      const tokens = yield* Ref.make<ReadonlyArray<string>>(["client-token"]);
      const calls = yield* Ref.make(0);
      const execute = () =>
        Ref.update(calls, (value) => value + 1).pipe(
          Effect.andThen(Effect.never),
        );
      const timed = yield* Effect.forkChild(
        provideAdapters(review(), execute, tokens),
      );
      yield* TestClock.adjust(options.timeoutMillis + 1);
      const timeout = yield* Fiber.join(timed).pipe(Effect.flip);
      assert.instanceOf(timeout, WorkloadIdentityDependencyUnavailable);
      assert.strictEqual(timeout.code, "timeout");

      const interrupted = yield* Effect.forkChild(
        provideAdapters(review(), execute, tokens),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(interrupted);
      assert.strictEqual(yield* Ref.get(calls), 2);
    }));
});
