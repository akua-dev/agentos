#!/usr/bin/env bun

import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import {
  ConfigProvider,
  Console,
  Effect,
  Layer,
  Schema,
} from "effect";

import { liveModelConformance } from "./live-model-conformance.ts";

const ConformanceResult = Schema.Struct({ assertions: Schema.Number });
class LiveModelEntrypointError extends Schema.TaggedErrorClass<LiveModelEntrypointError>()(
  "LiveModelEntrypointError",
  { operation: Schema.Literal("live_model_conformance") },
) {}

const platform = Layer.merge(
  BunHttpClient.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);
const main = liveModelConformance.pipe(
  Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(ConformanceResult))),
  Effect.flatMap(Console.log),
  Effect.catchCause(() =>
    Console.error('{"error":"LiveModelConformanceFailed"}').pipe(
      Effect.andThen(LiveModelEntrypointError.make({
        operation: "live_model_conformance",
      })),
    )),
  Effect.provide(platform),
);

BunRuntime.runMain(main);
