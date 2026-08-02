#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Config,
  ConfigProvider,
  Crypto,
  Effect,
  Encoding,
  FileSystem,
  Option,
  Path,
  Result,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import {
  evaluateSemanticHealth,
  type HealthCommandResult,
  type HealthEnvironment,
  type HealthFileMetadata,
  type SemanticHealthRuntime,
  SemanticHealthDiagnostic,
} from "./readiness";

const healthEnvironmentKeys: ReadonlyArray<string> = [
  "AGENTOS_AGENT_CWD",
  "AGENTOS_AGENT_ID",
  "AGENTOS_AGENT_NAME",
  "AGENTOS_AGENT_ROLE",
  "AGENTOS_ASSIGNMENT_ID",
  "AGENTOS_BRIEF_PATH",
  "AGENTOS_BRIEF_SHA256",
  "AGENTOS_CODEX_PROVIDER_MODE",
  "AGENTOS_DATABASE_IDENTITY",
  "AGENTOS_DATABASE_URL",
  "AGENTOS_EGRESS_TOKEN_FILE",
  "AGENTOS_HARNESS",
  "AGENTOS_MODEL",
  "AGENTOS_PI_PROVIDER_MODE",
  "AGENTOS_PROVIDER_CREDENTIAL_KIND",
  "AGENTOS_RELEASE_ROOT",
  "AGENTOS_TASK_ID",
  "AGENTOS_THINKING",
  "AI_GATEWAY_URL",
  "CODEX_HOME",
  "DATABASE_URL",
  "HERDR_SESSION",
  "HOME",
  "PGPASSFILE",
  "PI_CODING_AGENT_DIR",
];

class HealthUsageError extends Schema.TaggedErrorClass<HealthUsageError>()(
  "HealthUsageError",
  { message: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = 2;
}

class HealthUnhealthyError extends Schema.TaggedErrorClass<HealthUnhealthyError>()(
  "HealthUnhealthyError",
  { message: Schema.String },
) {}

function concatenate(chunks: Iterable<Uint8Array>): Uint8Array {
  const values = Array.from(chunks);
  const length = values.reduce((total, value) => total + value.length, 0);
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    combined.set(value, offset);
    offset += value.length;
  }
  return combined;
}

function decodeUtf8(bytes: Uint8Array) {
  return Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => undefined,
  }).pipe(
    Effect.match({
      onFailure: () => undefined,
      onSuccess: (value) => value,
    }),
  );
}

const readBoundedBytes = Effect.fn("agentos.health.readBoundedBytes")(
  function*(path: string, maximumBytes: number) {
    const fileSystem = yield* FileSystem.FileSystem;
    const result = yield* fileSystem.stream(path, {
      bytesToRead: maximumBytes + 1,
    }).pipe(Stream.runCollect, Effect.result);
    return Result.isSuccess(result)
      ? concatenate(result.success)
      : undefined;
  },
);

const runHealthCommand = Effect.fn("agentos.health.runCommand")(
  function*(args: ReadonlyArray<string>) {
    const command = args[0];
    if (command === undefined) return { exitCode: 1, stdout: "" };
    const result = yield* Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* ChildProcess.make(command, args.slice(1), {
          extendEnv: true,
          stderr: "ignore",
          stdout: "pipe",
        });
        const [exitCode, stdout] = yield* Effect.all([
          handle.exitCode.pipe(Effect.map(Number)),
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        ], { concurrency: "unbounded" });
        return { exitCode, stdout } satisfies HealthCommandResult;
      }),
    ).pipe(Effect.result);
    return Result.isSuccess(result)
      ? result.success
      : { exitCode: 1, stdout: "" };
  },
);

export const makeSemanticHealthRuntime = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const paths = yield* Path.Path;
  const runtime: SemanticHealthRuntime = {
    basename: paths.basename,
    join: paths.join,
    parseToml: (source) =>
      Effect.try({
        try: () => Bun.TOML.parse(source),
        catch: () => undefined,
      }).pipe(
        Effect.match({
          onFailure: () => undefined,
          onSuccess: (value) => value,
        }),
      ),
    run: (args) =>
      runHealthCommand(args).pipe(
        Effect.provideService(ChildProcessSpawner, childProcessSpawner),
      ),
    sha256: (source) =>
      crypto.digest("SHA-256", new TextEncoder().encode(source)).pipe(
        Effect.map(Encoding.encodeHex),
        Effect.orElseSucceed(() => ""),
      ),
    readText: (path, maximumBytes) =>
      Effect.gen(function*() {
        const bytes = yield* readBoundedBytes(path, maximumBytes).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
        if (bytes === undefined || bytes.length > maximumBytes) {
          return undefined;
        }
        return yield* decodeUtf8(bytes);
      }),
    readFirstLine: (path, maximumBytes) =>
      Effect.gen(function*() {
        const bytes = yield* readBoundedBytes(path, maximumBytes).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
        if (bytes === undefined || bytes.length === 0) return undefined;
        const newline = bytes.indexOf(0x0a);
        if (newline < 0 && bytes.length > maximumBytes) return undefined;
        return yield* decodeUtf8(
          newline < 0 ? bytes : bytes.subarray(0, newline),
        );
      }),
    metadata: (path) =>
      fileSystem.stat(path).pipe(
        Effect.result,
        Effect.map((result): HealthFileMetadata | undefined =>
          Result.isSuccess(result)
            ? {
                isFile: result.success.type === "File",
                mode: result.success.mode,
                size: Number(result.success.size),
              }
            : undefined
        ),
      ),
    processExists: (processId) =>
      Effect.sync(() => {
        if (!Number.isSafeInteger(processId) || processId <= 0) return false;
        try {
          process.kill(processId, 0);
          return true;
        } catch (cause) {
          return (
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "EPERM"
          );
        }
      }),
  };
  return runtime;
});

const healthEnvironment = Effect.gen(function*() {
  const values = yield* Config.all(
    healthEnvironmentKeys.map((key) =>
      Config.string(key).pipe(Config.option)
    ),
  );
  const environment: Record<string, string | undefined> = {};
  for (let index = 0; index < healthEnvironmentKeys.length; index += 1) {
    const key = healthEnvironmentKeys[index];
    const value = values[index];
    if (key !== undefined && value !== undefined) {
      environment[key] = Option.getOrUndefined(value);
    }
  }
  return environment satisfies HealthEnvironment;
});

function write(output: "stderr" | "stdout", value: string) {
  return Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(value).pipe(
      Stream.run(output === "stdout" ? stdio.stdout() : stdio.stderr()),
    );
  });
}

export const semanticHealthMain = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const mode = args[0];
  if (mode !== "live" && mode !== "ready") {
    const message = "Usage: health.ts <live|ready>\n";
    yield* write("stderr", message);
    return yield* HealthUsageError.make({ message });
  }
  const [environment, runtime] = yield* Effect.all([
    healthEnvironment,
    makeSemanticHealthRuntime,
  ]);
  const diagnostic = yield* evaluateSemanticHealth(environment, mode, runtime);
  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(SemanticHealthDiagnostic),
  )(diagnostic);
  yield* write("stdout", `${encoded}\n`);
  if (diagnostic.status === "not_live" || diagnostic.status === "not_ready") {
    return yield* HealthUnhealthyError.make({ message: diagnostic.status });
  }
});

if (import.meta.main) {
  BunRuntime.runMain(
    semanticHealthMain.pipe(
      Effect.provide(BunServices.layer),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv()),
      ),
    ),
    { disableErrorReporting: true },
  );
}
