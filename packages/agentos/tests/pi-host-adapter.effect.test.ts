import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import { defineAgentOSPiCommandHandler } from "../src/pi-host-adapter.ts";
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
});
