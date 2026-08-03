import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
} from "effect";

import { acquireBunTestServer } from "../../../../tooling/testing/bun-http.ts";
import { runTestProcess } from "../../tests/test-process.ts";

const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);
const promptFixture = "AGENTOS_PI_OBSERVABILITY_MATRIX_FIXTURE";

const Evidence = Schema.Array(Schema.Struct({
  id: Schema.String,
  input: Schema.Struct({
    runtime: Schema.String,
    route: Schema.String,
    sessionState: Schema.String,
    modelFamily: Schema.String,
    providerFamily: Schema.String,
    runtimeVersion: Schema.optional(Schema.String),
  }),
  attempts: Schema.Array(Schema.Struct({
    id: Schema.String,
    input: Schema.Struct({
      requestKind: Schema.String,
      retryCount: Schema.optional(Schema.Number),
      streamMode: Schema.String,
    }),
    outcome: Schema.optional(Schema.Unknown),
  })),
  outcome: Schema.optional(Schema.Unknown),
}));

interface MatrixRequest {
  readonly attemptId?: string;
  readonly hasAuthorization: boolean;
  readonly traceparent?: string;
}

interface MatrixCell {
  readonly extensionMode: "discovered" | "observability_only";
  readonly route: "direct" | "ai_gateway";
  readonly sessionState: "fresh" | "resumed";
  readonly trial: number;
}

const openAICompletion = [
  "data: {\"id\":\"chatcmpl-agentos-fixture\",\"object\":\"chat.completion.chunk\",\"created\":1785750000,\"model\":\"gpt-5-fixture\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"fixture ok\"},\"finish_reason\":\"stop\"}]}\n\n",
  "data: [DONE]\n\n",
].join("");

const runMatrixCell = Effect.fn("test.piObservability.runMatrixCell")(
  function*(
    root: string,
    port: number,
    cell: MatrixCell,
    requestEvidence: Ref.Ref<ReadonlyArray<MatrixRequest>>,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const executablePath = yield* Config.string("PATH");
    const cellName = [
      cell.extensionMode,
      cell.route,
      cell.sessionState,
      String(cell.trial),
    ].join("-");
    const home = paths.join(root, cellName, "home");
    const agentDirectory = paths.join(home, ".pi", "agent");
    const project = paths.join(root, cellName, "project");
    const extensions = paths.join(agentDirectory, "extensions");
    const recorderPath = yield* paths.fromFileUrl(new URL(
      "../../tests/fixtures/pi-observability-recorder.effect.ts",
      import.meta.url,
    ));
    yield* Effect.forEach(
      [agentDirectory, extensions, project],
      (directory) => fileSystem.makeDirectory(directory, { recursive: true }),
      { discard: true },
    );
    yield* fileSystem.writeFileString(
      paths.join(extensions, "agentos-observability.effect.ts"),
      `export { default } from ${JSON.stringify(recorderPath)};\n`,
    );
    const baseUrl = cell.route === "ai_gateway"
      ? `http://gateway.localhost:${port}/v1`
      : `http://127.0.0.1:${port}/v1`;
    const models = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Unknown),
    )({
      providers: {
        "fixture-openai": {
          api: "openai-completions",
          apiKey: "fixture-private-key",
          baseUrl,
          models: [{
            id: "gpt-5-fixture",
            name: "AgentOS observability fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 16_384,
            maxTokens: 256,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          }],
        },
      },
    });
    yield* fileSystem.writeFileString(
      paths.join(agentDirectory, "models.json"),
      `${models}\n`,
    );
    const settings = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Unknown),
    )({
      defaultProvider: "fixture-openai",
      defaultModel: "gpt-5-fixture",
      defaultThinkingLevel: "off",
      enableInstallTelemetry: false,
      retry: { enabled: false, provider: { maxRetries: 0 } },
    });
    yield* fileSystem.writeFileString(
      paths.join(agentDirectory, "settings.json"),
      `${settings}\n`,
    );

    const sessionId = `matrix-${cellName}`;
    const run = Effect.fn("test.piObservability.runPi")(function*(
      evidenceName: string,
      prompt: string,
    ) {
      const evidencePath = paths.join(root, cellName, evidenceName);
      const args = [
        "--print",
        "--offline",
        "--no-context-files",
        "--approve",
        "--no-tools",
        "--provider",
        "fixture-openai",
        "--model",
        "gpt-5-fixture",
        "--thinking",
        "off",
        "--session-id",
        sessionId,
      ];
      if (cell.extensionMode === "observability_only") {
        args.push("--no-extensions", "--extension", recorderPath);
      }
      args.push(prompt);
      const requestOffset = (yield* Ref.get(requestEvidence)).length;
      const result = yield* runTestProcess("pi", args, {
        cwd: project,
        env: {
          AGENTOS_AGENT_ROLE: "first_mate",
          AGENTOS_TEST_TELEMETRY_FILE: evidencePath,
          HOME: home,
          NO_COLOR: "1",
          OTEL_SDK_DISABLED: "true",
          PATH: executablePath,
          PI_CODING_AGENT_DIR: agentDirectory,
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
        },
      });
      assert.strictEqual(
        result.exitCode,
        0,
        `Pi matrix process failed; stdout/stderr intentionally redacted (${cellName})`,
      );
      assert.isTrue(
        yield* fileSystem.exists(evidencePath),
        `Pi recorder produced no evidence; child output is redacted (${cellName})`,
      );
      const evidenceText = yield* fileSystem.readFileString(evidencePath);
      const evidence = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Evidence),
      )(evidenceText);
      const requests = (yield* Ref.get(requestEvidence)).slice(requestOffset);
      return { evidence, evidenceText, requests };
    });

    if (cell.sessionState === "resumed") {
      yield* run("seed-evidence.json", `${promptFixture}_SEED`);
    }
    return yield* run("evidence.json", promptFixture);
  },
);

