import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { reconcileGitHubProviderConfiguration } from "../github-provider.ts";

const platform = Layer.merge(BunFileSystem.layer, BunPath.layer);

function environment(
  mode: "broker" | "direct",
): Readonly<Record<string, string>> {
  return {
    AGENTOS_ASSIGNMENT_ID: "20000000-0000-4000-8000-000000000001",
    AGENTOS_EGRESS_TOKEN_FILE: "/var/run/secrets/agentos-egress/token",
    AGENTOS_GITHUB_CA_FILE: "/var/run/config/agentos-github/ca.pem",
    AGENTOS_GITHUB_ENDPOINT: "https://github.agentos.svc.cluster.local",
    AGENTOS_GITHUB_HOST: "github.agentos.svc.cluster.local",
    AGENTOS_GITHUB_PROVIDER_MODE: mode,
  };
}

describe("GitHub broker home reconciliation", () => {
  it.effect("installs owned native wrappers and a narrow Git include", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-github-home-",
      });
      yield* reconcileGitHubProviderConfiguration({
        environment: environment("broker"),
        home,
      });
      const gh = paths.join(home, ".local", "bin", "gh");
      const ghAxi = paths.join(home, ".local", "bin", "gh-axi");
      assert.include(
        yield* fileSystem.readFileString(gh),
        "agentos-github-workload-auth exec gh",
      );
      assert.include(
        yield* fileSystem.readFileString(ghAxi),
        "agentos-github-workload-auth exec gh-axi",
      );
      assert.strictEqual((yield* fileSystem.stat(gh)).mode & 0o777, 0o700);
      const managed = yield* fileSystem.readFileString(paths.join(
        home,
        ".config",
        "agentos",
        "github-broker.gitconfig",
      ));
      assert.include(
        managed,
        '[url "https://github.agentos.svc.cluster.local/"]',
      );
      assert.include(managed, "insteadOf = https://github.com/");
      assert.include(
        managed,
        "helper = !/usr/local/bin/agentos-github-workload-auth credential",
      );
      assert.include(
        managed,
        "extraHeader = X-AgentOS-Assignment-ID: 20000000-0000-4000-8000-000000000001",
      );
      assert.include(
        yield* fileSystem.readFileString(paths.join(home, ".gitconfig")),
        "github-broker.gitconfig",
      );
      assert.include(
        yield* fileSystem.readFileString(paths.join(
          home,
          ".local",
          "state",
          "agentos",
          "github-provider.json",
        )),
        '"state": "active"',
      );
      assert.strictEqual(
        (yield* fileSystem.stat(paths.join(
          home,
          ".local",
          "state",
          "agentos",
          "github-cli",
        ))).mode & 0o777,
        0o700,
      );
    }).pipe(Effect.provide(platform))));

  it.effect("fails closed on an unowned wrapper collision", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-github-home-",
      });
      const bin = paths.join(home, ".local", "bin");
      const gh = paths.join(bin, "gh");
      yield* fileSystem.makeDirectory(bin, { recursive: true });
      yield* fileSystem.writeFileString(gh, "#!/bin/sh\necho user-owned\n", {
        mode: 0o700,
      });
      const failure = yield* reconcileGitHubProviderConfiguration({
        environment: environment("broker"),
        home,
      }).pipe(Effect.flip);
      assert.strictEqual(failure.code, "managed_state_collision");
      assert.include(yield* fileSystem.readFileString(gh), "user-owned");
    }).pipe(Effect.provide(platform))));

  it.effect("direct rollback removes only AgentOS-owned routing state", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-github-home-",
      });
      const gitconfigPath = paths.join(home, ".gitconfig");
      yield* fileSystem.writeFileString(
        gitconfigPath,
        "[user]\n\tname = Captain\n",
        { mode: 0o600 },
      );
      yield* reconcileGitHubProviderConfiguration({
        environment: environment("broker"),
        home,
      });
      yield* reconcileGitHubProviderConfiguration({
        environment: environment("direct"),
        home,
      });
      const gitconfig = yield* fileSystem.readFileString(gitconfigPath);
      assert.include(gitconfig, "name = Captain");
      assert.notInclude(gitconfig, "github-broker.gitconfig");
      assert.isFalse(
        yield* fileSystem.exists(paths.join(home, ".local", "bin", "gh")),
      );
      assert.include(
        yield* fileSystem.readFileString(paths.join(
          home,
          ".local",
          "state",
          "agentos",
          "github-provider.json",
        )),
        '"state": "direct"',
      );
    }).pipe(Effect.provide(platform))));
});
