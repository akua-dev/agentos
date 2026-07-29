import { describe, expect, test } from "bun:test";

import {
  preflightAgentOSComposition,
  registerAgentOSRuntime,
  type AgentOSRegistrationV1,
} from "../src/index.ts";
import { createFakePi } from "./fake-pi.ts";

function registration(
  id: string,
  names: Omit<AgentOSRegistrationV1["names"], "version">,
): AgentOSRegistrationV1 {
  return {
    version: 1,
    id,
    names: { version: 1, ...names },
    register(pi) {
      for (const tool of names.tools ?? []) {
        pi.registerTool({ name: tool } as never);
      }
      for (const command of names.commands ?? []) {
        pi.registerCommand(command, {} as never);
      }
    },
  };
}

describe("AgentOS composition preflight", () => {
  const singular = {
    tools: "tool",
    commands: "command",
    skills: "skill",
    messages: "message",
    entries: "entry",
  } as const;
  for (const kind of [
    "tools",
    "commands",
    "skills",
    "messages",
    "entries",
  ] as const) {
    test(`rejects ${kind} collisions before registration`, async () => {
      const fake = createFakePi();
      const registrations = [
        registration("@example/one", { [kind]: ["example-name"] }),
        registration("@example/two", { [kind]: ["example-name"] }),
      ];

      expect(() => preflightAgentOSComposition(registrations)).toThrow(
        `${singular[kind]} "example-name"`,
      );
      expect(() => registerAgentOSRuntime(fake.pi, registrations)).toThrow();
      expect(fake.registrations).toEqual([]);
    });
  }

  test("keeps separate registrations independent without singleton state", async () => {
    const first = createFakePi();
    const second = createFakePi();
    const registrations = [
      registration("@example/runtime", {
        commands: ["example-command"],
        tools: ["example-tool"],
      }),
    ];

    await registerAgentOSRuntime(first.pi, registrations);
    await registerAgentOSRuntime(second.pi, registrations);

    expect(first.registrations).toEqual(second.registrations);
    expect(first.registrations).not.toBe(second.registrations);
  });
});
