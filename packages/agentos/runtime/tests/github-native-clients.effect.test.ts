import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import {
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const platform = Layer.mergeAll(BunServices.layer);

const NativeClientConfig = Config.all({
  agentosImage: Config.string("AGENTOS_RESILIENCE_AGENTOS_IMAGE").pipe(
    Config.withDefault("agentos:dev"),
  ),
  agentosImageDigest: Config.option(
    Config.string("AGENTOS_RESILIENCE_AGENTOS_IMAGE_DIGEST"),
  ),
  bun: Config.string("AGENTOS_BUN_EXECUTABLE").pipe(Config.withDefault("bun")),
  docker: Config.string("AGENTOS_DOCKER_EXECUTABLE").pipe(
    Config.withDefault("docker"),
  ),
  ghAxi: Config.string("AGENTOS_GH_AXI_EXECUTABLE").pipe(
    Config.withDefault("gh-axi"),
  ),
  git: Config.string("AGENTOS_GIT_EXECUTABLE").pipe(Config.withDefault("git")),
  openssl: Config.string("AGENTOS_OPENSSL_EXECUTABLE").pipe(
    Config.withDefault("openssl"),
  ),
  path: Config.string("PATH"),
  hardGate: Config.boolean("AGENTOS_RESILIENCE_HARD_GATE").pipe(
    Config.withDefault(false),
  ),
});

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = Effect.fn("test.githubNativeClients.command")(function*(
  executable: string,
  arguments_: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly environment?: Readonly<Record<string, string>>;
  },
) {
  const command = ChildProcess.make(executable, Array.from(arguments_), {
    cwd: options.cwd,
    env: options.environment,
    extendEnv: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* command;
    const [exitCode, stdout, stderr] = yield* Effect.all([
      handle.exitCode.pipe(Effect.map(Number)),
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stdout, stderr } satisfies CommandResult;
  }));
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function fixtureApplication(observedAuthorizationLengths: Ref.Ref<ReadonlyArray<number>>) {
  return Effect.gen(function*() {
    const request = yield* HttpServerRequest;
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      yield* Ref.update(observedAuthorizationLengths, (current) => [
        ...current,
        authorization.length,
      ]);
    }
    const path = new URL(request.url, "https://fixture.invalid").pathname;
    if (path.endsWith("/info/refs") && authorization === undefined) {
      return HttpServerResponse.text("authentication required\n", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="agentos-fixture"' },
      });
    }
    if (path.startsWith("/api/")) {
      return HttpServerResponse.text(
        '{"message":"native fixture denied"}\n',
        { status: 418, contentType: "application/json" },
      );
    }
    return HttpServerResponse.text("native fixture denied\n", {
      status: 418,
      contentType: "text/plain",
    });
  });
}

