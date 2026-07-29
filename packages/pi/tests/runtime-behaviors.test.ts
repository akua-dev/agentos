import { describe, expect, test } from "bun:test";

import {
  defaultAgentOSRuntime,
  preflightAgentOSComposition,
  registerAgentOSRuntime,
} from "../src/index.ts";
import { createFakePi } from "./fake-pi.ts";

describe("released AgentOS Pi registrations", () => {
  test("exports every released behavior as a replaceable registration", () => {
    expect(defaultAgentOSRuntime.map(({ id }) => id)).toEqual([
      "@akua-dev/agentos-pi:background-tasks",
      "@akua-dev/agentos-pi:mate-memory",
      "@akua-dev/agentos-pi:openai-server-compaction",
      "@akua-dev/agentos-pi:supervision-guard",
    ]);
    expect(() => preflightAgentOSComposition(defaultAgentOSRuntime)).not.toThrow();
  });

  test("declares and registers the released tool and command surface", async () => {
    const fake = createFakePi();
    await registerAgentOSRuntime(fake.pi, defaultAgentOSRuntime);

    expect(
      fake.registrations
        .filter(({ kind }) => kind === "tool")
        .map(({ name }) => name),
    ).toEqual([
      "run_background_command",
      "get_background_command_output",
      "list_background_commands",
      "kill_background_command",
      "set_mate_memory_state",
      "memory_delete_topic",
    ]);
    expect(
      fake.registrations
        .filter(({ kind }) => kind === "command")
        .map(({ name }) => name),
    ).toEqual(["background-commands", "memory"]);
  });

  test("lets a distribution replace one behavior without copying the rest", () => {
    const withoutCompaction = defaultAgentOSRuntime.filter(
      ({ id }) => id !== "@akua-dev/agentos-pi:openai-server-compaction",
    );
    expect(withoutCompaction).toHaveLength(3);
    expect(() => preflightAgentOSComposition(withoutCompaction)).not.toThrow();
  });
});
