import { Effect, Schema } from "effect";
import { classifyCrewmateCapacity } from "./capacity-preflight";

export class CapacityPreflightProgramError extends Schema.TaggedErrorClass<CapacityPreflightProgramError>()(
  "CapacityPreflightProgramError",
  {
    message: Schema.String,
  },
) {}

function programError(message: string) {
  return CapacityPreflightProgramError.make({ message });
}

function parseUnknownJson(source: string): unknown {
  return JSON.parse(source);
}

export const classifyCrewmateCapacityJson = Effect.fn(
  "agentos.capacityPreflight.classifyJson",
)(function*(source: string) {
  const input = yield* Effect.try({
    try: () => parseUnknownJson(source),
    catch: () => programError("Capacity preflight stdin must be valid JSON"),
  });
  return yield* classifyCrewmateCapacity(input);
});

const readStandardInput = Effect.fn("agentos.capacityPreflight.readStdin")(
  function*() {
    return yield* Effect.tryPromise({
      try: () => Bun.stdin.text(),
      catch: () => programError("Could not read capacity preflight stdin"),
    });
  },
);

if (import.meta.main) {
  const program = Effect.gen(function*() {
    const source = yield* readStandardInput();
    return yield* classifyCrewmateCapacityJson(source);
  });
  process.exitCode = await Effect.runPromise(
    Effect.matchEffect(program, {
      onFailure: (error) =>
        Effect.sync(() => {
          process.stderr.write(`${error.message}\n`);
          return 1;
        }),
      onSuccess: (result) =>
        Effect.sync(() => {
          process.stdout.write(`${JSON.stringify(result)}\n`);
          return 0;
        }),
    }),
  );
}
