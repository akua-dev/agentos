import { assert, describe, it } from "@effect/vitest";
import { Effect, MutableRef, Schema } from "effect";

import {
  buildAgentOSStartupPromptEffect,
  preflightAgentOSStartupEffect,
  registerAgentOSStartupEffect,
  type AgentOSStartupContributionV1,
} from "../src/startup.ts";
import { makePiTestHarness } from "./pi-test-harness.ts";

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

const StartupMessages = Schema.Array(Schema.Struct({
  message: Schema.Struct({
    customType: Schema.String,
    content: Schema.String,
    display: Schema.Boolean,
    details: Schema.Struct({ reason: Schema.String }),
  }),
  options: Schema.Struct({
    deliverAs: Schema.String,
    triggerTurn: Schema.Boolean,
  }),
}));

function failedMessageDeliveryAdapter() {
  return decodeURIComponent("%");
}

describe("AgentOS startup prompt assembly", () => {
  it.effect("preserves explicit contribution order in one prompt", () =>
    Effect.gen(function*() {
      assert.strictEqual(
        yield* buildAgentOSStartupPromptEffect([
          contribution("example:first"),
          contribution("example:second"),
        ]),
        [
          "Load $example-first-startup and reconcile example:first:",
          "Reconcile example:first.",
          "",
          "Load $example-second-startup and reconcile example:second:",
          "Reconcile example:second.",
        ].join("\n"),
      );
    }));

  it.effect("rejects unsupported versions and duplicate IDs", () =>
    Effect.gen(function*() {
      const unsupported = contribution("example:bad");
      Reflect.set(unsupported, "version", 2);
      const versionFailure = yield* buildAgentOSStartupPromptEffect([
        unsupported,
      ]).pipe(Effect.flip);
      assert.include(versionFailure.message, "unsupported startup contribution version");

      const duplicateFailure = yield* buildAgentOSStartupPromptEffect([
        contribution("example:duplicate"),
        contribution("example:duplicate"),
      ]).pipe(Effect.flip);
      assert.include(
        duplicateFailure.message,
        'duplicate startup contribution id "example:duplicate"',
      );
    }));

  it.effect("enforces every approved startup bound without truncation", () =>
    Effect.gen(function*() {
      const cases = [
        {
          contributions: Array.from({ length: 17 }, (_, index) =>
            contribution(`example:${index}`)),
          message: "at most 16",
        },
        {
          contributions: [contribution("i".repeat(129))],
          message: "id",
        },
        {
          contributions: [
            contribution("example:skill", { skill: "s".repeat(65) }),
          ],
          message: "valid Pi Skill name",
        },
        {
          contributions: [
            contribution("example:instruction", {
              instruction: "🙂".repeat(513),
            }),
          ],
          message: "2048 UTF-8 bytes",
        },
        {
          contributions: Array.from({ length: 9 }, (_, index) =>
            contribution(`example:aggregate-${index}`, {
              instruction: "a".repeat(2048),
            })),
          message: "16384 UTF-8 bytes",
        },
      ];
      for (const invalid of cases) {
        const failure = yield* buildAgentOSStartupPromptEffect(
          invalid.contributions,
        ).pipe(Effect.flip);
        assert.include(failure.message, invalid.message);
      }
    }));

  it.effect("accepts only Skill names discoverable by the supported Pi build", () =>
    Effect.gen(function*() {
      for (const skill of [
        "Uppercase",
        "underscore_name",
        "-leading",
        "trailing-",
        "two--hyphens",
        "s".repeat(65),
      ]) {
        const failure = yield* buildAgentOSStartupPromptEffect([
          contribution("example:invalid-skill", { skill }),
        ]).pipe(Effect.flip);
        assert.include(failure.message, "valid Pi Skill name");
      }
      yield* buildAgentOSStartupPromptEffect([
        contribution("example:valid-skill", {
          skill: "valid-pi-skill-81",
        }),
      ]);
    }));

  it.effect("preflights startup metadata without attaching a handler", () =>
    Effect.gen(function*() {
      const customTypeFailure = yield* preflightAgentOSStartupEffect({
        customType: "",
        prompt: "Load $example-startup.",
        requiredSkills: ["example-startup"],
      }).pipe(Effect.flip);
      assert.include(customTypeFailure.message, "custom message type");

      const promptFailure = yield* preflightAgentOSStartupEffect({
        customType: "@example/agentos:startup",
        prompt: "  ",
        requiredSkills: ["example-startup"],
      }).pipe(Effect.flip);
      assert.include(promptFailure.message, "prompt must not be empty");
    }));

  it.effect("requests one inspectable follow-up only while Pi is idle", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness({
        systemPrompt:
          "<available_skills><skill><name>example-startup</name></skill></available_skills>",
      });
      yield* registerAgentOSStartupEffect(fake.pi, {
        customType: "@example/agentos:startup",
        prompt: "Load $example-startup and reconcile it.",
        requiredSkills: ["example-startup"],
      });

      yield* fake.emit("session_start", { type: "session_start", reason: "startup" });
      yield* fake.emit("session_start", { type: "session_start", reason: "startup" });
      const messages = yield* Schema.decodeUnknownEffect(StartupMessages)(fake.messages);
      assert.deepStrictEqual(messages, [
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

      const busy = yield* makePiTestHarness({ idle: false });
      yield* registerAgentOSStartupEffect(busy.pi, {
        customType: "@example/agentos:startup",
        prompt: "Never sent",
        requiredSkills: ["example-startup"],
      });
      yield* busy.emit("session_start", { type: "session_start", reason: "reload" });
      assert.deepStrictEqual(busy.messages, []);
    }));

  it.effect("fails closed when Pi has not preloaded the required Skill", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness({
        systemPrompt:
          "<available_skills><skill><name>another-skill</name></skill></available_skills>",
      });
      yield* registerAgentOSStartupEffect(fake.pi, {
        customType: "@example/agentos:startup",
        prompt: "Load $example-startup and reconcile it.",
        requiredSkills: ["example-startup"],
      });

      const failure = yield* fake.emit("session_start", {
        type: "session_start",
        reason: "startup",
      }).pipe(Effect.flip);
      assert.include(
        failure.detail,
        'AgentOS startup requires Pi to preload Skill "example-startup"',
      );
      assert.deepStrictEqual(fake.messages, []);
    }));

  it.effect("does not retry a failed delivery in a loop", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness({
        systemPrompt:
          "<available_skills><skill><name>example-startup</name></skill></available_skills>",
      });
      const attempts = MutableRef.make(0);
      const observed = MutableRef.make<unknown>(undefined);
      fake.pi.sendMessage = () => {
        MutableRef.update(attempts, (count) => count + 1);
        failedMessageDeliveryAdapter();
      };
      yield* registerAgentOSStartupEffect(fake.pi, {
        customType: "@example/agentos:startup",
        onError: (error) => MutableRef.set(observed, error),
        prompt: "Attempt once",
        requiredSkills: ["example-startup"],
      });

      yield* fake.emit("session_start", { type: "session_start", reason: "reload" });
      yield* fake.emit("session_start", { type: "session_start", reason: "reload" });

      assert.strictEqual(MutableRef.get(attempts), 1);
      assert.instanceOf(MutableRef.get(observed), Error);
    }));
});
