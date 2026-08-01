#!/usr/bin/env bun

import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Layer,
  Option,
} from "effect";

import {
  GitHubWorkloadClientError,
  GitHubWorkloadClientIo,
  runGitHubWorkloadClient,
} from "./github-workload-auth.ts";

const WorkloadClientConfig = Config.all({
  caFile: Config.string("AGENTOS_GITHUB_CA_FILE"),
  ghAxiBinary: Config.string("AGENTOS_GITHUB_GH_AXI_BIN").pipe(Config.option),
  ghBinary: Config.string("AGENTOS_GITHUB_GH_BIN").pipe(Config.option),
  home: Config.string("HOME"),
  host: Config.string("AGENTOS_GITHUB_HOST"),
  tokenFile: Config.string("AGENTOS_EGRESS_TOKEN_FILE"),
});

const io = Layer.succeed(GitHubWorkloadClientIo)({
  readInput: Effect.tryPromise({
    try: () => new Response(Bun.stdin.stream()).text(),
    catch: () => GitHubWorkloadClientError.make({
      code: "invalid_credential_request",
    }),
  }),
  writeOutput: (value) =>
    Effect.sync(() => {
      process.stdout.write(value);
    }),
});

const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  BunChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)),
  ),
  ConfigProvider.layer(ConfigProvider.fromEnv()),
  io,
);

const program = Effect.gen(function*() {
  const config = yield* WorkloadClientConfig;
  return yield* runGitHubWorkloadClient(process.argv.slice(2), {
    caFile: config.caFile,
    ghAxiBinary: Option.getOrUndefined(config.ghAxiBinary),
    ghBinary: Option.getOrUndefined(config.ghBinary),
    home: config.home,
    host: config.host.toLowerCase(),
    tokenFile: config.tokenFile,
  });
}).pipe(
  Effect.catch((error) =>
    Console.error(
      `agentos-github-workload-auth: ${
        error instanceof GitHubWorkloadClientError
          ? error.code
          : "invalid_configuration"
      }`,
    ).pipe(Effect.as(1))
  ),
  Effect.tap((exitCode) =>
    Effect.sync(() => {
      process.exitCode = exitCode;
    })
  ),
  Effect.provide(platform),
);

if (import.meta.main) {
  BunRuntime.runMain(program);
}
