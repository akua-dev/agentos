#!/usr/bin/env bun

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Layer,
} from "effect";

import {
  GitHubProviderConfig,
  reconcileGitHubProviderConfigurationValue,
} from "./github-provider.ts";

const program = Effect.gen(function*() {
  const [config, home] = yield* Effect.all([
    GitHubProviderConfig,
    Config.string("HOME"),
  ]);
  yield* reconcileGitHubProviderConfigurationValue({ config, home });
}).pipe(
  Effect.tapError(() =>
    Console.error(JSON.stringify({
      event: "agentos.github_provider.reconcile_failed",
    }))
  ),
);

if (import.meta.main) {
  const platform = Layer.mergeAll(
    BunFileSystem.layer,
    BunPath.layer,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
  );
  BunRuntime.runMain(program.pipe(Effect.provide(platform)));
}
