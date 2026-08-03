import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";

import {
  preflightAgentOSRegistrationsEffect,
  registerAgentOSRuntimeEffect,
} from "../src/preflight.ts";
import { additiveRegistration } from "./fixtures/additive-package/registration.ts";
import { replacementRegistration } from "./fixtures/replacement-package/registration.ts";
import { makePiTestHarness } from "./pi-test-harness.ts";
import { piCommandNames, type PiPackageSetting } from "./pi-rpc-test.ts";

const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

const commandNames = Effect.fn("test.ecosystem.commandNames")(function*(
  packages: ReadonlyArray<PiPackageSetting>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const sandbox = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "agentos-ecosystem-",
  });
  const project = paths.join(sandbox, "project");
  const agentDirectory = paths.join(sandbox, "agent");
  yield* fileSystem.makeDirectory(project, { recursive: true });
  return yield* piCommandNames({
    agentDirectory,
    cwd: project,
    packages,
    role: "first_mate",
  });
});

const packagePaths = Effect.fn("test.ecosystem.packagePaths")(function*() {
  const paths = yield* Path.Path;
  return {
    additive: yield* paths.fromFileUrl(
      new URL("./fixtures/additive-package/", import.meta.url),
    ),
    default: yield* paths.fromFileUrl(new URL("../", import.meta.url)),
    replacement: yield* paths.fromFileUrl(
      new URL("./fixtures/replacement-package/", import.meta.url),
    ),
  };
});

describe("native Pi package ecosystem", () => {
  it.effect("loads an independent additive package beside the default distribution", () =>
    Effect.scoped(Effect.gen(function*() {
      const packages = yield* packagePaths();
      const commands = yield* commandNames([packages.default, packages.additive]);
      for (const command of [
        "background-commands",
        "memory",
        "example-ecosystem-status",
        "skill:agentos-supervision",
        "skill:example-additive",
      ]) {
        assert.include(commands, command);
      }
    }).pipe(Effect.provide(platform))));

  it.effect("replaces the executable owner while retaining one selected default Skill", () =>
    Effect.scoped(Effect.gen(function*() {
      const packages = yield* packagePaths();
      const commands = yield* commandNames([
        {
          source: packages.default,
          autoload: false,
          extensions: [],
          skills: ["skills/agentos-supervision"],
        },
        packages.replacement,
      ]);
      for (const command of [
        "example-ecosystem-status",
        "skill:example-replacement",
        "skill:agentos-supervision",
      ]) {
        assert.include(commands, command);
      }
      for (const command of [
        "background-commands",
        "memory",
        "skill:agentos-bootstrap",
      ]) {
        assert.notInclude(commands, command);
      }
    }).pipe(Effect.provide(platform))));

  it.effect("rejects duplicate ownership before registration", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const duplicateAdapter = {
        ...additiveRegistration,
        id: "@example/duplicate:additive-adapter",
      };
      const selection = [duplicateAdapter, replacementRegistration];
      const preflightFailure = yield* preflightAgentOSRegistrationsEffect(
        selection,
      ).pipe(Effect.flip);
      assert.include(
        preflightFailure.message,
        'AgentOS command "example-ecosystem-status" is claimed by both',
      );
      yield* registerAgentOSRuntimeEffect(fake.pi, selection).pipe(Effect.flip);
      assert.strictEqual(fake.extension.handlers.size, 0);
    }));
});
