import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  MutableRef,
  Path,
} from "effect";

import {
  loadPackagedRoleSetupEffect,
  registerDefaultAgentOSEntrypointEffect,
  type DefaultAgentOSRole,
} from "../src/roles/default.ts";
import { loadFirstMateSetupEffect } from "../src/roles/firstmate.ts";
import { loadSecondMateSetupEffect } from "../src/roles/secondmate.ts";
import { makePiTestHarness } from "./pi-test-harness.ts";
import { roleSetupFixture } from "./role-setup-fixture.ts";

function platform(configuration: ReadonlyMap<string, string> = new Map()) {
  return Layer.merge(
    BunServices.layer,
    ConfigProvider.layer(ConfigProvider.fromUnknown(
      Object.fromEntries(configuration),
    )),
  );
}

const supervisionSkillPath = Effect.fn("test.entrypoint.supervisionSkillPath")(
  function*() {
    const paths = yield* Path.Path;
    return yield* paths.fromFileUrl(
      new URL("../skills/agentos-supervision/SKILL.md", import.meta.url),
    );
  },
);

describe("default AgentOS entrypoint", () => {
  it.effect("fails closed on a missing role before loading resources", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const skillPath = yield* supervisionSkillPath();
      const loads = MutableRef.make(0);
      const failure = yield* registerDefaultAgentOSEntrypointEffect(fake.pi, {
        loadRoleEffect: () => Effect.sync(() => {
          MutableRef.update(loads, (count) => count + 1);
          return roleSetupFixture("first_mate", skillPath);
        }),
      }).pipe(Effect.flip);

      assert.include(
        failure.message,
        "AGENTOS_AGENT_ROLE must be first_mate or second_mate",
      );
      assert.strictEqual(MutableRef.get(loads), 0);
      assert.strictEqual(fake.extension.handlers.size, 0);
    }).pipe(Effect.provide(platform())));

  it.effect("fails closed on an unknown role before loading resources", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const skillPath = yield* supervisionSkillPath();
      const loads = MutableRef.make(0);
      const failure = yield* registerDefaultAgentOSEntrypointEffect(fake.pi, {
        loadRoleEffect: () => Effect.sync(() => {
          MutableRef.update(loads, (count) => count + 1);
          return roleSetupFixture("first_mate", skillPath);
        }),
      }).pipe(Effect.flip);

      assert.include(
        failure.message,
        "AGENTOS_AGENT_ROLE must be first_mate or second_mate",
      );
      assert.strictEqual(MutableRef.get(loads), 0);
      assert.strictEqual(fake.extension.handlers.size, 0);
    }).pipe(Effect.provide(platform(new Map([
      ["AGENTOS_AGENT_ROLE", "captain"],
    ])))));

  it.effect("fails closed when a startup Skill is not delivered", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const skillPath = yield* supervisionSkillPath();
      const setup = roleSetupFixture("first_mate", skillPath);
      const failure = yield* registerDefaultAgentOSEntrypointEffect(fake.pi, {
        role: "first_mate",
        loadRoleEffect: () => Effect.succeed({
          ...setup,
          names: { ...setup.names, skills: ["missing-startup"] },
          resources: { version: 1 },
          startup: {
            ...setup.startup,
            contributions: setup.startup.contributions.map((item) => ({
              ...item,
              skill: "missing-startup",
            })),
          },
        }),
      }).pipe(Effect.flip);

      assert.include(
        failure.message,
        'startup contribution "@example/first_mate:startup" references unavailable Skill "missing-startup"',
      );
      assert.strictEqual(fake.extension.handlers.size, 0);
    }).pipe(Effect.provide(platform())));

  it.effect("fails closed when startup emits an undeclared message type", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const skillPath = yield* supervisionSkillPath();
      const setup = roleSetupFixture("first_mate", skillPath);
      const failure = yield* registerDefaultAgentOSEntrypointEffect(fake.pi, {
        role: "first_mate",
        loadRoleEffect: () => Effect.succeed({
          ...setup,
          startup: {
            ...setup.startup,
            customType: "@example/first_mate:unclaimed-startup",
          },
        }),
      }).pipe(Effect.flip);

      assert.include(
        failure.message,
        'startup custom message type "@example/first_mate:unclaimed-startup" is not declared',
      );
      assert.strictEqual(fake.extension.handlers.size, 0);
    }).pipe(Effect.provide(platform())));

  it.effect("loads default role resources from the selected distribution", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const distributionRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-selected-distribution-",
      });
      const roleDirectory = paths.join(
        distributionRoot,
        "resources",
        "roles",
        "firstmate",
      );
      const packageRoot = yield* paths.fromFileUrl(new URL("..", import.meta.url));
      yield* fileSystem.makeDirectory(roleDirectory, { recursive: true });
      yield* Effect.all([
        fileSystem.copy(
          paths.join(packageRoot, "skills"),
          paths.join(distributionRoot, "skills"),
        ),
        fileSystem.copy(
          paths.join(packageRoot, "resources", "roles", "firstmate", "skills"),
          paths.join(roleDirectory, "skills"),
        ),
      ], { concurrency: "unbounded" });
      yield* fileSystem.writeFileString(
        paths.join(roleDirectory, "instructions.md"),
        "Persistent selected role identity.\n",
      );

      const setup = yield* loadPackagedRoleSetupEffect(
        "first_mate",
        "firstmate",
      ).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
        AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
      }))));
      assert.strictEqual(
        setup.instructions[0]?.content,
        "Persistent selected role identity.\n",
      );
      assert.deepStrictEqual(setup.resources.skillPaths, [
        paths.join(distributionRoot, "skills"),
        paths.join(roleDirectory, "skills"),
      ]);
    }).pipe(Effect.provide(platform()))));

  it.effect("exposes packaged role loaders as Effect programs", () =>
    Effect.gen(function*() {
      const [firstMate, secondMate] = yield* Effect.all([
        loadFirstMateSetupEffect,
        loadSecondMateSetupEffect,
      ]);

      assert.strictEqual(
        firstMate.instructions[0]?.id,
        "@akua-dev/agentos:first_mate:identity",
      );
      assert.strictEqual(
        secondMate.instructions[0]?.id,
        "@akua-dev/agentos:second_mate:identity",
      );
    }).pipe(Effect.provide(platform())));

  const roles: ReadonlyArray<DefaultAgentOSRole> = [
    "first_mate",
    "second_mate",
  ];
  for (const role of roles) {
    it.effect(`selects only the ${role} role setup`, () =>
      Effect.gen(function*() {
        const fake = yield* makePiTestHarness();
        const skillPath = yield* supervisionSkillPath();
        const loaded = MutableRef.make<ReadonlyArray<DefaultAgentOSRole>>([]);
        yield* registerDefaultAgentOSEntrypointEffect(fake.pi, {
          role,
          loadRoleEffect: (selected) => Effect.sync(() => {
            MutableRef.update(loaded, (current) => [...current, selected]);
            return roleSetupFixture(selected, skillPath);
          }),
        });

        assert.deepStrictEqual(MutableRef.get(loaded), [role]);
      }).pipe(Effect.provide(platform())));
  }
});
