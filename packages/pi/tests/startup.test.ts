import { describe, expect, test } from "bun:test";

import {
  composeAgentOSStartupPrompt,
  registerAgentOSStartup,
  type AgentOSStartupContributionV1,
} from "../src/index.ts";
import { createFakePi } from "./fake-pi.ts";

function contribution(
  id: string,
  overrides: Partial<AgentOSStartupContributionV1> = {},
): AgentOSStartupContributionV1 {
  return {
    version: 1,
    id,
    skill: `${id.replace(/[^a-z0-9]+/g, "-")}-startup`,
    instruction: `Reconcile ${id}.`,
    ...overrides,
  };
}

describe("AgentOS startup composition", () => {
  test("preserves explicit contribution order in one prompt", () => {
    expect(
      composeAgentOSStartupPrompt([
        contribution("example:first"),
        contribution("example:second"),
      ]),
    ).toBe(
      [
        "Load $example-first-startup and reconcile example:first:",
        "Reconcile example:first.",
        "",
        "Load $example-second-startup and reconcile example:second:",
        "Reconcile example:second.",
      ].join("\n"),
    );
  });

  test("rejects unsupported versions and duplicate IDs", () => {
    expect(() =>
      composeAgentOSStartupPrompt([
        contribution("example:bad", { version: 2 as 1 }),
      ]),
    ).toThrow("unsupported startup contribution version");
    expect(() =>
      composeAgentOSStartupPrompt([
        contribution("example:duplicate"),
        contribution("example:duplicate"),
      ]),
    ).toThrow('duplicate startup contribution id "example:duplicate"');
  });

  test("enforces every approved startup bound without truncation", () => {
    expect(() =>
      composeAgentOSStartupPrompt(
        Array.from({ length: 17 }, (_, index) =>
          contribution(`example:${index}`),
        ),
      ),
    ).toThrow("at most 16");
    expect(() =>
      composeAgentOSStartupPrompt([contribution("i".repeat(129))]),
    ).toThrow("id");
    expect(() =>
      composeAgentOSStartupPrompt([
        contribution("example:skill", { skill: "s".repeat(129) }),
      ]),
    ).toThrow("skill");
    expect(() =>
      composeAgentOSStartupPrompt([
        contribution("example:instruction", {
          instruction: "🙂".repeat(513),
        }),
      ]),
    ).toThrow("2048 UTF-8 bytes");
    expect(() =>
      composeAgentOSStartupPrompt(
        Array.from({ length: 9 }, (_, index) =>
          contribution(`example:aggregate-${index}`, {
            instruction: "a".repeat(2048),
          }),
        ),
      ),
    ).toThrow("16384 UTF-8 bytes");
  });

  test("requests one inspectable follow-up only while Pi is idle", async () => {
    const fake = createFakePi();
    registerAgentOSStartup(fake.pi, {
      customType: "@example/agentos:startup",
      prompt: "Load $example-startup and reconcile it.",
    });

    await fake.emit("session_start", { type: "session_start", reason: "startup" });
    await fake.emit("session_start", { type: "session_start", reason: "startup" });

    expect(fake.messages).toEqual([
      {
        message: {
          customType: "@example/agentos:startup",
          content: "Load $example-startup and reconcile it.",
          display: true,
          details: { reason: "startup" },
        },
        options: { deliverAs: "followUp", triggerTurn: true },
      },
    ]);

    const busy = createFakePi({ idle: false });
    registerAgentOSStartup(busy.pi, {
      customType: "@example/agentos:startup",
      prompt: "Never sent",
    });
    await busy.emit("session_start", { type: "session_start", reason: "reload" });
    expect(busy.messages).toEqual([]);
  });

  test("does not retry a failed delivery in a loop", async () => {
    const fake = createFakePi();
    let attempts = 0;
    let observed: unknown;
    fake.pi.sendMessage = () => {
      attempts += 1;
      throw new Error("delivery failed");
    };
    registerAgentOSStartup(fake.pi, {
      customType: "@example/agentos:startup",
      onError: (error) => {
        observed = error;
      },
      prompt: "Attempt once",
    });

    await fake.emit("session_start", { type: "session_start", reason: "reload" });
    await fake.emit("session_start", { type: "session_start", reason: "reload" });

    expect(attempts).toBe(1);
    expect(observed).toBeInstanceOf(Error);
  });
});
