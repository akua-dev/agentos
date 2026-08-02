#!/usr/bin/env bun

import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Console, Effect, Layer, Schema } from "effect";

import {
  postgresUpgradeConformance,
  UpgradeConformanceResult,
} from "./postgres-upgrade-conformance.ts";

class UpgradeConformanceEntrypointError extends Schema.TaggedErrorClass<UpgradeConformanceEntrypointError>()(
  "UpgradeConformanceEntrypointError",
  { operation: Schema.Literal("postgres_upgrade_conformance") },
) {}

const main = postgresUpgradeConformance.pipe(
  Effect.flatMap(Schema.encodeEffect(
    Schema.fromJsonString(UpgradeConformanceResult),
  )),
  Effect.flatMap(Console.log),
  Effect.catchCause(() =>
    Console.error('{"error":"UpgradeConformanceFailed"}').pipe(
      Effect.andThen(UpgradeConformanceEntrypointError.make({
        operation: "postgres_upgrade_conformance",
      })),
    )),
  Effect.provide(Layer.merge(BunServices.layer, BunHttpClient.layer)),
);

BunRuntime.runMain(main);
