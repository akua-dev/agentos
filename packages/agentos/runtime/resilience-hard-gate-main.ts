#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { ConfigProvider, Console, Effect, Layer, Schema } from "effect";

import { agentOSResilienceHardGate } from "../src/resilience/hard-gate.ts";

const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

const program = agentOSResilienceHardGate.pipe(
  Effect.flatMap((result) =>
    Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result)
  ),
  Effect.flatMap(Console.log),
  Effect.provide(platform),
);

if (import.meta.main) {
  BunRuntime.runMain(program);
}
