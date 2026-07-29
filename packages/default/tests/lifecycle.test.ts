import { describe, expect, test } from "bun:test";

import { createDefaultAgentOSEntrypoint } from "../composition/shared.ts";
import { loadFirstMateComposition } from "../composition/firstmate.ts";
import { loadSecondMateComposition } from "../composition/secondmate.ts";
import { createFakePi } from "../../pi/tests/fake-pi.ts";
import { roleComposition } from "./entrypoint.test.ts";

describe("default AgentOS lifecycle composition", () => {
  test("injects selected identity and sends one aggregated startup turn", async () => {
    const fake = createFakePi();
    const entrypoint = createDefaultAgentOSEntrypoint({
      getRole: () => "first_mate",
      loadRole: async () => roleComposition("first_mate"),
    });
    await entrypoint(fake.pi);

    const [instructionResult] = await fake.emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "hello",
      systemPrompt: "Pi base.",
      systemPromptOptions: { cwd: "/workspace" },
    });
    await fake.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });
    await fake.emit("session_start", {
      type: "session_start",
      reason: "startup",
    });

    expect(
      (instructionResult as { systemPrompt: string }).systemPrompt,
    ).toContain("first_mate identity");
    expect(fake.messages).toHaveLength(1);
    expect(fake.messages[0]?.message.content).toContain(
      "Load $agentos-supervision",
    );
  });

  test("rejects a collision before any part registers", async () => {
    const fake = createFakePi();
    const composition = roleComposition("first_mate");
    const collision = {
      ...composition.runtime[0]!,
      id: "@example/collision",
    };
    const entrypoint = createDefaultAgentOSEntrypoint({
      getRole: () => "first_mate",
      loadRole: async () => ({
        ...composition,
        runtime: [...composition.runtime, collision],
      }),
    });

    await expect(entrypoint(fake.pi)).rejects.toThrow(
      'command "example-first_mate"',
    );
    expect(fake.registrations).toEqual([]);
  });

  test("rejects an undelivered startup Skill before any part registers", async () => {
    const fake = createFakePi();
    const composition = roleComposition("first_mate");
    const entrypoint = createDefaultAgentOSEntrypoint({
      getRole: () => "first_mate",
      loadRole: async () => ({
        ...composition,
        names: { ...composition.names, skills: [] },
      }),
    });

    await expect(entrypoint(fake.pi)).rejects.toThrow(
      'startup contribution "@example/first_mate:startup" references undeclared Skill "agentos-supervision"',
    );
    expect(fake.registrations).toEqual([]);
  });

  test("rejects invalid startup metadata before any part registers", async () => {
    const fake = createFakePi();
    const composition = roleComposition("first_mate");
    const entrypoint = createDefaultAgentOSEntrypoint({
      getRole: () => "first_mate",
      loadRole: async () => ({
        ...composition,
        startup: { ...composition.startup, customType: "" },
      }),
    });

    await expect(entrypoint(fake.pi)).rejects.toThrow("custom message type");
    expect(fake.registrations).toEqual([]);
  });

  for (const role of ["first_mate", "second_mate"] as const) {
    test(`injects only the packaged ${role} identity`, async () => {
      const fake = createFakePi();
      const entrypoint = createDefaultAgentOSEntrypoint({
        getRole: () => role,
        loadRole:
          role === "first_mate"
            ? loadFirstMateComposition
            : loadSecondMateComposition,
      });
      await entrypoint(fake.pi);

      const [result] = await fake.emit("before_agent_start", {
        type: "before_agent_start",
        prompt: "hello",
        systemPrompt: "Pi base.",
        systemPromptOptions: { cwd: "/workspace" },
      });
      const prompt = (result as { systemPrompt: string }).systemPrompt;
      expect(prompt).toContain(
        role === "first_mate"
          ? "You are First Mate."
          : "You are a persistent Second Mate chartered by First Mate.",
      );
      expect(prompt).not.toContain(
        role === "first_mate"
          ? "You are a persistent Second Mate chartered by First Mate."
          : "You are First Mate.",
      );
    });
  }
});
