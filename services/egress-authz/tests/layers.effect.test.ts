import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { EgressAuthorizerReadiness } from "../src/app.ts";
import { makeEgressAuthorizerReadinessLayer } from "../src/layers.ts";

describe("egress authorizer live dependency graph", () => {
  it.effect("requires the modern PostgreSQL budget boundary to be ready", () =>
    Effect.gen(function*() {
      const layer = makeEgressAuthorizerReadinessLayer({
        postgresql: Effect.succeed(true),
      });
      const ready = yield* EgressAuthorizerReadiness.pipe(
        Effect.flatMap((service) => service.check),
        Effect.provide(layer),
      );
      assert.strictEqual(ready, true);
    }));

  it.effect("propagates dependency failures for the HTTP boundary to redact", () =>
    Effect.gen(function*() {
      const dependencyFailure = { _tag: "SyntheticDependencyFailure" };
      const layer = makeEgressAuthorizerReadinessLayer({
        postgresql: Effect.fail(dependencyFailure),
      });
      const failure = yield* EgressAuthorizerReadiness.pipe(
        Effect.flatMap((service) => service.check),
        Effect.provide(layer),
        Effect.flip,
      );
      assert.strictEqual(failure, dependencyFailure);
    }));
});
