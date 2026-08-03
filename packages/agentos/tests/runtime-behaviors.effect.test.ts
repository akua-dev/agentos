import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { defaultAgentOSRuntime } from "../src/behaviors.ts";
import {
  preflightAgentOSRegistrationsEffect,
  registerAgentOSRuntimeEffect,
} from "../src/preflight.ts";
import { makePiTestHarness } from "./pi-test-harness.ts";

describe("released AgentOS Pi registrations", () => {
  it.effect("exports every released behavior as a replaceable registration", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(defaultAgentOSRuntime.map(({ id }) => id), [
        "@akua-dev/agentos:workload-identity",
        "@akua-dev/agentos:observability",
        "@akua-dev/agentos:background-tasks",
        "@akua-dev/agentos:mate-memory",
        "@akua-dev/agentos:openai-server-compaction",
        "@akua-dev/agentos:supervision-guard",
      ]);
      yield* preflightAgentOSRegistrationsEffect(defaultAgentOSRuntime);
    }));

  it.effect("declares and registers the released tool and command surface", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      yield* registerAgentOSRuntimeEffect(fake.pi, defaultAgentOSRuntime);

      assert.deepStrictEqual([...fake.extension.tools.keys()], [
        "run_background_command",
        "get_background_command_output",
        "list_background_commands",
        "kill_background_command",
        "attest_coordination_listener",
        "confirm_coordination_catchup",
        "set_mate_memory_state",
        "memory_delete_topic",
      ]);
      assert.deepStrictEqual([...fake.extension.commands.keys()], [
        "background-commands",
        "memory",
      ]);
    }));

  it.effect("lets a distribution replace one behavior without copying the rest", () =>
    Effect.gen(function*() {
      const withoutCompaction = defaultAgentOSRuntime.filter(
        ({ id }) => id !== "@akua-dev/agentos:openai-server-compaction",
      );
      assert.lengthOf(withoutCompaction, 5);
      yield* preflightAgentOSRegistrationsEffect(withoutCompaction);
    }));
});
