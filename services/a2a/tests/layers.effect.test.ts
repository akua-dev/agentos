import { assert, describe, it } from "@effect/vitest";
import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  KubernetesBoundServiceAccountAuthenticator,
} from "@akua-dev/agentos";
import { Effect, FileSystem, Layer, Ref } from "effect";

import { A2aServiceReadiness } from "../src/app.ts";
import { makeA2aIdentityReadinessLayer } from "../src/layers.ts";

const Token = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDMzNjk2MDB9.signature";

describe("A2A service live dependency graph", () => {
  it.effect("proves its own projected ServiceAccount token through TokenReview", () =>
    Effect.gen(function*() {
      const requests = yield* Ref.make<ReadonlyArray<{
        readonly bearerToken: string;
        readonly audience: string;
      }>>([]);
      const dependencies = Layer.merge(
        FileSystem.layerNoop({
          readFileString: () => Effect.succeed(Token),
        }),
        Layer.succeed(KubernetesBoundServiceAccountAuthenticator, {
          authenticate: (request) =>
            Ref.update(requests, (all) => [...all, request]).pipe(
              Effect.as({
                schemaVersion: 1,
                tokenExpiresAtMillis: 4_103_366_400_000,
                kubernetesNamespace: "agentos",
                kubernetesPod: "agentos-a2a-0",
                podUid: "77777777-7777-4777-8777-777777777777",
                serviceAccountName: "agentos-a2a",
                serviceAccountUid: "88888888-8888-4888-8888-888888888888",
              }),
            ),
        }),
      );
      const readiness = makeA2aIdentityReadinessLayer({
        audience: AGENTOS_EGRESS_TOKEN_AUDIENCE,
        tokenFile: "/var/run/secrets/agentos-a2a/token",
        namespace: "agentos",
        serviceAccountName: "agentos-a2a",
      }).pipe(Layer.provide(dependencies));

      assert.strictEqual(
        yield* A2aServiceReadiness.pipe(
          Effect.flatMap((service) => service.check),
          Effect.provide(readiness),
        ),
        true,
      );
      assert.deepStrictEqual(yield* Ref.get(requests), [{
        bearerToken: Token,
        audience: AGENTOS_EGRESS_TOKEN_AUDIENCE,
      }]);
    }));

  it.effect("fails readiness closed when TokenReview resolves another identity", () =>
    Effect.gen(function*() {
      const dependencies = Layer.merge(
        FileSystem.layerNoop({
          readFileString: () => Effect.succeed(Token),
        }),
        Layer.succeed(KubernetesBoundServiceAccountAuthenticator, {
          authenticate: () => Effect.succeed({
            schemaVersion: 1,
            tokenExpiresAtMillis: 4_103_366_400_000,
            kubernetesNamespace: "other",
            kubernetesPod: "other-0",
            podUid: "77777777-7777-4777-8777-777777777777",
            serviceAccountName: "other",
            serviceAccountUid: "88888888-8888-4888-8888-888888888888",
          }),
        }),
      );
      const readiness = makeA2aIdentityReadinessLayer({
        audience: AGENTOS_EGRESS_TOKEN_AUDIENCE,
        tokenFile: "/var/run/secrets/agentos-a2a/token",
        namespace: "agentos",
        serviceAccountName: "agentos-a2a",
      }).pipe(Layer.provide(dependencies));
      assert.strictEqual(
        yield* A2aServiceReadiness.pipe(
          Effect.flatMap((service) => service.check),
          Effect.provide(readiness),
        ),
        false,
      );
    }));
});