layer(platform)("native GitHub client conformance", (it) => {
  it.effect("runs git, gh, and gh-axi through the real projected-identity boundary", () =>
    Effect.scoped(Effect.gen(function*() {
      const config = yield* NativeClientConfig;
      if (!config.hardGate) {
        yield* Console.log(
          "Native GitHub client proof unobserved: resilience hard mode is absent",
        );
        return;
      }
      assert.isTrue(Option.isSome(config.agentosImageDigest));
      if (Option.isNone(config.agentosImageDigest)) return;
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-native-github-",
      });
      const certificate = paths.join(directory, "ca.pem");
      const certificateKey = paths.join(directory, "ca-key.pem");
      const serverCertificate = paths.join(directory, "server.pem");
      const serverCertificateRequest = paths.join(directory, "server.csr");
      const serverExtensions = paths.join(directory, "server.ext");
      const serverPrivateKey = paths.join(directory, "server-key.pem");
      const tokenFile = paths.join(directory, "projected-token");
      const gitconfig = paths.join(directory, "gitconfig");
      const nativeBin = paths.join(directory, "native-bin");
      const dockerGh = paths.join(nativeBin, "gh");
      const miseConfig = paths.resolve("mise.toml");
      const miseLock = paths.resolve("mise.lock");
      const workloadClient = yield* paths.fromFileUrl(
        new URL("../github-workload-auth-main.ts", import.meta.url),
      );
      yield* fileSystem.makeDirectory(nativeBin, { mode: 0o700 });

      const imageInspection = yield* runCommand(config.docker, [
        "image",
        "inspect",
        config.agentosImage,
        "--format",
        "{{.Id}}",
      ], { cwd: directory });
      assert.strictEqual(
        imageInspection.exitCode,
        0,
        imageInspection.stderr,
      );
      const immutableImage = imageInspection.stdout.trim();
      assert.strictEqual(immutableImage, config.agentosImageDigest.value);

      const dockerVolume = `agentos-native-gh-${paths.basename(directory)}`
        .replaceAll(/[^a-zA-Z0-9_.-]/g, "-");
      yield* Effect.acquireRelease(
        runCommand(config.docker, ["volume", "create", dockerVolume], {
          cwd: directory,
        }).pipe(
          Effect.tap((result) =>
            Effect.sync(() =>
              assert.strictEqual(result.exitCode, 0, result.stderr)
            )
          ),
          Effect.as(dockerVolume),
        ),
        (volume) =>
          runCommand(config.docker, ["volume", "rm", "--force", volume], {
            cwd: directory,
          }).pipe(Effect.ignore),
      );

      const certificateResult = yield* runCommand(config.openssl, [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=AgentOS native client fixture CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
        "-keyout",
        certificateKey,
        "-out",
        certificate,
      ], { cwd: directory });
      assert.strictEqual(
        certificateResult.exitCode,
        0,
        certificateResult.stderr,
      );
      const requestResult = yield* runCommand(config.openssl, [
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=127.0.0.1",
        "-keyout",
        serverPrivateKey,
        "-out",
        serverCertificateRequest,
      ], { cwd: directory });
      assert.strictEqual(requestResult.exitCode, 0, requestResult.stderr);
      yield* fileSystem.writeFileString(
        serverExtensions,
        [
          "subjectAltName=IP:127.0.0.1,DNS:host.docker.internal",
          "basicConstraints=critical,CA:FALSE",
          "keyUsage=critical,digitalSignature,keyEncipherment",
          "extendedKeyUsage=serverAuth",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const serverCertificateResult = yield* runCommand(config.openssl, [
        "x509",
        "-req",
        "-in",
        serverCertificateRequest,
        "-CA",
        certificate,
        "-CAkey",
        certificateKey,
        "-CAcreateserial",
        "-days",
        "1",
        "-sha256",
        "-extfile",
        serverExtensions,
        "-out",
        serverCertificate,
      ], { cwd: directory });
      assert.strictEqual(
        serverCertificateResult.exitCode,
        0,
        serverCertificateResult.stderr,
      );
      yield* fileSystem.chmod(certificateKey, 0o600);
      yield* fileSystem.chmod(serverPrivateKey, 0o600);
      yield* fileSystem.chmod(certificate, 0o644);
      yield* fileSystem.chmod(serverCertificate, 0o600);
      const [serverCertificateSource, serverPrivateKeySource] = yield* Effect.all([
        fileSystem.readFileString(serverCertificate),
        fileSystem.readFileString(serverPrivateKey),
      ], { concurrency: 2 });

      const observedAuthorizationLengths = yield* Ref.make<ReadonlyArray<number>>(
        [],
      );
      const server = yield* BunHttpServer.make({
        hostname: "0.0.0.0",
        port: 0,
        tls: { cert: serverCertificateSource, key: serverPrivateKeySource },
      });
      yield* server.serve(fixtureApplication(observedAuthorizationLengths));
      assert.strictEqual(server.address._tag, "TcpAddress");
      if (server.address._tag !== "TcpAddress") return;
      const containerHost = `host.docker.internal:${server.address.port}`;
      const gitHost = `127.0.0.1:${server.address.port}`;
      const continuation = "\\";
      yield* fileSystem.writeFileString(
        dockerGh,
        [
          "#!/bin/sh",
          "set -eu",
          `exec ${shellQuote(config.docker)} run --rm --user 0:0 ${continuation}`,
          "  --add-host host.docker.internal:host-gateway \\",
          "  --env GH_CONFIG_DIR=/tmp/gh-config \\",
          "  --env GH_ENTERPRISE_TOKEN \\",
          "  --env GH_HOST \\",
          "  --env GH_NO_EXTENSION_UPDATE_NOTIFIER=1 \\",
          "  --env GH_NO_UPDATE_NOTIFIER=1 \\",
          "  --env GH_PROMPT_DISABLED=1 \\",
          "  --env HOME=/tmp/home \\",
          "  --env MISE_DATA_DIR=/tmp/mise \\",
          "  --env MISE_GITHUB_GITHUB_ATTESTATIONS=false \\",
          "  --env MISE_GITHUB_SLSA=false \\",
          "  --env MISE_LOCKED=1 \\",
          "  --env MISE_TRUSTED_CONFIG_PATHS=/fixture \\",
          "  --env SSL_CERT_FILE=/fixture/ca.pem \\",
          "  --workdir /fixture \\",
          `  --mount ${shellQuote(`type=bind,source=${certificate},target=/fixture/ca.pem,readonly`)} ${continuation}`,
          `  --mount ${shellQuote(`type=bind,source=${miseConfig},target=/fixture/mise.toml,readonly`)} ${continuation}`,
          `  --mount ${shellQuote(`type=bind,source=${miseLock},target=/fixture/mise.lock,readonly`)} ${continuation}`,
          `  --mount ${shellQuote(`type=volume,source=${dockerVolume},target=/tmp/mise`)} ${continuation}`,
          "  --entrypoint /bin/sh \\",
          `  ${shellQuote(immutableImage)} ${continuation}`,
          "  -c 'if ! SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt mise install --locked gh@2.96.0 >/dev/null 2>/tmp/mise-error; then cat /tmp/mise-error >&2; exit 70; fi; gh_dir=$(SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt mise where gh@2.96.0 2>/dev/null) && exec env SSL_CERT_FILE=/fixture/ca.pem \"$gh_dir\"/*/bin/gh \"$@\"' gh \"$@\"",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const baseEnvironment = {
        AGENTOS_EGRESS_TOKEN_FILE: tokenFile,
        AGENTOS_GITHUB_CA_FILE: certificate,
        AGENTOS_GITHUB_GH_AXI_BIN: config.ghAxi,
        AGENTOS_GITHUB_GH_BIN: dockerGh,
        AGENTOS_GITHUB_HOST: containerHost,
        GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_PROMPT_DISABLED: "1",
        HOME: directory,
      };

      yield* fileSystem.writeFileString(tokenFile, "aaa.bbb.ccc\n", {
        mode: 0o600,
      });
      const gh = yield* runCommand(config.bun, [
        workloadClient,
        "exec",
        "gh",
        "api",
        "repos/acme/repo/issues/94",
      ], { cwd: directory, environment: baseEnvironment });
      assert.notStrictEqual(gh.exitCode, 0);
      assert.include(gh.stderr, "native fixture denied");
      assert.include(gh.stderr, "HTTP 418");

      yield* fileSystem.writeFileString(tokenFile, "aaaa.bbbb.cccc\n", {
        mode: 0o600,
      });
      const ghAxi = yield* runCommand(config.bun, [
        workloadClient,
        "exec",
        "gh-axi",
        "api",
        "repos/acme/repo/issues/94",
      ], { cwd: directory, environment: baseEnvironment });
      assert.notStrictEqual(ghAxi.exitCode, 0);
      assert.include(`${ghAxi.stdout}\n${ghAxi.stderr}`, "native fixture denied");
      assert.include(`${ghAxi.stdout}\n${ghAxi.stderr}`, "418");

      yield* fileSystem.writeFileString(tokenFile, "aaaaa.bbbbb.ccccc\n", {
        mode: 0o600,
      });
      yield* fileSystem.writeFileString(
        gitconfig,
        [
          `[url "https://${gitHost}/"]`,
          "\tinsteadOf = https://github.com/",
          `[credential "https://${gitHost}"]`,
          "\thelper =",
          `\thelper = !${config.bun} ${workloadClient} credential`,
          "\tuseHttpPath = true",
          `[http "https://${gitHost}"]`,
          `\tsslCAInfo = ${certificate}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const git = yield* runCommand(config.git, [
        "ls-remote",
        "https://github.com/acme/repo.git",
      ], {
        cwd: directory,
        environment: {
          ...baseEnvironment,
          AGENTOS_GITHUB_HOST: gitHost,
          GIT_CONFIG_GLOBAL: gitconfig,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      assert.notStrictEqual(git.exitCode, 0);
      assert.include(git.stderr, "418");

      const observed = yield* Ref.get(observedAuthorizationLengths);
      assert.isAtLeast(observed.length, 3);
      assert.isAtLeast(new Set(observed).size, 3);
      assert.notInclude(`${gh.stderr}${ghAxi.stderr}${git.stderr}`, "aaa.bbb.ccc");
      assert.notInclude(`${gh.stderr}${ghAxi.stderr}${git.stderr}`, "aaaa.bbbb.cccc");
      assert.notInclude(`${gh.stderr}${ghAxi.stderr}${git.stderr}`, "aaaaa.bbbbb.ccccc");
      assert.strictEqual(
        yield* fileSystem.exists(paths.join(directory, ".config", "gh", "hosts.yml")),
        false,
      );
    })), 180_000);
});
