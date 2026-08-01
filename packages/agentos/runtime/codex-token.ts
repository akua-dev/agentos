#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";

const maximumTokenBytes = 16 * 1024;
const jwtLike = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export class CodexWorkloadTokenError extends Schema.TaggedErrorClass<CodexWorkloadTokenError>()(
  "CodexWorkloadTokenError",
  { message: Schema.String },
) {}

export const readCodexWorkloadToken = Effect.fn(
  "agentos.codexToken.readProjected",
)(function*(path: string) {
  const contents = yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: () =>
      CodexWorkloadTokenError.make({
        message: "projected workload token is unavailable",
      }),
  });
  if (
    contents.length === 0 ||
    contents.length > maximumTokenBytes ||
    contents.trim() !== contents ||
    !jwtLike.test(contents)
  ) {
    return yield* CodexWorkloadTokenError.make({
      message: "projected workload token is invalid",
    });
  }
  return contents;
});

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("projected workload token path is required\n");
    process.exitCode = 1;
  } else {
    try {
      const token = await Effect.runPromise(readCodexWorkloadToken(path));
      process.stdout.write(`${token}\n`);
    } catch {
      process.stderr.write("projected workload token is unavailable\n");
      process.exitCode = 1;
    }
  }
}
