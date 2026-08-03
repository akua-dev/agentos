import { Effect, Schema, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

export class TestProcessError extends Schema.TaggedErrorClass<TestProcessError>()(
  "TestProcessError",
  {
    executable: Schema.String,
    detail: Schema.String,
  },
) {}

export interface TestProcessOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export const runTestProcess = Effect.fn("test.process.run")(function*(
  executable: string,
  args: ReadonlyArray<string>,
  options: TestProcessOptions = {},
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(executable, Array.from(args), {
      cwd: options.cwd,
      env: options.env,
      extendEnv: options.env === undefined,
      stderr: "pipe",
      stdin: options.stdin === undefined
        ? "ignore"
        : Stream.make(new TextEncoder().encode(options.stdin)),
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  })).pipe(
    Effect.mapError(() => TestProcessError.make({
      executable,
      detail: "test process failed; child output is intentionally redacted",
    })),
  );
});
