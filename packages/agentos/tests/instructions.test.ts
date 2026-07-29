import { describe, expect, test } from "bun:test";

import {
  buildAgentOSInstructions,
  registerAgentOSInstructions,
} from "../src/index.ts";
import { createFakePi } from "./fake-pi.ts";

const sources = [
  { version: 1 as const, id: "@example/base", content: "Base identity." },
  { version: 1 as const, id: "@example/addition", content: "Added invariant." },
];

describe("AgentOS instruction assembly", () => {
  test("assembles explicit sources deterministically", () => {
    expect(buildAgentOSInstructions(sources)).toBe(
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
  });

  test("preserves Pi's base prompt and avoids duplicate injection", async () => {
    const fake = createFakePi();
    registerAgentOSInstructions(fake.pi, sources);
    const [first] = await fake.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "Pi base prompt.",
      systemPromptOptions: { cwd: "/workspace" },
    });
    const systemPrompt = (first as { systemPrompt: string }).systemPrompt;
    expect(systemPrompt).toContain("Pi base prompt.");
    expect(systemPrompt.match(/Base identity\./g)).toHaveLength(1);

    const [second] = await fake.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt,
      systemPromptOptions: { cwd: "/workspace" },
    });
    expect((second as { systemPrompt: string }).systemPrompt).toBe(systemPrompt);
  });

  test("rejects duplicate source IDs before attaching a hook", () => {
    const fake = createFakePi();
    expect(() =>
      registerAgentOSInstructions(fake.pi, [sources[0]!, sources[0]!]),
    ).toThrow('duplicate instruction source id "@example/base"');
    expect(fake.registrations).toEqual([]);
  });
});
