import { describe, expect, test } from "bun:test";

import {
  defaultAgentOSRuntime,
  preflightAgentOSRegistrations,
  registerAgentOSRuntime,
} from "../src/index.ts";
import { createFakePi } from "./fake-pi.ts";

describe("released AgentOS Pi registrations", () => {
  test("exports every released behavior as a replaceable registration", () => {
    expect(defaultAgentOSRuntime.map(({ id }) => id)).toEqual([
      "@akua-dev/agentos:observability",
      "@akua-dev/agentos:background-tasks",
      "@akua-dev/agentos:mate-memory",
      "@akua-dev/agentos:openai-server-compaction",
      "@akua-dev/agentos:supervision-guard",
    ]);
    expect(() => preflightAgentOSRegistrations(defaultAgentOSRuntime)).not.toThrow();
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
      ({ id }) => id !== "@akua-dev/agentos:openai-server-compaction",
    );
    expect(withoutCompaction).toHaveLength(4);
    expect(() => preflightAgentOSRegistrations(withoutCompaction)).not.toThrow();
  });
});
