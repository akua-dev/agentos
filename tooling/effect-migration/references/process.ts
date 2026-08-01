import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"

export const runReadOnlyCommand = Effect.fn("Command.runReadOnly")(function*(
  command: string,
  args: ReadonlyArray<string>
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* ChildProcess.make(command, args)
    const [stdout, exitCode] = yield* Effect.all([
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode
    ], { concurrency: "unbounded" })
    return { stdout, exitCode }
  }))
})
