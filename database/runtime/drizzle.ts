#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { ConfigProvider, Effect, Layer, Runtime, Schema, Stdio } from "effect";
import { ChildProcess } from "effect/unstable/process";

import {
  PgPassReaderLive,
} from "./database-credentials.ts";
import { loadDrizzleConfig } from "./drizzle-config.ts";

export class DrizzleProcessError extends Schema.TaggedErrorClass<DrizzleProcessError>()(
  "DrizzleProcessError",
  { exitCode: Schema.Number },
) {
  override readonly [Runtime.errorExitCode] = this.exitCode;
}

export const runDrizzle = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const config = yield* loadDrizzleConfig;
  const handle = yield* ChildProcess.make("drizzle-kit", args, {
    env: {
      DATABASE_URL: config.dbCredentials?.url,
    },
    extendEnv: true,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = Number(yield* handle.exitCode);
  if (exitCode !== 0) {
    return yield* new DrizzleProcessError({ exitCode });
  }
}).pipe(Effect.scoped);

if (import.meta.main) {
  const pgPass = PgPassReaderLive.pipe(Layer.provide(BunServices.layer));
  const live = Layer.mergeAll(
    BunServices.layer,
    pgPass,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
  );
  BunRuntime.runMain(runDrizzle.pipe(Effect.provide(live)));
}
