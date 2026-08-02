import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  Runtime,
  Schema,
  Sink,
  Stdio,
} from "effect";

import {
  GitHubAppJwtSigner,
  GitHubTokenHttp,
  type GitHubTokenHttpRequest,
  InstallationTokenScopeSchema,
  mintInstallationToken,
  readInstallationTokenScope,
  runGitHubAppToken,
  writePrivateFileAtomic,
} from "../github-app-token.ts";

const JsonFromString = Schema.fromJsonString(Schema.Unknown);

function signerLayer() {
  return Layer.succeed(
    GitHubAppJwtSigner,
    GitHubAppJwtSigner.of({
      sign: (appId, privateKey, nowSeconds) =>
        Effect.succeed(`signed:${appId}:${privateKey}:${nowSeconds}`),
    }),
  );
}

const capturedStdio = Effect.fn("test.githubAppToken.stdio")(
  function*(args: ReadonlyArray<string>) {
    const output = yield* Ref.make("");
    const layer = Stdio.layerTest({
      args: Effect.succeed(args),
      stdout: () => Sink.forEach((chunk: string | Uint8Array) =>
        Ref.update(output, (current) =>
          current + (typeof chunk === "string"
            ? chunk
            : new TextDecoder().decode(chunk))
        )),
    });
    return { layer, output };
  },
);

function emptyApplicationLayer() {
  return Layer.mergeAll(
    BunServices.layer,
    signerLayer(),
    httpLayer(() => Effect.succeed({ status: 500, body: "{}" })),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
  );
}

function httpLayer(
  execute: (
    request: GitHubTokenHttpRequest,
  ) => Effect.Effect<{ readonly status: number; readonly body: string }>,
) {
  return Layer.succeed(
    GitHubTokenHttp,
    GitHubTokenHttp.of({ execute }),
  );
}

