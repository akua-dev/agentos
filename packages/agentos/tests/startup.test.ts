import { describe, expect, test } from "bun:test";

import {
  buildAgentOSStartupPrompt,
  preflightAgentOSStartup,
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

describe("AgentOS startup prompt assembly", () => {
  test("preserves explicit contribution order in one prompt", () => {
    expect(
      buildAgentOSStartupPrompt([
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
      buildAgentOSStartupPrompt([
        contribution("example:bad", { version: 2 as 1 }),
      ]),
    ).toThrow("unsupported startup contribution version");
    expect(() =>
      buildAgentOSStartupPrompt([
        contribution("example:duplicate"),
        contribution("example:duplicate"),
      ]),
    ).toThrow('duplicate startup contribution id "example:duplicate"');
  });

  test("enforces every approved startup bound without truncation", () => {
    expect(() =>
      buildAgentOSStartupPrompt(
        Array.from({ length: 17 }, (_, index) =>
          contribution(`example:${index}`),
        ),
      ),
    ).toThrow("at most 16");
    expect(() =>
      buildAgentOSStartupPrompt([contribution("i".repeat(129))]),
    ).toThrow("id");
    expect(() =>
      buildAgentOSStartupPrompt([
        contribution("example:skill", { skill: "s".repeat(65) }),
      ]),
    ).toThrow("valid Pi Skill name");
    expect(() =>
      buildAgentOSStartupPrompt([
        contribution("example:instruction", {
          instruction: "🙂".repeat(513),
        }),
      ]),
    ).toThrow("2048 UTF-8 bytes");
    expect(() =>
      buildAgentOSStartupPrompt(
        Array.from({ length: 9 }, (_, index) =>
          contribution(`example:aggregate-${index}`, {
            instruction: "a".repeat(2048),
          }),
        ),
      ),
    ).toThrow("16384 UTF-8 bytes");
  });

  test("accepts only Skill names discoverable by the supported Pi build", () => {
    for (const skill of [
      "Uppercase",
      "underscore_name",
      "-leading",
      "trailing-",
      "two--hyphens",
      "s".repeat(65),
    ]) {
      expect(() =>
        buildAgentOSStartupPrompt([
          contribution("example:invalid-skill", { skill }),
        ]),
      ).toThrow("valid Pi Skill name");
    }
    expect(() =>
      buildAgentOSStartupPrompt([
        contribution("example:valid-skill", {
          skill: "valid-pi-skill-81",
        }),
      ]),
    ).not.toThrow();
  });

  test("preflights startup metadata without attaching a handler", () => {
    expect(() =>
      preflightAgentOSStartup({
        customType: "",
        prompt: "Load $example-startup.",
        requiredSkills: ["example-startup"],
      }),
    ).toThrow("custom message type");
    expect(() =>
      preflightAgentOSStartup({
        customType: "@example/agentos:startup",
        prompt: "  ",
        requiredSkills: ["example-startup"],
      }),
    ).toThrow("prompt must not be empty");
  });

  test("requests one inspectable follow-up only while Pi is idle", async () => {
    const fake = createFakePi({
      systemPrompt:
        "<available_skills><skill><name>example-startup</name></skill></available_skills>",
    });
    registerAgentOSStartup(fake.pi, {
      customType: "@example/agentos:startup",
      prompt: "Load $example-startup and reconcile it.",
      requiredSkills: ["example-startup"],
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
      requiredSkills: ["example-startup"],
    });
    await busy.emit("session_start", { type: "session_start", reason: "reload" });
    expect(busy.messages).toEqual([]);
  });

  test("fails closed when Pi has not preloaded the required Skill", async () => {
    const fake = createFakePi({
      systemPrompt:
        "<available_skills><skill><name>another-skill</name></skill></available_skills>",
    });
    registerAgentOSStartup(fake.pi, {
      customType: "@example/agentos:startup",
      prompt: "Load $example-startup and reconcile it.",
      requiredSkills: ["example-startup"],
    });

    await expect(
      fake.emit("session_start", {
        type: "session_start",
        reason: "startup",
      }),
    ).rejects.toThrow(
      'AgentOS startup requires Pi to preload Skill "example-startup"',
    );
    expect(fake.messages).toEqual([]);
  });

  test("does not retry a failed delivery in a loop", async () => {
    const fake = createFakePi({
      systemPrompt:
        "<available_skills><skill><name>example-startup</name></skill></available_skills>",
    });
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
      requiredSkills: ["example-startup"],
    });

    await fake.emit("session_start", { type: "session_start", reason: "reload" });
    await fake.emit("session_start", { type: "session_start", reason: "reload" });

    expect(attempts).toBe(1);
    expect(observed).toBeInstanceOf(Error);
  });
});
