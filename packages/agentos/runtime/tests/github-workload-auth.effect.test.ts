import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Ref, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { fileURLToPath } from "node:url";

import {
  GitHubWorkloadClientIo,
  runGitHubWorkloadClient,
} from "../github-workload-auth.ts";

const cli = fileURLToPath(
  new URL("../github-workload-auth-main.ts", import.meta.url),
);
const projectedToken = "header.payload.signature";
const rotatedProjectedToken = "rotated.payload.signature";
const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)),
  ),
);

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runHelper(
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>>,
  input = "",
): Effect.Effect<CommandResult, unknown, never> {
  const command = ChildProcess.make(process.execPath, [cli, ...args], {
    env: { ...environment },
    extendEnv: false,
    stdin: Stream.make(new TextEncoder().encode(input)),
    stdout: "pipe",
    stderr: "pipe",
  });
  return Effect.scoped(Effect.gen(function*() {
    const handle = yield* command;
    const [exitCode, stdout, stderr] = yield* Effect.all([
      handle.exitCode.pipe(Effect.map(Number)),
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stdout, stderr };
  })).pipe(Effect.provide(platform));
}

function helperEnvironment(
  home: string,
  tokenFile: string,
  values: Readonly<Record<string, string>> = {},
) {
  return {
    AGENTOS_EGRESS_TOKEN_FILE: tokenFile,
    AGENTOS_GITHUB_CA_FILE: "/var/run/config/agentos-github/ca.pem",
    AGENTOS_GITHUB_HOST: "github.agentos.test",
    HOME: home,
    PATH: "/usr/bin:/bin",
    ...values,
  };
}

describe("GitHub workload client helper", () => {
  it.effect("serves Git credential protocol from the current projected token", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-github-client-",
      });
      const tokenFile = paths.join(directory, "token");
      yield* fileSystem.writeFileString(tokenFile, `${projectedToken}\n`, {
        mode: 0o440,
      });
      const output = yield* Ref.make("");
      const io = GitHubWorkloadClientIo.of({
        readInput: Effect.succeed(
          "protocol=https\nhost=github.agentos.test\npath=akua-dev/agentos.git\nwwwauth[]=Basic realm=github\nwwwauth[]=Bearer realm=github\n\n",
        ),
        writeOutput: (value) => Ref.set(output, value),
      });
      const exitCode = yield* runGitHubWorkloadClient(
        ["credential", "get"],
        {
          caFile: "/var/run/config/agentos-github/ca.pem",
          home: directory,
          host: "github.agentos.test",
          path: "/usr/bin:/bin",
          tokenFile,
        },
      ).pipe(Effect.provideService(GitHubWorkloadClientIo, io));
      assert.strictEqual(exitCode, 0);
      const stdout = yield* Ref.get(output);
      assert.strictEqual(
        stdout,
        `username=x-access-token\npassword=${projectedToken}\n\n`,
      );
      assert.notInclude(stdout, tokenFile);

      yield* fileSystem.remove(tokenFile);
      yield* fileSystem.writeFileString(
        tokenFile,
        `${rotatedProjectedToken}\n`,
        { mode: 0o440 },
      );
      assert.strictEqual(
        yield* runGitHubWorkloadClient(
          ["credential", "get"],
          {
            caFile: "/var/run/config/agentos-github/ca.pem",
            home: directory,
            host: "github.agentos.test",
            path: "/usr/bin:/bin",
            tokenFile,
          },
        ).pipe(
          Effect.provideService(GitHubWorkloadClientIo, io),
          Effect.andThen(Ref.get(output)),
        ),
        `username=x-access-token\npassword=${rotatedProjectedToken}\n\n`,
      );
    }).pipe(Effect.provide(platform))));

  it.effect("passes a fresh workload identity only in the native client environment", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-github-client-",
      });
      const tokenFile = paths.join(directory, "token");
      const fakeGh = paths.join(directory, "gh");
      yield* fileSystem.writeFileString(tokenFile, `${projectedToken}\n`, {
        mode: 0o440,
      });
      yield* fileSystem.writeFileString(
        fakeGh,
        [
          "#!/bin/sh",
          "test \"$GH_HOST\" = github.agentos.test || exit 41",
          `test \"$GH_ENTERPRISE_TOKEN\" = ${projectedToken} || exit 42`,
          "test -z \"$GH_TOKEN\" || exit 43",
          "test -z \"$GITHUB_TOKEN\" || exit 44",
          "case \"$*\" in *header.payload.signature*) exit 45 ;; esac",
          "printf 'native-ok\\n'",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const result = yield* runHelper(
        ["exec", "gh", "api", "repos/akua-dev/agentos"],
        helperEnvironment(directory, tokenFile, {
          AGENTOS_GITHUB_GH_BIN: fakeGh,
        }),
      );
      assert.deepStrictEqual(result, {
        exitCode: 0,
        stdout: "native-ok\n",
        stderr: "",
      });
    }).pipe(Effect.provide(platform))));

  it.effect("preserves native stderr and exit status without leaking identity", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-github-client-",
      });
      const tokenFile = paths.join(directory, "token");
      const fakeGh = paths.join(directory, "gh");
      yield* fileSystem.writeFileString(tokenFile, `${projectedToken}\n`, {
        mode: 0o440,
      });
      yield* fileSystem.writeFileString(
        fakeGh,
        "#!/bin/sh\necho 'native provider failure' >&2\nexit 17\n",
        { mode: 0o700 },
      );
      const result = yield* runHelper(
        ["exec", "gh", "repo", "view"],
        helperEnvironment(directory, tokenFile, {
          AGENTOS_GITHUB_GH_BIN: fakeGh,
        }),
      );
      assert.strictEqual(result.exitCode, 17);
      assert.strictEqual(result.stdout, "");
      assert.strictEqual(result.stderr, "native provider failure\n");
      assert.notInclude(result.stderr, projectedToken);
    }).pipe(Effect.provide(platform))));
});
