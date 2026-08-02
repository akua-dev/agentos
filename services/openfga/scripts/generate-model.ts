#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Path, Runtime, Schema, Stdio } from "effect";

import { AgentOSOpenFgaAuthorizationModelV1 } from "../../../packages/agentos/src/access/openfga.ts";

export class OpenFgaModelGenerationError extends Schema.TaggedErrorClass<OpenFgaModelGenerationError>()(
  "OpenFgaModelGenerationError",
  {
    code: Schema.Literals(["filesystem", "stale_model"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorExitCode] = 1;
}

const expected = `${JSON.stringify(
  AgentOSOpenFgaAuthorizationModelV1,
  null,
  2,
)}\n`;

export const generateOpenFgaModel = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const modelPath = yield* paths.fromFileUrl(
    new URL("../model/agentos-access-v1.json", import.meta.url),
  ).pipe(
    Effect.mapError((cause) =>
      new OpenFgaModelGenerationError({
        code: "filesystem",
        message: "Could not resolve the OpenFGA model artifact path",
        cause,
      })
    ),
  );
  if (args.includes("--check")) {
    const current = yield* fileSystem.readFileString(modelPath).pipe(
      Effect.mapError((cause) =>
        new OpenFgaModelGenerationError({
          code: "filesystem",
          message: "Could not read the OpenFGA model artifact",
          cause,
        })
      ),
    );
    if (current !== expected) {
      return yield* new OpenFgaModelGenerationError({
        code: "stale_model",
        message: "OpenFGA model artifact is stale; run bun run model:generate",
      });
    }
    return;
  }
  yield* fileSystem.writeFileString(modelPath, expected).pipe(
    Effect.mapError((cause) =>
      new OpenFgaModelGenerationError({
        code: "filesystem",
        message: "Could not write the OpenFGA model artifact",
        cause,
      })
    ),
  );
});

if (import.meta.main) {
  BunRuntime.runMain(
    generateOpenFgaModel.pipe(Effect.provide(BunServices.layer)),
    { disableErrorReporting: false },
  );
}
