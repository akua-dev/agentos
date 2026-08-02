import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";

import { piCommandNames } from "./pi-rpc-test.ts";

const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

const discoveredCommandNames = Effect.fn("test.discovery.commandNames")(
  function*(role: "first_mate" | "second_mate") {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const agentDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: `agentos-default-${role}-`,
    });
    const roleDirectory = role === "first_mate" ? "firstmate" : "secondmate";
    const resources = yield* paths.fromFileUrl(
      new URL(`../resources/roles/${roleDirectory}/`, import.meta.url),
    );
    return yield* piCommandNames({
      agentDirectory,
      cwd: resources,
      role,
    });
  },
);

describe("installed default distribution discovery", () => {
  it.effect("First Mate loads shared and role-only resources through one entrypoint", () =>
    Effect.scoped(Effect.gen(function*() {
      const commands = yield* discoveredCommandNames("first_mate");
      for (const command of [
        "background-commands",
        "memory",
        "skill:agentos-supervision",
        "skill:agentos-observability",
        "skill:agentos-secrets",
        "skill:agentos-bootstrap",
        "skill:agentos-upgrade",
      ]) {
        assert.include(commands, command);
      }
    }).pipe(Effect.provide(platform))));

  it.effect("Second Mate does not receive First-Mate-only Skills", () =>
    Effect.scoped(Effect.gen(function*() {
      const commands = yield* discoveredCommandNames("second_mate");
      for (const command of [
        "background-commands",
        "memory",
        "skill:agentos-supervision",
        "skill:agentos-observability",
        "skill:agentos-secrets",
        "skill:agentos-upgrade",
      ]) {
        assert.include(commands, command);
      }
      assert.notInclude(commands, "skill:agentos-bootstrap");
      assert.notInclude(commands, "skill:agentos-secondmates");
    }).pipe(Effect.provide(platform))));
});
