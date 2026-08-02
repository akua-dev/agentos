import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";

import { runTestProcess } from "./test-process.ts";

const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

describe("@akua-dev/agentos module load", () => {
  it.effect("is inert before Pi invokes its exported factory", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const executablePath = yield* Config.string("PATH");
      const home = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-default-import-",
      });
      const environment = { HOME: home, PATH: executablePath };
      const baselineModule = new URL("./manifest-contract.ts", import.meta.url).href;
      const baseline = yield* runTestProcess(
        "bun",
        [
          "--eval",
          `import { AgentOSPackageManifest } from ${JSON.stringify(baselineModule)}; console.log(typeof AgentOSPackageManifest);`,
        ],
        { cwd: home, env: environment },
      );
      assert.deepStrictEqual(baseline, {
        exitCode: 0,
        stderr: "",
        stdout: "function\n",
      });
      const beforeImport = yield* fileSystem.readDirectory(home);
      const entrypoint = new URL("../extensions/agentos.ts", import.meta.url).href;
      const result = yield* runTestProcess(
        "bun",
        [
          "--eval",
          `import entrypoint from ${JSON.stringify(entrypoint)}; console.log(typeof entrypoint);`,
        ],
        { cwd: home, env: environment },
      );

      assert.deepStrictEqual(result, {
        exitCode: 0,
        stderr: "",
        stdout: "function\n",
      });
      assert.deepStrictEqual(yield* fileSystem.readDirectory(home), beforeImport);
    }).pipe(Effect.provide(platform))));
});
