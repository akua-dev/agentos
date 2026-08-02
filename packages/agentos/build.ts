#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Path, Runtime, Schema } from "effect";
import { ChildProcess } from "effect/unstable/process";

export class AgentOSBuildError extends Schema.TaggedErrorClass<AgentOSBuildError>()(
  "AgentOSBuildError",
  {
    operation: Schema.Literals(["resolve_root", "clean", "compile"]),
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorExitCode] = this.exitCode ?? 1;
}

export interface AgentOSBuildOptions {
  readonly outputDirectory?: string;
}

const buildAgentOSProgram = Effect.fn("agentos.build")(function*(
  options: AgentOSBuildOptions = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const packageRoot = yield* paths.fromFileUrl(
    new URL(".", import.meta.url),
  ).pipe(
    Effect.mapError((cause) =>
      new AgentOSBuildError({ operation: "resolve_root", cause })
    ),
  );
  const outputDirectory = options.outputDirectory ?? paths.join(packageRoot, "dist");
  yield* fileSystem.remove(outputDirectory, {
    recursive: true,
    force: true,
  }).pipe(
    Effect.mapError((cause) =>
      new AgentOSBuildError({ operation: "clean", cause })
    ),
  );
  const compilerArguments = [
    "--project",
    paths.join(packageRoot, "tsconfig.build.json"),
    ...(options.outputDirectory === undefined
      ? []
      : ["--outDir", outputDirectory]),
  ];
  const compiler = yield* ChildProcess.make("tsc", compilerArguments, {
    cwd: packageRoot,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  }).pipe(
    Effect.mapError((cause) =>
      new AgentOSBuildError({ operation: "compile", cause })
    ),
  );
  const exitCode = Number(yield* compiler.exitCode);
  if (exitCode !== 0) {
    return yield* new AgentOSBuildError({
      operation: "compile",
      exitCode,
    });
  }
});

export const buildAgentOS = (options: AgentOSBuildOptions = {}) =>
  buildAgentOSProgram(options).pipe(Effect.scoped);

if (import.meta.main) {
  BunRuntime.runMain(buildAgentOS().pipe(Effect.provide(BunServices.layer)));
}
