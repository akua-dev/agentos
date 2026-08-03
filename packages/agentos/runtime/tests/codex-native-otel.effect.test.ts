import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import {
  Config,
  Effect,
  FileSystem,
  Path,
  Ref,
  Schema,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import {
  acquireBunTestServer,
  readWebRequestText,
} from "../../../../tooling/testing/bun-http.ts";
import { reconcileCodexOtelConfig } from "../codex-otel.ts";

const PINNED_CODEX_VERSION = "codex-cli 0.144.5";
const PINNED_CODEX_UPSTREAM_REVISION =
  "87db9bc18ba5bc82c1cb4e4381b44f693ee35623";
const PROMPT_MARKER = "AGENTOS_CODEX_PROMPT_MUST_NOT_REACH_OTLP";
const RESPONSE_MARKER = "AGENTOS_CODEX_RESPONSE_MUST_NOT_REACH_OTLP";
const PROVIDER_CREDENTIAL = "AGENTOS_CODEX_PROVIDER_CREDENTIAL_MUST_NOT_REACH_OTLP";
const EXPORTER_HEADER = "AGENTOS_CODEX_EXPORTER_HEADER_MUST_NOT_REACH_OTLP";
const UPSTREAM_REQUEST_ID = "req_agentos_codex_otel_61";

interface TelemetryRequest {
  readonly body: string;
  readonly path: string;
}

interface ProviderRequest {
  readonly credentialPresent: boolean;
  readonly traceparent: string | null;
}

class CodexNativeOtelTestError extends Schema.TaggedErrorClass<CodexNativeOtelTestError>()(
  "CodexNativeOtelTestError",
  {
    detail: Schema.String,
    operation: Schema.Literal("process"),
  },
) {}

function testError(
  operation: CodexNativeOtelTestError["operation"],
  detail: string,
) {
  return CodexNativeOtelTestError.make({ detail, operation });
}

const runProcess = Effect.fn("test.codexNativeOtel.runProcess")(function*(
  command: string,
  arguments_: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>>,
  extendEnv = false,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(command, Array.from(arguments_), {
      env: environment,
      extendEnv,
      forceKillAfter: "2 seconds",
      killSignal: "SIGTERM",
      stdin: "ignore",
      stderr: "pipe",
      stdout: "pipe",
    }).pipe(
      Effect.mapError(() => testError("process", `${command} failed to start`)),
    );
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" }).pipe(
      Effect.mapError(() => testError("process", `${command} output failed`)),
    );
    return { exitCode, stderr, stdout };
  }));
});

function codexEnvironment(
  codexHome: string,
  home: string,
  executablePath: string,
) {
  return {
    AGENTOS_CODEX_FIXTURE_KEY: PROVIDER_CREDENTIAL,
    CODEX_HOME: codexHome,
    HOME: home,
    OTEL_EXPORTER_OTLP_TIMEOUT: "100",
    PATH: executablePath,
  };
}

const resolvePinnedCodex = Effect.fn("test.codexNativeOtel.resolvePinnedCodex")(
  function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const repositoryRoot = yield* paths.fromFileUrl(
      new URL("../../../..", import.meta.url),
    );
    const location = yield* runProcess(
      "mise",
      ["where", "npm:@openai/codex@0.144.5"],
      { MISE_TRUSTED_CONFIG_PATHS: repositoryRoot },
      true,
    );
    if (location.exitCode !== 0 || !location.stdout.trim()) {
      return yield* testError(
        "process",
        "AgentOS-pinned Codex 0.144.5 is unavailable through Mise",
      );
    }
    const installRoot = location.stdout.trim();
    const candidates = [
      paths.join(installRoot, "node_modules", ".bin", "codex"),
      paths.join(installRoot, "bin", "codex"),
    ];
    for (const executable of candidates) {
      if (yield* fileSystem.exists(executable)) {
        return executable;
      }
    }
    return yield* testError(
      "process",
      "AgentOS-pinned Codex 0.144.5 is not installed through Mise",
    );
  },
);

const sseResponse = [
  `event: response.created\ndata: {"type":"response.created","response":{"id":"resp-agentos-61"}}\n`,
  `event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","id":"msg-agentos-61","content":[{"type":"output_text","text":"${RESPONSE_MARKER}"}]}}\n`,
  "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-agentos-61\",\"usage\":{\"input_tokens\":1,\"input_tokens_details\":null,\"output_tokens\":1,\"output_tokens_details\":null,\"total_tokens\":2}}}\n",
].join("\n") + "\n";

