import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import { Config, ConfigProvider, Effect, Layer } from "effect";

const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

layer(platform)("resilience hard-gate execution sentinel", (it) => {
  it.effect("requires explicit hard-gate mode", () =>
    Effect.gen(function*() {
      assert.strictEqual(
        yield* Config.boolean("AGENTOS_RESILIENCE_HARD_GATE"),
        true,
      );
    }));
});
