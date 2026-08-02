#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Schema, Stdio, Stream } from "effect";

import {
  BenchmarkRunnerError,
  parseRunPlan,
  runAttempt,
} from "./runner.ts";

const JsonFromString = Schema.fromJsonString(Schema.Unknown);

export const runBenchmark = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const planPath = args[0];
  const runDirectory = args[1];
  if (planPath === undefined || runDirectory === undefined) {
    return yield* new BenchmarkRunnerError({
      code: "invalid_plan",
      message: "usage: bun benchmarks/run.ts <run-plan.json> <new-run-directory>",
    });
  }
  const value = yield* fileSystem.readFileString(planPath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(JsonFromString)),
    Effect.mapError((cause) =>
      new BenchmarkRunnerError({
        code: "invalid_plan",
        message: `could not decode run plan: ${planPath}`,
        cause,
      })
    ),
  );
  const plan = yield* parseRunPlan(value);
  const evidence = yield* runAttempt(plan, runDirectory);
  yield* Stream.make(
    `valid evidence: ${runDirectory}/evidence.json (${String(evidence.run_id)})\n`,
  ).pipe(
    Stream.run(stdio.stdout()),
    Effect.mapError((cause) =>
      new BenchmarkRunnerError({
        code: "filesystem",
        message: "could not write benchmark run result",
        cause,
      })
    ),
  );
});

const reportFailure = (error: BenchmarkRunnerError) =>
  Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(`${error.message}\n`).pipe(
      Stream.run(stdio.stderr()),
      Effect.ignore,
    );
  });

if (import.meta.main) {
  BunRuntime.runMain(
    runBenchmark.pipe(
      Effect.tapError(reportFailure),
      Effect.provide(BunServices.layer),
    ),
    { disableErrorReporting: true },
  );
}
