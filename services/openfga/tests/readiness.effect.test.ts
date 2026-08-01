import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import {
  AGENTOS_OPENFGA_HEALTH_OBJECT,
  AGENTOS_OPENFGA_HEALTH_RELATION,
  AGENTOS_OPENFGA_HEALTH_USER,
  OpenFgaAuthorizationApi,
  type OpenFgaApiCheckRequest,
} from "../../../packages/agentos/src/access/openfga.ts";
import { evaluateOpenFgaSemanticReadiness } from "../src/readiness.ts";

const deployment = {
  storeId: "01K1J6T8NS7B4K5AT9E1YH8D5R",
  authorizationModelId: "01K1J6V6Z3S94FWX6H3M1TDME4",
};

describe("OpenFGA semantic readiness", () => {
  it.effect("requires native database health before authorization", () =>
    Effect.gen(function*() {
      const checks = yield* Ref.make(0);
      const api = Layer.succeed(OpenFgaAuthorizationApi)({
        mutateTuples: () => Effect.void,
        check: () => Ref.update(checks, (count) => count + 1).pipe(Effect.as(true)),
      });
      const authorizationApi = yield* OpenFgaAuthorizationApi.pipe(
        Effect.provide(api),
      );
      const ready = yield* evaluateOpenFgaSemanticReadiness({
        nativeHealth: Effect.succeed(false),
        deployment: Effect.succeed(deployment),
        authorizationApi,
      });
      assert.isFalse(ready);
      assert.strictEqual(yield* Ref.get(checks), 0);
    }));

  it.effect("pins the deployed model in a higher-consistency canonical check", () =>
    Effect.gen(function*() {
      const requests = yield* Ref.make<ReadonlyArray<OpenFgaApiCheckRequest>>([]);
      const api = Layer.succeed(OpenFgaAuthorizationApi)({
        mutateTuples: () => Effect.void,
        check: (request) =>
          Ref.update(requests, (values) => [...values, request]).pipe(
            Effect.as(true),
          ),
      });
      const authorizationApi = yield* OpenFgaAuthorizationApi.pipe(
        Effect.provide(api),
      );
      const ready = yield* evaluateOpenFgaSemanticReadiness({
        nativeHealth: Effect.succeed(true),
        deployment: Effect.succeed(deployment),
        authorizationApi,
      });
      assert.isTrue(ready);
      assert.deepStrictEqual(yield* Ref.get(requests), [{
        ...deployment,
        user: AGENTOS_OPENFGA_HEALTH_USER,
        relation: AGENTOS_OPENFGA_HEALTH_RELATION,
        object: AGENTOS_OPENFGA_HEALTH_OBJECT,
        context: {},
        consistency: "HIGHER_CONSISTENCY",
      }]);
    }));
});
