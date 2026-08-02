#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { CrewmateReadinessState } from "@akua-dev/agentos";
import {
  Config,
  ConfigProvider,
  Effect,
  Option,
  Path,
  Result,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect";

import {
  confirmCrewmateReadiness,
  CrewmateConfirmationError,
} from "./crewmate-readiness";
import { makeSemanticHealthRuntime } from "./health";

const confirmationEnvironmentKeys: ReadonlyArray<string> = [
  "AGENTOS_AGENT_CWD",
  "AGENTOS_AGENT_ID",
  "AGENTOS_AGENT_NAME",
  "AGENTOS_AGENT_ROLE",
  "AGENTOS_ASSIGNMENT_ID",
  "AGENTOS_BRIEF_PATH",
  "AGENTOS_BRIEF_SHA256",
  "AGENTOS_HARNESS",
  "AGENTOS_TASK_ID",
  "HERDR_SESSION",
];

const ConfirmationOutput = Schema.Struct({
  state: CrewmateReadinessState,
  status: Schema.Literal("confirmed"),
  version: Schema.Literal(1),
});
const ConfirmationFailure = Schema.Struct({
  reason: Schema.String,
  status: Schema.Literal("failed"),
  version: Schema.Literal(1),
});

class ReadinessStateUsageError extends Schema.TaggedErrorClass<ReadinessStateUsageError>()(
  "ReadinessStateUsageError",
  { message: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = 2;
}

class ReadinessStateConfirmationError extends Schema.TaggedErrorClass<ReadinessStateConfirmationError>()(
  "ReadinessStateConfirmationError",
  { message: Schema.String },
) {}

const confirmationEnvironment = Effect.gen(function*() {
  const values = yield* Config.all(
    confirmationEnvironmentKeys.map((key) =>
      Config.string(key).pipe(Config.option)
    ),
  );
  const environment: Record<string, string | undefined> = {};
  for (let index = 0; index < confirmationEnvironmentKeys.length; index += 1) {
    const key = confirmationEnvironmentKeys[index];
    const value = values[index];
    if (key !== undefined && value !== undefined) {
      environment[key] = Option.getOrUndefined(value);
    }
  }
  return environment;
});

function write(output: "stderr" | "stdout", value: string) {
  return Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(value).pipe(
      Stream.run(output === "stdout" ? stdio.stdout() : stdio.stderr()),
    );
  });
}

function encode<S extends Schema.Constraint>(schema: S, value: S["Type"]) {
  return Schema.encodeEffect(Schema.fromJsonString(schema))(value);
}

const failConfirmation = Effect.fn("agentos.readinessStateMain.fail")(
  function*(reason: string) {
    const source = yield* encode(ConfirmationFailure, {
      reason,
      status: "failed",
      version: 1,
    });
    yield* write("stderr", `${source}\n`);
    return yield* ReadinessStateConfirmationError.make({ message: reason });
  },
);

export const readinessStateMain = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  if (args[0] !== "confirm-crewmate") {
    const message = "Usage: readiness-state-main.ts confirm-crewmate\n";
    yield* write("stderr", message);
    return yield* ReadinessStateUsageError.make({ message });
  }
  const home = Option.getOrUndefined(yield* Config.option(Config.string("HOME")))
    ?.trim();
  if (!home) return yield* failConfirmation("runtime_configuration_invalid");

  const paths = yield* Path.Path;
  const [environment, runtime] = yield* Effect.all([
    confirmationEnvironment,
    makeSemanticHealthRuntime,
  ]);
  const confirmation = yield* confirmCrewmateReadiness(
    environment,
    runtime,
    paths.join(home, ".local", "state", "agentos"),
  ).pipe(Effect.result);
  if (Result.isFailure(confirmation)) {
    const reason = confirmation.failure instanceof CrewmateConfirmationError
      ? confirmation.failure.reason
      : "confirmation_internal_error";
    return yield* failConfirmation(reason);
  }
  const source = yield* encode(ConfirmationOutput, {
    status: "confirmed",
    state: confirmation.success,
    version: 1,
  });
  yield* write("stdout", `${source}\n`);
});

if (import.meta.main) {
  BunRuntime.runMain(
    readinessStateMain.pipe(
      Effect.provide(BunServices.layer),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromEnv()),
      ),
    ),
    { disableErrorReporting: true },
  );
}