describe("github-app-token", () => {
  it.effect("exposes help without credentials", () =>
    Effect.gen(function*() {
      const stdio = yield* capturedStdio(["--help"]);
      yield* runGitHubAppToken.pipe(
        Effect.provide(stdio.layer),
        Effect.provide(emptyApplicationLayer()),
      );
      const output = yield* Ref.get(stdio.output);
      assert.include(output, "github-app-token");
      assert.include(output, "GITHUB_APP_PRIVATE_KEY_FILE");
    }));

  it.effect("fails before network access when configuration is absent", () =>
    Effect.gen(function*() {
      const stdio = yield* capturedStdio([]);
      const failure = yield* runGitHubAppToken.pipe(
        Effect.provide(stdio.layer),
        Effect.provide(emptyApplicationLayer()),
        Effect.flip,
      );
      assert.strictEqual(failure[Runtime.errorExitCode], 2);
      assert.include(failure.message, "GITHUB_APP_ID");
      assert.strictEqual(yield* Ref.get(stdio.output), "");
    }));

  it.effect("mints through the scoped GitHub App endpoint", () =>
    Effect.gen(function*() {
      const captured = yield* Ref.make<GitHubTokenHttpRequest | undefined>(
        undefined,
      );
      const response = yield* Schema.encodeEffect(JsonFromString)({
        token: "installation-token",
        expires_at: "2026-07-21T22:00:00Z",
      });
      const http = httpLayer((request) =>
        Ref.set(captured, request).pipe(
          Effect.as({ status: 201, body: response }),
        )
      );
      const result = yield* mintInstallationToken({
        apiUrl: "https://api.github.test/base/",
        appId: "4359249",
        installationId: "148117737",
        privateKey: "test-private-key",
      }).pipe(Effect.provide(Layer.mergeAll(signerLayer(), http)));

      assert.strictEqual(result.token, "installation-token");
      const request = yield* Ref.get(captured);
      assert.strictEqual(
        request?.url,
        "https://api.github.test/base/app/installations/148117737/access_tokens",
      );
      assert.strictEqual(request?.scope, undefined);
      assert.match(request?.headers.Authorization ?? "", /^Bearer signed:4359249:/);
      assert.strictEqual(request?.headers["Content-Type"], undefined);
    }));

  it.effect("validates reduced scope and writes private token artifacts", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "github-app-token-scope-",
      });
      const scopeFile = paths.join(directory, "scope.json");
      const tokenFile = paths.join(directory, "token");
      const metadataFile = paths.join(directory, "metadata.json");
      const scopeSource = yield* Schema.encodeEffect(
        Schema.fromJsonString(InstallationTokenScopeSchema),
      )({
        repositories: ["agentos"],
        permissions: { contents: "write", pull_requests: "write" },
      });
      yield* fileSystem.writeFileString(scopeFile, scopeSource, { mode: 0o600 });
      const scope = yield* readInstallationTokenScope(scopeFile);
      const captured = yield* Ref.make<GitHubTokenHttpRequest | undefined>(undefined);
      const response = yield* Schema.encodeEffect(JsonFromString)({
        token: "scoped-installation-token",
        expires_at: "2026-07-21T22:00:00Z",
        permissions: { contents: "write", pull_requests: "write" },
        repository_selection: "selected",
        repositories: [{
          id: 123,
          full_name: "akua-dev/agentos",
          ignored: "provider data",
        }],
      });
      const result = yield* mintInstallationToken({
        apiUrl: "https://api.github.test",
        appId: "4359249",
        installationId: "148117737",
        privateKey: "test-private-key",
        scope,
      }).pipe(Effect.provide(Layer.mergeAll(
        signerLayer(),
        httpLayer((request) =>
          Ref.set(captured, request).pipe(
            Effect.as({ status: 201, body: response }),
          )
        ),
      )));
      const metadata = yield* Schema.encodeEffect(JsonFromString)(result.metadata);
      yield* writePrivateFileAtomic(tokenFile, `${result.token}\n`);
      yield* writePrivateFileAtomic(metadataFile, `${metadata}\n`);

      assert.deepStrictEqual((yield* Ref.get(captured))?.scope, scope);
      assert.strictEqual(
        yield* fileSystem.readFileString(tokenFile),
        "scoped-installation-token\n",
      );
      assert.strictEqual((yield* fileSystem.stat(tokenFile)).mode & 0o777, 0o600);
      assert.strictEqual((yield* fileSystem.stat(metadataFile)).mode & 0o777, 0o600);
      assert.notInclude(
        yield* fileSystem.readFileString(metadataFile),
        "scoped-installation-token",
      );
      assert.deepStrictEqual(result.metadata.repositories, [{
        id: 123,
        full_name: "akua-dev/agentos",
      }]);
    })).pipe(Effect.provide(BunServices.layer)));

  it.effect("rejects ambiguous repository scope before HTTP", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "github-app-token-invalid-",
      });
      const scopeFile = paths.join(directory, "scope.json");
      const source = yield* Schema.encodeEffect(JsonFromString)({
        repositories: ["agentos"],
        repository_ids: [123],
      });
      yield* fileSystem.writeFileString(scopeFile, source, { mode: 0o600 });
      const failure = yield* readInstallationTokenScope(scopeFile).pipe(
        Effect.flip,
      );
      assert.include(
        failure.message,
        "scope must use repositories or repository_ids, not both",
      );
    })).pipe(Effect.provide(BunServices.layer)));

  it.effect("reports provider failure without echoing response secrets", () =>
    Effect.gen(function*() {
      const response = yield* Schema.encodeEffect(JsonFromString)({
        message: "installation access denied",
        token: "must-not-leak",
      });
      const failure = yield* mintInstallationToken({
        apiUrl: "https://api.github.test",
        appId: "4359249",
        installationId: "148117737",
        privateKey: "test-private-key",
      }).pipe(
        Effect.provide(Layer.mergeAll(
          signerLayer(),
          httpLayer(() => Effect.succeed({ status: 403, body: response })),
        )),
        Effect.flip,
      );
      assert.include(failure.message, "403: installation access denied");
      assert.notInclude(failure.message, "must-not-leak");
    }));
});
