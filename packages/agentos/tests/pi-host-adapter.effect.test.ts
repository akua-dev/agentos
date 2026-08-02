import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import {
  defineAgentOSPiCommandHandler,
  defineAgentOSPiExtension,
  runAgentOSPiProgram,
} from "../src/pi-host-adapter.ts";
import { makePiTestHarness } from "./pi-test-harness.ts";

describe("AgentOS Pi host adapter", () => {
  it.effect("runs an Effect command program only when Pi invokes it", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const invocations = yield* Ref.make<ReadonlyArray<string>>([]);
      fake.pi.registerCommand("effect-command", {
        description: "Exercise the Effect command boundary",
        handler: defineAgentOSPiCommandHandler((arguments_) =>
          Ref.update(invocations, (current) => [...current, arguments_])),
      });

      assert.deepStrictEqual(yield* Ref.get(invocations), []);
      yield* fake.executeCommand("effect-command", "status");
      assert.deepStrictEqual(yield* Ref.get(invocations), ["status"]);
    }));

  it.effect("runs extension and callback programs through one host boundary", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const invocations = yield* Ref.make<ReadonlyArray<string>>([]);
      const extension = defineAgentOSPiExtension((pi) =>
        Effect.sync(() => {
          pi.on("session_start", () =>
            runAgentOSPiProgram(
              Ref.update(invocations, (current) => [...current, "started"]),
            ));
        })
      );

      yield* Effect.promise(() => extension(fake.pi));
      assert.deepStrictEqual(yield* Ref.get(invocations), []);
      yield* fake.emit("session_start", { reason: "startup" });
      assert.deepStrictEqual(yield* Ref.get(invocations), ["started"]);
    }));
});
