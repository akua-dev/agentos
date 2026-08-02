import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  buildAgentOSInstructionsEffect,
  registerAgentOSInstructionsEffect,
  type AgentOSInstructionSourceV1,
} from "../src/instructions.ts";
import { makePiTestHarness } from "./pi-test-harness.ts";

const baseSource = {
  version: 1,
  id: "@example/base",
  content: "Base identity.",
} satisfies AgentOSInstructionSourceV1;
const additionSource = {
  version: 1,
  id: "@example/addition",
  content: "Added invariant.",
} satisfies AgentOSInstructionSourceV1;
const sources = [baseSource, additionSource];

const PromptResult = Schema.Struct({ systemPrompt: Schema.String });

describe("AgentOS instruction assembly", () => {
  it.effect("assembles explicit sources deterministically", () =>
    Effect.gen(function*() {
      assert.strictEqual(
        yield* buildAgentOSInstructionsEffect(sources),
        [
          '<agentos-instructions id="@example/base">',
          "Base identity.",
          "</agentos-instructions>",
          "",
          '<agentos-instructions id="@example/addition">',
          "Added invariant.",
          "</agentos-instructions>",
        ].join("\n"),
      );
    }));

  it.effect("preserves Pi's base prompt and avoids duplicate injection", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      yield* registerAgentOSInstructionsEffect(fake.pi, sources);
      const [rawFirst] = yield* fake.emit("before_agent_start", {
        type: "before_agent_start",
        prompt: "hello",
        systemPrompt: "Pi base prompt.",
        systemPromptOptions: { cwd: "/workspace" },
      });
      const first = yield* Schema.decodeUnknownEffect(PromptResult)(rawFirst);
      assert.include(first.systemPrompt, "Pi base prompt.");
      assert.lengthOf(first.systemPrompt.match(/Base identity\./g) ?? [], 1);

      const [rawSecond] = yield* fake.emit("before_agent_start", {
        type: "before_agent_start",
        prompt: "hello",
        systemPrompt: first.systemPrompt,
        systemPromptOptions: { cwd: "/workspace" },
      });
      const second = yield* Schema.decodeUnknownEffect(PromptResult)(rawSecond);
      assert.strictEqual(second.systemPrompt, first.systemPrompt);
    }));

  it.effect("rejects duplicate source IDs before attaching a hook", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const failure = yield* registerAgentOSInstructionsEffect(
        fake.pi,
        [baseSource, baseSource],
      ).pipe(Effect.flip);
      assert.include(failure.message, 'duplicate instruction source id "@example/base"');
      assert.strictEqual(fake.extension.handlers.size, 0);
    }));
});
