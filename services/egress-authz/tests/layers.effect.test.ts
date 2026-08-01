import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import { EgressAuthorizerReadiness } from "../src/app.ts";
import { makeEgressAuthorizerReadinessLayer } from "../src/layers.ts";

describe("egress authorizer live dependency graph", () => {
  it.effect("requires both PostgreSQL and the pinned OpenFGA model to be ready", () =>
    Effect.gen(function*() {
      const checks = yield* Ref.make<ReadonlyArray<string>>([]);
      const layer = makeEgressAuthorizerReadinessLayer({
        postgresql: Ref.update(checks, (current) => [
          ...current,
          "postgresql",
        ]).pipe(Effect.as(true)),
        openFga: Ref.update(checks, (current) => [
          ...current,
          "openfga",
        ]).pipe(Effect.as(false)),
      });
      const ready = yield* EgressAuthorizerReadiness.pipe(
        Effect.flatMap((service) => service.check),
        Effect.provide(layer),
      );
      assert.strictEqual(ready, false);
      assert.deepStrictEqual(
        [...(yield* Ref.get(checks))].sort(),
        ["openfga", "postgresql"],
      );
    }));

  it.effect("propagates dependency failures for the HTTP boundary to redact", () =>
    Effect.gen(function*() {
      const dependencyFailure = { _tag: "SyntheticDependencyFailure" };
      const layer = makeEgressAuthorizerReadinessLayer({
        postgresql: Effect.succeed(true),
        openFga: Effect.fail(dependencyFailure),
      });
      const failure = yield* EgressAuthorizerReadiness.pipe(
        Effect.flatMap((service) => service.check),
        Effect.provide(layer),
        Effect.flip,
      );
      assert.strictEqual(failure, dependencyFailure);
    }));
});
