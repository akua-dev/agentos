import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Path, Schema } from "effect";

import type { AgentOSRegistrationV1 } from "../src/preflight.ts";
import {
  loadPackagedRoleSetupEffect,
  registerDefaultAgentOSEntrypointEffect,
  type DefaultAgentOSRole,
} from "../src/roles/default.ts";
import { makePiTestHarness } from "./pi-test-harness.ts";
import { roleSetupFixture } from "./role-setup-fixture.ts";

const PromptResult = Schema.Struct({ systemPrompt: Schema.String });
const StartupMessages = Schema.Array(Schema.Struct({
  message: Schema.Struct({ content: Schema.String }),
}));
const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromUnknown({})),
);

const supervisionSkillPath = Effect.fn("test.lifecycle.supervisionSkillPath")(
  function*() {
    const paths = yield* Path.Path;
    return yield* paths.fromFileUrl(
      new URL("../skills/agentos-supervision/SKILL.md", import.meta.url),
    );
  },
);

describe("default AgentOS lifecycle", () => {
  it.effect("injects selected identity and sends one aggregated startup turn", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness({
        systemPrompt:
          "<available_skills><skill><name>agentos-supervision</name></skill></available_skills>",
      });
      const skillPath = yield* supervisionSkillPath();
      yield* registerDefaultAgentOSEntrypointEffect(fake.pi, {
        role: "first_mate",
        loadRoleEffect: () => Effect.succeed(
          roleSetupFixture("first_mate", skillPath),
        ),
      });

      const [rawInstructionResult] = yield* fake.emit("before_agent_start", {
        type: "before_agent_start",
        prompt: "hello",
        systemPrompt: "Pi base.",
        systemPromptOptions: { cwd: "/workspace" },
      });
      const instructionResult = yield* Schema.decodeUnknownEffect(PromptResult)(
        rawInstructionResult,
      );
      yield* fake.emit("session_start", { type: "session_start", reason: "startup" });
      yield* fake.emit("session_start", { type: "session_start", reason: "startup" });

      assert.include(instructionResult.systemPrompt, "first_mate identity");
      const messages = yield* Schema.decodeUnknownEffect(StartupMessages)(fake.messages);
      assert.lengthOf(messages, 1);
      assert.include(messages[0]?.message.content ?? "", "Load $agentos-supervision");
    }).pipe(Effect.provide(platform)));

  it.effect("rejects a collision before any part registers", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const skillPath = yield* supervisionSkillPath();
      const setup = roleSetupFixture("first_mate", skillPath);
      const collision: AgentOSRegistrationV1 = {
        version: 1,
        id: "@example/collision",
        names: { version: 1, commands: ["example-first_mate"] },
        register(pi) {
          return Effect.sync(() => pi.on("session_start", () => undefined));
        },
      };
      const failure = yield* registerDefaultAgentOSEntrypointEffect(fake.pi, {
        role: "first_mate",
        loadRoleEffect: () => Effect.succeed({
          ...setup,
          runtime: [...setup.runtime, collision],
        }),
      }).pipe(Effect.flip);

      assert.include(failure.message, 'command "example-first_mate"');
      assert.strictEqual(fake.extension.handlers.size, 0);
    }).pipe(Effect.provide(platform)));

  it.effect("rejects an undelivered startup Skill before any part registers", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const skillPath = yield* supervisionSkillPath();
      const setup = roleSetupFixture("first_mate", skillPath);
      const failure = yield* registerDefaultAgentOSEntrypointEffect(fake.pi, {
        role: "first_mate",
        loadRoleEffect: () => Effect.succeed({
          ...setup,
          names: { ...setup.names, skills: [] },
        }),
      }).pipe(Effect.flip);

      assert.include(
        failure.message,
        'startup contribution "@example/first_mate:startup" references undeclared Skill "agentos-supervision"',
      );
      assert.strictEqual(fake.extension.handlers.size, 0);
    }).pipe(Effect.provide(platform)));

  it.effect("rejects invalid startup metadata before any part registers", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const skillPath = yield* supervisionSkillPath();
      const setup = roleSetupFixture("first_mate", skillPath);
      const failure = yield* registerDefaultAgentOSEntrypointEffect(fake.pi, {
        role: "first_mate",
        loadRoleEffect: () => Effect.succeed({
          ...setup,
          startup: { ...setup.startup, customType: "" },
        }),
      }).pipe(Effect.flip);

      assert.include(failure.message, "custom message type");
      assert.strictEqual(fake.extension.handlers.size, 0);
    }).pipe(Effect.provide(platform)));

  const roles: ReadonlyArray<DefaultAgentOSRole> = [
    "first_mate",
    "second_mate",
  ];
  for (const role of roles) {
    it.effect(`injects only the packaged ${role} identity`, () =>
      Effect.gen(function*() {
        const fake = yield* makePiTestHarness();
        yield* registerDefaultAgentOSEntrypointEffect(fake.pi, {
          role,
          loadRoleEffect: (selected) => loadPackagedRoleSetupEffect(
            selected,
            selected === "first_mate" ? "firstmate" : "secondmate",
          ),
        });

        const [rawResult] = yield* fake.emit("before_agent_start", {
          type: "before_agent_start",
          prompt: "hello",
          systemPrompt: "Pi base.",
          systemPromptOptions: { cwd: "/workspace" },
        });
        const result = yield* Schema.decodeUnknownEffect(PromptResult)(rawResult);
        const ownIdentity = role === "first_mate"
          ? "You are First Mate."
          : "You are a persistent Second Mate chartered by First Mate.";
        const otherIdentity = role === "first_mate"
          ? "You are a persistent Second Mate chartered by First Mate."
          : "You are First Mate.";
        assert.include(result.systemPrompt, ownIdentity);
        assert.notInclude(result.systemPrompt, otherIdentity);
      }).pipe(Effect.provide(platform)));
  }
});
