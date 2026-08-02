#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Effect,
  FileSystem,
  Result,
  Schema,
  Stdio,
  Stream,
} from "effect";

const maximumTokenBytes = 16 * 1024;
const jwtLike = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export class CodexWorkloadTokenError extends Schema.TaggedErrorClass<CodexWorkloadTokenError>()(
  "CodexWorkloadTokenError",
  { message: Schema.String },
) {}

function tokenError(message: string) {
  return CodexWorkloadTokenError.make({ message });
}

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

export const readCodexWorkloadToken = Effect.fn(
  "agentos.codexToken.readProjected",
)(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const read = yield* fileSystem.stream(path, {
    bytesToRead: maximumTokenBytes + 1,
  }).pipe(Stream.runCollect, Effect.result);
  if (Result.isFailure(read)) {
    return yield* tokenError("projected workload token is unavailable");
  }
  const bytes = concatenate(read.success);
  if (bytes.length === 0 || bytes.length > maximumTokenBytes) {
    return yield* tokenError("projected workload token is invalid");
  }
  const decoded = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => tokenError("projected workload token is invalid"),
  });
  if (
    decoded.trim() !== decoded ||
    !jwtLike.test(decoded)
  ) {
    return yield* tokenError("projected workload token is invalid");
  }
  return decoded;
});

function write(output: "stderr" | "stdout", value: string) {
  return Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(value).pipe(
      Stream.run(output === "stdout" ? stdio.stdout() : stdio.stderr()),
    );
  });
}

export const codexTokenMain = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const path = args[0];
  if (path === undefined || !path.trim()) {
    const error = tokenError("projected workload token path is required");
    yield* write("stderr", `${error.message}\n`);
    return yield* error;
  }
  const result = yield* readCodexWorkloadToken(path).pipe(Effect.result);
  if (Result.isFailure(result)) {
    const error = tokenError("projected workload token is unavailable");
    yield* write("stderr", `${error.message}\n`);
    return yield* error;
  }
  yield* write("stdout", `${result.success}\n`);
});

if (import.meta.main) {
  BunRuntime.runMain(
    codexTokenMain.pipe(Effect.provide(BunServices.layer)),
    { disableErrorReporting: true },
  );
}