layer(platform)("Pi observability control", (it) => {
  it.effect("keeps one privacy-safe attempt in a real pi -ne -e run", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-pi-observability-",
      });
      const requestEvidence = yield* Ref.make<ReadonlyArray<MatrixRequest>>([]);
      const server = yield* acquireBunTestServer((request) => Effect.gen(function*() {
        yield* Ref.update(requestEvidence, (current) => [...current, {
          attemptId: request.headers.get("x-agentos-request-attempt-id") ?? undefined,
          hasAuthorization: request.headers.has("authorization"),
          traceparent: request.headers.get("traceparent") ?? undefined,
        }]);
        return new Response(openAICompletion, {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "req_agentos_fixture",
          },
          status: 200,
        });
      }));
      const result = yield* runMatrixCell(root, server.port, {
        extensionMode: "observability_only",
        route: "direct",
        sessionState: "fresh",
        trial: 1,
      }, requestEvidence);

      assert.strictEqual(result.evidence.length, 1);
      assert.strictEqual(result.evidence[0]?.input.sessionState, "fresh");
      assert.strictEqual(result.evidence[0]?.input.route, "direct");
      assert.strictEqual(result.evidence[0]?.attempts.length, 1);
      assert.strictEqual(
        result.evidence[0]?.attempts[0]?.input.requestKind,
        "main",
      );
      assert.strictEqual(result.evidence[0]?.attempts[0]?.input.retryCount, 0);
      assert.strictEqual(result.requests.length, 1);
      assert.match(
        result.requests[0]?.traceparent ?? "",
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
      );
      assert.strictEqual(
        result.requests[0]?.attemptId,
        result.evidence[0]?.attempts[0]?.id,
      );
      assert.isTrue(result.requests[0]?.hasAuthorization);
      assert.notInclude(result.evidenceText, promptFixture);
      assert.notInclude(result.evidenceText, "fixture-private-key");
    })));

  it.effect("runs the repeated fresh/resumed, discovered/-ne, direct/gateway matrix", () =>
    Effect.scoped(Effect.gen(function*() {
      const enabled = yield* Config.option(
        Config.string("AGENTOS_RUN_PI_OBSERVABILITY_MATRIX"),
      );
      if (Option.getOrUndefined(enabled) !== "true") return;
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-pi-observability-matrix-",
      });
      const requestEvidence = yield* Ref.make<ReadonlyArray<MatrixRequest>>([]);
      const server = yield* acquireBunTestServer((request) => Effect.gen(function*() {
        yield* Ref.update(requestEvidence, (current) => [...current, {
          attemptId: request.headers.get("x-agentos-request-attempt-id") ?? undefined,
          hasAuthorization: request.headers.has("authorization"),
          traceparent: request.headers.get("traceparent") ?? undefined,
        }]);
        return new Response(openAICompletion, {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "req_agentos_fixture",
          },
          status: 200,
        });
      }));
      const extensionModes: ReadonlyArray<MatrixCell["extensionMode"]> = [
        "discovered",
        "observability_only",
      ];
      const sessionStates: ReadonlyArray<MatrixCell["sessionState"]> = [
        "fresh",
        "resumed",
      ];
      const routes: ReadonlyArray<MatrixCell["route"]> = [
        "direct",
        "ai_gateway",
      ];
      const cells: ReadonlyArray<MatrixCell> = [
        ...extensionModes.flatMap((extensionMode) =>
          sessionStates.flatMap((sessionState) =>
            Array.from({ length: 3 }, (_, trial): MatrixCell => ({
              extensionMode,
              route: "direct",
              sessionState,
              trial: trial + 1,
            }))
          )
        ),
        ...routes.flatMap((route) =>
          Array.from({ length: 3 }, (_, trial): MatrixCell => ({
            extensionMode: "observability_only",
            route,
            sessionState: "fresh",
            trial: trial + 101,
          }))
        ),
      ];
      const results = yield* Effect.forEach(
        cells,
        (cell) => runMatrixCell(root, server.port, cell, requestEvidence),
        { concurrency: 1 },
      );

      assert.strictEqual(results.length, 18);
      for (const [index, result] of results.entries()) {
        const cell = cells[index]!;
        assert.strictEqual(result.evidence.length, 1);
        assert.strictEqual(
          result.evidence[0]?.input.sessionState,
          cell.sessionState,
        );
        assert.strictEqual(result.evidence[0]?.input.route, cell.route);
        assert.strictEqual(result.evidence[0]?.attempts.length, 1);
        assert.strictEqual(
          result.evidence[0]?.attempts[0]?.input.requestKind,
          "main",
        );
        assert.strictEqual(result.requests.length, 1);
        assert.strictEqual(
          result.requests[0]?.attemptId,
          result.evidence[0]?.attempts[0]?.id,
        );
      }
    })), 60_000);
});
