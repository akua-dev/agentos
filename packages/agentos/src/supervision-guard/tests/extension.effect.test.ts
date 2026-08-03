import { assert, describe, it } from "@effect/vitest";
import { Data, Effect } from "effect";

import { makePiTestHarness } from "../../../tests/pi-test-harness.ts";
import { registerAgentosSupervisionGuard } from "../extension.ts";

class SupervisionTestBoundaryError extends Data.TaggedError(
  "SupervisionTestBoundaryError",
)<{}> {}

function emit(
  fake: Effect.Success<ReturnType<typeof makePiTestHarness>>,
  event: string,
  payload: Record<string, unknown> = {},
) {
  return fake.emit(event, payload).pipe(
    Effect.mapError(() => new SupervisionTestBoundaryError()),
  );
}

function register(
  fake: Effect.Success<ReturnType<typeof makePiTestHarness>>,
  disabled = false,
) {
  registerAgentosSupervisionGuard(fake.pi, {
    environment: {
      AGENTOS_DISABLE_SUPERVISION_GUARD: disabled ? "true" : "false",
    },
  });
}

const taggedTask = {
  id: "bg-watch",
  state: "running",
  description: "[agentos-supervision] Wait for the next Fleet event",
};

describe("Effect AgentOS Mate supervision guard", () => {
  it.effect("starts one recovery turn per runtime startup", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      register(fake);
      yield* emit(fake, "session_start");
      yield* emit(fake, "session_start");
      assert.lengthOf(fake.messages, 1);
      assert.strictEqual(
        fake.messages[0]?.message.customType,
        "agentos-supervision-recovery",
      );
      assert.strictEqual(fake.messages[0]?.message.display, true);
      assert.deepStrictEqual(
        fake.messages[0]?.options,
        { deliverAs: "followUp", triggerTurn: true },
      );
      assert.include(
        String(fake.messages[0]?.message.content),
        'list_background_commands with state "interrupted"',
      );
    }));

  it.effect("can be disabled without ambient environment mutation", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      register(fake, true);
      yield* emit(fake, "session_start");
      yield* emit(fake, "agent_settled");
      assert.deepStrictEqual(fake.messages, []);
      assert.strictEqual(fake.extension.handlers.size, 0);
    }));

  it.effect("reminds once, tracks a tagged wait, and forgets it on completion", () =>
    Effect.gen(function*() {
      const reminder = yield* makePiTestHarness();
      register(reminder);
      yield* emit(reminder, "agent_settled");
      yield* emit(reminder, "agent_settled");
      assert.lengthOf(reminder.messages, 1);
      assert.strictEqual(
        reminder.messages[0]?.message.customType,
        "agentos-supervision-guard",
      );

      const tracked = yield* makePiTestHarness();
      register(tracked);
      yield* emit(tracked, "tool_result", {
        toolName: "run_background_command",
        isError: false,
        details: taggedTask,
      });
      yield* emit(tracked, "agent_settled");
      assert.deepStrictEqual(tracked.messages, []);
      yield* emit(tracked, "message_start", {
        message: {
          role: "custom",
          customType: "agentos-background-command-completion",
          details: { taskIds: [taggedTask.id] },
        },
      });
      yield* emit(tracked, "agent_settled");
      assert.lengthOf(tracked.messages, 1);
    }));

  it.effect("accepts only a running tagged task and preserves it across history inspection", () =>
    Effect.gen(function*() {
      for (const task of [
        { id: "bg-done", state: "succeeded" },
        { id: "bg-unrelated", state: "running", description: "other" },
      ]) {
        const fake = yield* makePiTestHarness();
        register(fake);
        yield* emit(fake, "tool_result", {
          toolName: "list_background_commands",
          isError: false,
          details: { tasks: [task] },
        });
        yield* emit(fake, "agent_settled");
        assert.lengthOf(fake.messages, 1);
      }

      const listed = yield* makePiTestHarness();
      register(listed);
      yield* emit(listed, "tool_result", {
        toolName: "list_background_commands",
        isError: false,
        details: { tasks: [taggedTask] },
      });
      yield* emit(listed, "agent_settled");
      assert.deepStrictEqual(listed.messages, []);

      const fake = yield* makePiTestHarness();
      register(fake);
      yield* emit(fake, "tool_result", {
        toolName: "run_background_command",
        isError: false,
        details: taggedTask,
      });
      yield* emit(fake, "tool_result", {
        toolName: "list_background_commands",
        input: { state: "interrupted" },
        isError: false,
        details: {
          tasks: [{
            id: "bg-old",
            state: "interrupted",
            description: "[agentos-supervision] old wait",
          }],
        },
      });
      yield* emit(fake, "agent_settled");
      assert.deepStrictEqual(fake.messages, []);
    }));
});
