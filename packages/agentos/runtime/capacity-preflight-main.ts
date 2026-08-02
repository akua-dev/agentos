import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Effect,
  Schema,
  Stdio,
  Stream,
} from "effect";
import {
  CapacityPreflightResult,
  classifyCrewmateCapacity,
} from "./capacity-preflight";

export class CapacityPreflightProgramError extends Schema.TaggedErrorClass<CapacityPreflightProgramError>()(
  "CapacityPreflightProgramError",
  {
    message: Schema.String,
  },
) {}

function programError(message: string) {
  return CapacityPreflightProgramError.make({ message });
}

export const classifyCrewmateCapacityJson = Effect.fn(
  "agentos.capacityPreflight.classifyJson",
)(function*(source: string) {
  const input = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Unknown),
  )(source).pipe(
    Effect.mapError(() =>
      programError("Capacity preflight stdin must be valid JSON")
    ),
  );
  return yield* classifyCrewmateCapacity(input);
});

const readStandardInput = Effect.fn("agentos.capacityPreflight.readStdin")(
  function*() {
    const stdio = yield* Stdio.Stdio;
    return yield* stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.mkString,
      Effect.mapError(() =>
        programError("Could not read capacity preflight stdin")
      ),
    );
  },
);

function writeStandardOutput(
  output: "stderr" | "stdout",
  value: string,
) {
  return Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio;
    const sink = output === "stdout" ? stdio.stdout() : stdio.stderr();
    yield* Stream.make(value).pipe(
      Stream.run(sink),
      Effect.mapError(() =>
        programError(`Could not write capacity preflight ${output}`)
      ),
    );
  });
}

export const capacityPreflightMain = Effect.gen(function*() {
  const source = yield* readStandardInput();
  const result = yield* classifyCrewmateCapacityJson(source);
  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(CapacityPreflightResult),
  )(result).pipe(
    Effect.mapError(() =>
      programError("Could not encode capacity preflight result")
    ),
  );
  yield* writeStandardOutput("stdout", `${encoded}\n`);
}).pipe(
  Effect.catch((error) =>
    writeStandardOutput("stderr", `${error.message}\n`).pipe(
      Effect.andThen(Effect.fail(error)),
    )
  ),
);

if (import.meta.main) {
  BunRuntime.runMain(
    capacityPreflightMain.pipe(Effect.provide(BunServices.layer)),
    { disableErrorReporting: true },
  );
}