describe("pinned Codex native OpenTelemetry", () => {
  it.effect(
    `exports logs, traces, and metrics from ${PINNED_CODEX_VERSION} (${PINNED_CODEX_UPSTREAM_REVISION}) without content or credentials`,
    () => Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const executablePath = yield* Config.string("PATH");
      const codex = yield* resolvePinnedCodex();
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-codex-native-otel-",
      });
      const home = paths.join(directory, "home");
      const codexHome = paths.join(home, ".codex");
      const workspace = paths.join(directory, "workspace");
      yield* fileSystem.makeDirectory(codexHome, { recursive: true, mode: 0o700 });
      yield* fileSystem.makeDirectory(workspace, { recursive: true, mode: 0o700 });

      const telemetryRequests = yield* Ref.make<ReadonlyArray<TelemetryRequest>>([]);
      const providerRequests = yield* Ref.make<ReadonlyArray<ProviderRequest>>([]);
      const server = yield* acquireBunTestServer((request) =>
        Effect.gen(function*() {
          const path = new URL(request.url).pathname;
          const body = yield* readWebRequestText(request);
          if (path === "/v1/responses") {
            const attempt = yield* Ref.modify(providerRequests, (current) => [
              current.length,
              [...current, {
                credentialPresent:
                  request.headers.get("authorization") === `Bearer ${PROVIDER_CREDENTIAL}`,
                traceparent: request.headers.get("traceparent"),
              }],
            ]);
            if (attempt === 0) {
              return Response.json({
                error: {
                  code: "server_error",
                  message: "fixture transient failure",
                  type: "server_error",
                },
              }, {
                status: 500,
                headers: {
                  "retry-after": "0",
                  "x-request-id": UPSTREAM_REQUEST_ID,
                },
              });
            }
            return new Response(sseResponse, {
              headers: {
                "content-type": "text/event-stream",
              },
            });
          }
          if (["/v1/logs", "/v1/metrics", "/v1/traces"].includes(path)) {
            yield* Ref.update(telemetryRequests, (current) => [...current, { body, path }]);
            return new Response("{}", {
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(null, { status: 404 });
        }),
      );

      const configPath = paths.join(codexHome, "config.toml");
      yield* fileSystem.writeFileString(configPath, [
        'model_provider = "agentos-fixture"',
        'unrelated_setting = "preserved"',
        "",
        "[model_providers.agentos-fixture]",
        'name = "AgentOS fixture"',
        `base_url = "http://127.0.0.1:${server.port}/v1"`,
        'env_key = "AGENTOS_CODEX_FIXTURE_KEY"',
        'wire_api = "responses"',
        "",
      ].join("\n"), { mode: 0o600 });
      const telemetryEndpoint = `http://127.0.0.1:${server.port}`;
      yield* reconcileCodexOtelConfig(configPath, {
        OTEL_EXPORTER_OTLP_ENDPOINT: telemetryEndpoint,
        OTEL_EXPORTER_OTLP_HEADERS: `x-agentos-test=${EXPORTER_HEADER}`,
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_RESOURCE_ATTRIBUTES:
          "deployment.environment.name=test,service.namespace=agentos",
        OTEL_SDK_DISABLED: "false",
        OTEL_TRACES_EXPORTER: "otlp",
      });

      const environment = codexEnvironment(codexHome, home, executablePath);
      const version = yield* runProcess(codex, ["--version"], environment);
      assert.strictEqual(version.exitCode, 0, version.stderr);
      assert.strictEqual(version.stdout, `${PINNED_CODEX_VERSION}\n`);
      const turn = yield* runProcess(codex, [
        "exec",
        "--skip-git-repo-check",
        "--model",
        "gpt-5.4",
        "-C",
        workspace,
        PROMPT_MARKER,
      ], environment);
      assert.strictEqual(turn.exitCode, 0, turn.stderr);
      assert.include(turn.stdout, RESPONSE_MARKER);
      const providerCalls = yield* Ref.get(providerRequests);
      assert.lengthOf(providerCalls, 2);
      for (const call of providerCalls) {
        assert.isTrue(call.credentialPresent);
        assert.match(
          call.traceparent ?? "",
          /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/,
        );
      }

      const captured = yield* Ref.get(telemetryRequests);
      assert.deepStrictEqual(
        Array.from(new Set(captured.map(({ path }) => path))).sort(),
        ["/v1/logs", "/v1/metrics", "/v1/traces"],
      );
      const signalPayload = (path: string) => captured
        .filter((request) => request.path === path)
        .map(({ body }) => body)
        .join("\n");
      const logs = signalPayload("/v1/logs");
      const metrics = signalPayload("/v1/metrics");
      const traces = signalPayload("/v1/traces");
      assert.include(logs, "codex.api_request");
      assert.include(logs, UPSTREAM_REQUEST_ID);
      assert.include(logs, '"http.response.status_code"');
      assert.include(metrics, "codex.api_request");
      assert.include(metrics, "codex.api_request.duration_ms");
      for (const signal of [logs, metrics, traces]) {
        assert.include(signal, '"service.version"');
        assert.include(signal, "0.144.5");
      }
      const payload = captured.map(({ body }) => body).join("\n");
      for (const forbidden of [
        PROMPT_MARKER,
        RESPONSE_MARKER,
        PROVIDER_CREDENTIAL,
        EXPORTER_HEADER,
      ]) {
        assert.notInclude(payload, forbidden);
      }
      const config = yield* fileSystem.readFileString(configPath);
      assert.include(config, 'unrelated_setting = "preserved"');
      assert.include(config, "log_user_prompt = false");
      assert.strictEqual(Number((yield* fileSystem.stat(configPath)).mode) & 0o777, 0o600);
    })).pipe(Effect.provide(BunServices.layer)),
    60_000,
  );
});
