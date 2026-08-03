#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { ConfigProvider, Console, Effect, Layer, Schema } from "effect";

import {
  ResilienceHardGateRunnerError,
  agentOSResilienceHardGate,
} from "../src/resilience/hard-gate.ts";

const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

const program = agentOSResilienceHardGate.pipe(
  Effect.flatMap((result) =>
    Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result)
  ),
  Effect.flatMap(Console.log),
  Effect.tapError((error) => {
    const diagnostic = error instanceof ResilienceHardGateRunnerError
      ? {
        event: "agentos.resilience.hard_gate_failed",
        code: error.code,
        operation: error.operation,
        exitCode: error.exitCode,
        failures: error.failures,
      }
      : {
        event: "agentos.resilience.hard_gate_failed",
        code: "conformance_rejected",
      };
    return Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      diagnostic,
    ).pipe(Effect.flatMap(Console.error), Effect.ignore);
  }),
  Effect.provide(platform),
);

if (import.meta.main) {
  BunRuntime.runMain(program);
}
