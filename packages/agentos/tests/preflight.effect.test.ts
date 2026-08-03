import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  preflightAgentOSRegistrationsEffect,
  registerAgentOSRuntimeEffect,
  type AgentOSRegistrationV1,
} from "../src/preflight.ts";
import { makePiTestHarness } from "./pi-test-harness.ts";

function registration(
  id: string,
  names: Omit<AgentOSRegistrationV1["names"], "version">,
): AgentOSRegistrationV1 {
  return {
    version: 1,
    id,
    names: { version: 1, ...names },
    register(pi) {
      pi.on("session_start", () => undefined);
    },
  };
}

function registeredSurface(
  fake: Effect.Success<ReturnType<typeof makePiTestHarness>>,
) {
  return {
    commands: [...fake.extension.commands.keys()],
    handlers: [...fake.extension.handlers.keys()],
    tools: [...fake.extension.tools.keys()],
  };
}

describe("AgentOS registration preflight", () => {
  type ClaimKind = "tools" | "commands" | "skills" | "messages" | "entries";
  const singular = {
    tools: "tool",
    commands: "command",
    skills: "skill",
    messages: "message",
    entries: "entry",
  } satisfies Readonly<Record<string, string>>;
  const kinds: ReadonlyArray<ClaimKind> = [
    "tools",
    "commands",
    "skills",
    "messages",
    "entries",
  ];

  for (const kind of kinds) {
    it.effect(`rejects ${kind} collisions before registration`, () =>
      Effect.gen(function*() {
        const fake = yield* makePiTestHarness();
        const registrations = [
          registration("@example/one", { [kind]: ["example-name"] }),
          registration("@example/two", { [kind]: ["example-name"] }),
        ];

        const preflightFailure = yield* preflightAgentOSRegistrationsEffect(
          registrations,
        ).pipe(Effect.flip);
        assert.include(preflightFailure.message, `${singular[kind]} "example-name"`);
        yield* registerAgentOSRuntimeEffect(fake.pi, registrations).pipe(
          Effect.flip,
        );
        assert.strictEqual(fake.extension.handlers.size, 0);
      }));
  }

  it.effect("keeps separate registrations independent without singleton state", () =>
    Effect.gen(function*() {
      const first = yield* makePiTestHarness();
      const second = yield* makePiTestHarness();
      const registrations = [
        registration("@example/runtime", {
          commands: ["example-command"],
          tools: ["example-tool"],
        }),
      ];

      yield* registerAgentOSRuntimeEffect(first.pi, registrations);
      yield* registerAgentOSRuntimeEffect(second.pi, registrations);

      assert.deepStrictEqual(registeredSurface(first), registeredSurface(second));
      assert.notStrictEqual(first.extension.handlers, second.extension.handlers);
    }));

  it.effect("validates Skill claims with Pi's native name rules", () =>
    Effect.gen(function*() {
      for (const skill of [
        "Uppercase",
        "underscore_name",
        "-leading",
        "trailing-",
        "two--hyphens",
        "s".repeat(65),
      ]) {
        const failure = yield* preflightAgentOSRegistrationsEffect([
          registration("@example/skills", { skills: [skill] }),
        ]).pipe(Effect.flip);
        assert.include(failure.message, "valid Pi Skill name");
      }
      yield* preflightAgentOSRegistrationsEffect([
        registration("@example/skills", { skills: ["valid-pi-skill-81"] }),
      ]);
    }));
});
