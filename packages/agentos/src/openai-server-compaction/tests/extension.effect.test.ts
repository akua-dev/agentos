import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { describe, expect, it } from "@effect/vitest";
import type {
  CompactionResult,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
} from "effect";

import {
  createOpenAIServerCompactionExtension,
  generateBestEffortLocalSummary,
  registerOpenAIServerCompactionEffect,
  type LocalCompactionRequest,
  type LocalSummaryImplementations,
  type OpenAIServerCompactionDependencies,
} from "../extension.ts";
import {
  OpenAICompactionHttpError,
  type OpenAICompactionModel,
  type ServerCompactionRequest,
  type ServerCompactionResult,
} from "../remote.ts";
import {
  ResponseItemsSchema,
  type CompactionArtifact,
} from "../schemas.ts";
import { nativeCompactionDetails } from "../session.ts";
import { runAgentOSPiProgram } from "../../pi-host-adapter.ts";
import { createTelemetryRecorder } from "../../telemetry/tests/fake-telemetry.ts";
import { makePiTestHarness } from "../../../tests/pi-test-harness.ts";

const enabledConfig = Effect.succeed({ enabled: true });
const fileSystemLayer = Layer.merge(BunFileSystem.layer, BunPath.layer);
const JsonString = Schema.fromJsonString(Schema.Unknown);

function codexModel(): OpenAICompactionModel {
  return {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "http://gateway:8787",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100_000,
  };
}

function directModel(): OpenAICompactionModel {
  return {
    ...codexModel(),
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  };
}

const defaultBranch: SessionEntry[] = [
  {
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "hello", timestamp: 1 },
  },
];

function compactionEvent(
  overrides: Partial<SessionBeforeCompactEvent> = {},
): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "m1",
      messagesToSummarize: [],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 100,
      fileOps: {
        read: new Set<string>(),
        written: new Set<string>(),
        edited: new Set<string>(),
      },
      settings: {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
      },
    },
    branchEntries: [],
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const local: CompactionResult = {
  summary: "portable summary",
  firstKeptEntryId: "m1",
  tokensBefore: 100,
  estimatedTokensAfter: 20,
  details: { readFiles: ["a.ts"] },
  usage: {
    input: 2,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

type HarnessOptions = {
  readonly auth?: {
    readonly ok: true;
    readonly apiKey?: string;
    readonly headers?: Record<string, string>;
  };
  readonly branch?: SessionEntry[];
  readonly model?: OpenAICompactionModel;
  readonly notify?: (message: string) => void;
  readonly sessionId?: string;
};

function harness(
  dependencies: OpenAIServerCompactionDependencies,
  options: HarnessOptions = {},
) {
  return Effect.gen(function*() {
    const state = {
      branch: options.branch ?? defaultBranch,
      model: options.model ?? codexModel(),
      sessionId: options.sessionId ?? "session-1",
    };
    const auth = options.auth ?? {
      ok: true,
      apiKey: "token",
      headers: {},
    };
    const fake = yield* makePiTestHarness({
      systemPrompt: "system",
      context: {
        model: state.model,
        modelRegistry: {
          getApiKeyAndHeaders: () => runAgentOSPiProgram(Effect.succeed(auth)),
        },
        sessionManager: {
          getBranch: () => state.branch,
          getSessionId: () => state.sessionId,
        },
        getSystemPrompt: () => "system",
        hasUI: true,
        ui: {
          notify: (message: string) => options.notify?.(message),
        },
      },
    });
    Object.assign(fake.pi, {
      getAllTools: () => [],
      getActiveTools: () => [],
      getThinkingLevel: () => "high",
    });
    yield* registerOpenAIServerCompactionEffect(fake.pi, dependencies);

    const emit = (name: string, event: object) =>
      fake.emit(name, { ...event }).pipe(
        Effect.map((results) => results[0]),
      );
    const setModel = (model: OpenAICompactionModel) =>
      Effect.sync(() => {
        state.model = model;
        Object.assign(fake.context, { model });
      });
    const setSessionId = (sessionId: string) =>
      Effect.sync(() => {
        state.sessionId = sessionId;
      });

    return { emit, fake, setModel, setSessionId };
  });
}

function dependencies(
  options: {
    readonly local?: (
      request: LocalCompactionRequest,
    ) => Effect.Effect<CompactionResult, unknown>;
    readonly remote?: (
      request: ServerCompactionRequest,
    ) => Effect.Effect<ServerCompactionResult, unknown>;
    readonly telemetry?: OpenAIServerCompactionDependencies["telemetry"];
    readonly workloadIdentity?: OpenAIServerCompactionDependencies["workloadIdentity"];
  } = {},
): OpenAIServerCompactionDependencies {
  return {
    config: enabledConfig,
    runLocalCompaction: options.local ?? (() => Effect.succeed(local)),
    runServerCompaction: options.remote ??
      (() =>
        Effect.succeed({
          output: [{ type: "compaction", encrypted_content: "opaque" }],
        })),
    telemetry: options.telemetry,
    workloadIdentity: options.workloadIdentity,
  };
}

function responseItems(value: unknown) {
  return Schema.decodeUnknownEffect(ResponseItemsSchema)(value).pipe(
    Effect.orDie,
  );
}

describe("AgentOS OpenAI server-compaction Effect extension", () => {
  it.effect("attributes portable and native attempts and persists combined usage", () =>
    Effect.gen(function*() {
      const recorded = createTelemetryRecorder();
      const runtime = yield* harness(dependencies({
        telemetry: recorded.telemetry,
        remote: () =>
          Effect.succeed({
            output: [{ type: "compaction", encrypted_content: "opaque" }],
            usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
            providerRequestId: "req_safe_compaction_1",
          }),
      }));

      const result = yield* runtime.emit(
        "session_before_compact",
        compactionEvent(),
      );

      expect(recorded.operations).toHaveLength(1);
      expect(recorded.operations[0]?.input).toMatchObject({
        modelFamily: "gpt-5",
        providerFamily: "openai",
        route: "ai_gateway",
        runtime: "pi",
        sessionState: "resumed",
      });
      expect(recorded.operations[0]?.attempts).toEqual([
        {
          input: {
            compactionPath: "portable_summary",
            requestKind: "compaction",
            streamMode: "non_streaming",
          },
          outcome: {
            inputTokens: 2,
            outputTokens: 3,
            status: 200,
            streamOutcome: "completed",
          },
        },
        {
          input: {
            compactionPath: "native_server",
            requestKind: "compaction",
            streamMode: "streaming",
          },
          outcome: {
            inputTokens: 10,
            outputTokens: 1,
            providerRequestId: "req_safe_compaction_1",
            status: 200,
            streamOutcome: "completed",
          },
        },
      ]);
      expect(recorded.operations[0]?.outcome).toEqual({ status: 200 });
      expect(result).toEqual({
        compaction: {
          ...local,
          usage: {
            input: 12,
            output: 4,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 16,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          details: {
            readFiles: ["a.ts"],
            agentosOpenAIServerCompaction: {
              version: 2,
              implementation: "responses_compaction_v2",
              provider: "openai-codex",
              api: "openai-codex-responses",
              model: "gpt-5.4",
              replacementInput: [
                { type: "compaction", encrypted_content: "opaque" },
              ],
              usage: {
                input_tokens: 10,
                output_tokens: 1,
                total_tokens: 11,
              },
            },
          },
        },
      });
    }),
  );

  it.effect("records non-streaming native attribution for direct OpenAI", () =>
    Effect.gen(function*() {
      const recorded = createTelemetryRecorder();
      const runtime = yield* harness(
        dependencies({ telemetry: recorded.telemetry }),
        { model: directModel() },
      );

      yield* runtime.emit("session_before_compact", compactionEvent());

      expect(
        recorded.operations[0]?.attempts.map(({ input }) => input.streamMode),
      ).toEqual(["non_streaming", "non_streaming"]);
    }),
  );

  it.effect("uses the portable summary when native compaction fails", () =>
    Effect.gen(function*() {
      const recorded = createTelemetryRecorder();
      const warnings: string[] = [];
      const runtime = yield* harness(
        dependencies({
          telemetry: recorded.telemetry,
          remote: () => Effect.fail(new OpenAICompactionHttpError(503)),
        }),
        {
          notify: (message) => warnings.push(message),
        },
      );

      const result = yield* runtime.emit(
        "session_before_compact",
        compactionEvent(),
      );

      expect(result).toEqual({ compaction: local });
      expect(warnings).toEqual([
        "OpenAI server compaction unavailable; using Pi's portable summary.",
      ]);
      expect(recorded.operations[0]?.attempts[1]?.outcome).toMatchObject({
        status: 503,
        error: { _tag: "OpenAICompactionHttpError", status: 503 },
        streamOutcome: "upstream_error",
      });
      expect(recorded.operations[0]?.outcome).toEqual({ status: 200 });
    }),
  );

  it.effect("lets Pi own compaction when the portable path fails", () =>
    Effect.gen(function*() {
      const runtime = yield* harness(dependencies({
        local: () => Effect.fail("local failed"),
      }));

      expect(
        yield* runtime.emit("session_before_compact", compactionEvent()),
      ).toBeUndefined();
    }),
  );

  it.effect("merges model and resolved headers with authoritative authentication", () =>
    Effect.gen(function*() {
      const recorded = createTelemetryRecorder();
      const localRequest = yield* Ref.make<Option.Option<LocalCompactionRequest>>(
        Option.none(),
      );
      const remoteRequest = yield* Ref.make<Option.Option<ServerCompactionRequest>>(
        Option.none(),
      );
      const model = {
        ...codexModel(),
        headers: {
          "X-Model-Feature": "enabled",
          Authorization: "Bearer configured-token",
        },
      };
      const runtime = yield* harness(
        dependencies({
          telemetry: recorded.telemetry,
          local: (request) =>
            Ref.set(localRequest, Option.some(request)).pipe(Effect.as(local)),
          remote: (request) =>
            Ref.set(remoteRequest, Option.some(request)).pipe(
              Effect.as({
                output: [{ type: "compaction", encrypted_content: "opaque" }],
              }),
            ),
        }),
        {
          model,
          auth: {
            ok: true,
            apiKey: "resolved-token",
            headers: {
              authorization: "Bearer resolved-header",
              "X-Resolved": "yes",
            },
          },
        },
      );

      yield* runtime.emit("session_before_compact", compactionEvent());

      const capturedLocal = Option.getOrUndefined(yield* Ref.get(localRequest));
      const capturedRemote = Option.getOrUndefined(yield* Ref.get(remoteRequest));
      expect(capturedRemote?.headers).toMatchObject({
        "X-Model-Feature": "enabled",
        authorization: "Bearer resolved-header",
        "X-Resolved": "yes",
        "x-agentos-request-attempt-id": "attempt-3",
      });
      expect(capturedLocal?.auth.headers).toMatchObject({
        "X-Model-Feature": "enabled",
        authorization: "Bearer resolved-header",
        "X-Resolved": "yes",
        "x-agentos-request-attempt-id": "attempt-2",
      });
      expect(capturedLocal?.auth.headers).not.toBe(capturedRemote?.headers);
    }),
  );

  it.effect("uses projected workload identity for internal Gateway requests", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "agentos-compaction-identity-",
        });
        const tokenFile = paths.join(directory, "token");
        const token =
          "eyJhbGciOiJFZERTQSJ9.eyJhdWQiOiJhZ2VudG9zLWVncmVzcyJ9.signature";
        const assignmentId = "11111111-1111-4111-8111-111111111111";
        yield* fileSystem.writeFileString(tokenFile, token, { mode: 0o400 });
        const localRequest = yield* Ref.make<Option.Option<LocalCompactionRequest>>(
          Option.none(),
        );
        const remoteRequest = yield* Ref.make<Option.Option<ServerCompactionRequest>>(
          Option.none(),
        );
        const runtime = yield* harness(
          dependencies({
            workloadIdentity: {
              environment: {
                AGENTOS_PI_PROVIDER_MODE: "ai-gateway",
                AI_GATEWAY_URL: "http://gateway:8787",
                AGENTOS_ASSIGNMENT_ID: assignmentId,
              },
              tokenFile,
            },
            local: (request) =>
              Ref.set(localRequest, Option.some(request)).pipe(Effect.as(local)),
            remote: (request) =>
              Ref.set(remoteRequest, Option.some(request)).pipe(
                Effect.as({
                  output: [
                    { type: "compaction", encrypted_content: "opaque" },
                  ],
                }),
              ),
          }),
          {
            auth: {
              ok: true,
              apiKey: "agentos-workload-identity",
              headers: {
                Authorization: "Bearer forged-placeholder",
                "X-AgentOS-Authz-Decision-Ref": "forged-decision",
              },
            },
          },
        );

        yield* runtime.emit("session_before_compact", compactionEvent());

        const expectedIdentity = {
          authorization: `Bearer ${token}`,
          "x-agentos-assignment-id": assignmentId,
        };
        const capturedLocal = Option.getOrUndefined(yield* Ref.get(localRequest));
        const capturedRemote = Option.getOrUndefined(yield* Ref.get(remoteRequest));
        expect(capturedLocal?.auth.apiKey).toBeUndefined();
        expect(capturedLocal?.auth.headers).toEqual(expectedIdentity);
        expect(capturedRemote?.apiKey).toBeUndefined();
        expect(capturedRemote?.headers).toEqual(expectedIdentity);
      }),
    ).pipe(Effect.provide(fileSystemLayer)),
  );

  it.effect("keeps portable instructions local and normalizes native replay input", () =>
    Effect.gen(function*() {
      const artifact = {
        type: "compaction",
        encrypted_content: "opaque-normalized",
      } satisfies CompactionArtifact;
      const replacementInput = yield* responseItems([
        { type: "ghost_snapshot", state: "remove" },
        {
          type: "function_call",
          call_id: "call-1",
          name: "read",
          arguments: "{}",
        },
        artifact,
      ]);
      const entries: SessionEntry[] = [
        ...defaultBranch,
        {
          type: "compaction",
          id: "c1",
          parentId: "m1",
          timestamp: "2026-01-01T00:00:01.000Z",
          summary: "portable",
          firstKeptEntryId: "m1",
          tokensBefore: 100,
          details: nativeCompactionDetails(
            "openai-codex",
            "openai-codex-responses",
            "gpt-5.4",
            replacementInput,
          ),
        },
      ];
      const captured = yield* Ref.make<Option.Option<ServerCompactionRequest>>(
        Option.none(),
      );
      const runtime = yield* harness(
        dependencies({
          remote: (request) =>
            Ref.set(captured, Option.some(request)).pipe(
              Effect.as({ output: [artifact] }),
            ),
        }),
        { branch: entries },
      );

      yield* runtime.emit(
        "session_before_compact",
        compactionEvent({
          branchEntries: entries,
          customInstructions: "Keep the deployment caveat.",
        }),
      );

      const request = Option.getOrUndefined(yield* Ref.get(captured));
      expect(request?.instructions).toBe("system");
      expect(request?.input).toEqual([
        {
          type: "function_call",
          call_id: "call-1",
          name: "read",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "aborted",
        },
        artifact,
      ]);
    }),
  );

  it.effect("reuses validated request shape only for its session and model", () =>
    Effect.gen(function*() {
      const requests = yield* Ref.make<ReadonlyArray<ServerCompactionRequest>>([]);
      const runtime = yield* harness(dependencies({
        remote: (request) =>
          Ref.update(requests, (values) => [...values, request]).pipe(
            Effect.as({
              output: [{ type: "compaction", encrypted_content: "opaque" }],
            }),
          ),
      }));
      yield* runtime.emit("before_provider_request", {
        type: "before_provider_request",
        payload: {
          model: "gpt-5.4",
          input: [],
          reasoning: { effort: "low", summary: "detailed" },
          text: { verbosity: "low" },
        },
      });
      yield* runtime.emit("session_before_compact", compactionEvent());
      yield* runtime.emit("session_before_compact", compactionEvent());
      yield* runtime.emit("before_provider_request", {
        type: "before_provider_request",
        payload: {
          model: "gpt-5.4",
          input: [],
          text: { verbosity: "high" },
        },
      });
      yield* runtime.setSessionId("session-2");
      yield* runtime.emit("session_before_compact", compactionEvent());

      const captured = yield* Ref.get(requests);
      expect(captured[0]).toMatchObject({
        reasoning: { effort: "low", summary: "detailed" },
        text: { verbosity: "low" },
      });
      expect(captured[1]?.text).toBeUndefined();
      expect(captured[1]?.reasoning).toEqual({ effort: "high", summary: "auto" });
      expect(captured[2]?.text).toBeUndefined();
    }),
  );

  it.effect("clears request shape at every lifecycle boundary", () =>
    Effect.gen(function*() {
      const resets: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ["session_start", { type: "session_start", reason: "reload" }],
        [
          "session_before_switch",
          { type: "session_before_switch", reason: "resume" },
        ],
        [
          "session_before_fork",
          { type: "session_before_fork", entryId: "m1", position: "at" },
        ],
        [
          "session_before_tree",
          {
            type: "session_before_tree",
            preparation: {},
            signal: new AbortController().signal,
          },
        ],
        [
          "session_tree",
          { type: "session_tree", newLeafId: "m1", oldLeafId: "m0" },
        ],
        ["session_compact", { type: "session_compact", reason: "manual" }],
        ["model_select", { type: "model_select", source: "user" }],
        ["session_shutdown", { type: "session_shutdown", reason: "reload" }],
      ];

      yield* Effect.forEach(resets, ([name, resetEvent]) =>
        Effect.gen(function*() {
          const captured = yield* Ref.make<Option.Option<ServerCompactionRequest>>(
            Option.none(),
          );
          const runtime = yield* harness(dependencies({
            remote: (request) =>
              Ref.set(captured, Option.some(request)).pipe(
                Effect.as({
                  output: [
                    { type: "compaction", encrypted_content: `opaque-${name}` },
                  ],
                }),
              ),
          }));
          yield* runtime.emit("before_provider_request", {
            type: "before_provider_request",
            payload: {
              model: "gpt-5.4",
              input: [],
              text: { verbosity: "low" },
            },
          });
          yield* runtime.emit(name, resetEvent);
          yield* runtime.emit("session_before_compact", compactionEvent());
          expect(
            Option.getOrUndefined(yield* Ref.get(captured))?.text,
            name,
          ).toBeUndefined();
        })
      );
    }),
  );

  it.effect("registers inert handlers and replays persisted provider state", () =>
    Effect.gen(function*() {
      const providerCalls = yield* Ref.make(0);
      const artifact = {
        type: "compaction",
        encrypted_content: "opaque",
      } satisfies CompactionArtifact;
      const entries: SessionEntry[] = [
        ...defaultBranch,
        {
          type: "compaction",
          id: "c1",
          parentId: "m1",
          timestamp: "2026-01-01T00:00:01.000Z",
          summary: "portable",
          firstKeptEntryId: "m1",
          tokensBefore: 100,
          details: nativeCompactionDetails(
            "openai-codex",
            "openai-codex-responses",
            "gpt-5.4",
            [artifact],
          ),
        },
        {
          type: "message",
          id: "m2",
          parentId: "c1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "user", content: "new", timestamp: 2 },
        },
      ];
      const runtime = yield* harness(
        dependencies({
          local: () => Ref.update(providerCalls, (value) => value + 1).pipe(
            Effect.as(local),
          ),
          remote: () => Ref.update(providerCalls, (value) => value + 1).pipe(
            Effect.as({ output: [artifact] }),
          ),
        }),
        { branch: entries },
      );

      expect(yield* Ref.get(providerCalls)).toBe(0);
      expect(
        [...runtime.fake.extension.handlers.keys()].sort(),
      ).toEqual([
        "before_provider_request",
        "model_select",
        "session_before_compact",
        "session_before_fork",
        "session_before_switch",
        "session_before_tree",
        "session_compact",
        "session_shutdown",
        "session_start",
        "session_tree",
      ]);
      expect(yield* runtime.emit("before_provider_request", {
        type: "before_provider_request",
        payload: { model: "gpt-5.4", input: [] },
      })).toEqual({
        model: "gpt-5.4",
        input: [
          artifact,
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "new" }],
          },
        ],
      });
      expect(yield* Ref.get(providerCalls)).toBe(0);
    }),
  );

  it.effect("summarizes every branch message with the portable request", () =>
    Effect.gen(function*() {
      const completion = yield* Ref.make<Option.Option<unknown>>(Option.none());
      const completionOptions = yield* Ref.make<Option.Option<unknown>>(
        Option.none(),
      );
      const implementations: LocalSummaryImplementations = {
        complete: (_model, value, options) =>
          Ref.set(completion, Option.some(value)).pipe(
            Effect.andThen(Ref.set(completionOptions, Option.some(options))),
            Effect.as({
              role: "assistant",
              content: [{ type: "text", text: " full branch summary " }],
              api: "openai-codex-responses",
              provider: "openai-codex",
              model: "gpt-5.4",
              usage: {
                input: 10,
                output: 4,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 14,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: "stop",
              timestamp: 3,
            }),
          ),
        compact: () => Effect.die("Pi fallback must not run"),
        now: Effect.succeed(42),
      };
      const branchEntries: SessionEntry[] = [
        {
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "old goal", timestamp: 1 },
        },
        {
          type: "compaction",
          id: "c1",
          parentId: "m1",
          timestamp: "2026-01-01T00:00:01.000Z",
          summary: "must not replace the branch",
          firstKeptEntryId: "m1",
          tokensBefore: 50,
        },
        {
          type: "message",
          id: "m2",
          parentId: "c1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: { role: "user", content: "new decision", timestamp: 2 },
        },
      ];
      const result = yield* generateBestEffortLocalSummary(
        {
          event: compactionEvent({
            customInstructions: "Keep the deployment caveat.",
            branchEntries,
          }),
          model: codexModel(),
          auth: {
            apiKey: "resolved-token",
            headers: { "x-attempt": "portable" },
            env: { OPENAI_API_KEY: "scoped-token" },
          },
          thinkingLevel: "high",
        },
        implementations,
      );

      expect(result).toEqual({
        summary: "full branch summary",
        firstKeptEntryId: "m1",
        tokensBefore: 100,
      });
      expect(Option.getOrUndefined(yield* Ref.get(completion))).toMatchObject({
        messages: [
          {
            timestamp: 42,
            content: [
              {
                text: expect.stringContaining("old goal"),
              },
            ],
          },
        ],
      });
      const completionValue = yield* Schema.encodeEffect(JsonString)(
        Option.getOrUndefined(yield* Ref.get(completion)),
      ).pipe(Effect.orDie);
      expect(completionValue).toContain("old goal");
      expect(completionValue).toContain("new decision");
      expect(completionValue).toContain("Keep the deployment caveat.");
      expect(completionValue).not.toContain("must not replace the branch");
      expect(Option.getOrUndefined(yield* Ref.get(completionOptions))).toMatchObject({
        apiKey: "resolved-token",
        headers: { "x-attempt": "portable" },
        maxTokens: 4096,
        env: { OPENAI_API_KEY: "scoped-token" },
      });
    }),
  );

  it.effect("falls back to Pi compaction on portable request or provider failure", () =>
    Effect.gen(function*() {
      const fallbackCalls = yield* Ref.make(0);
      const requestFailure: LocalSummaryImplementations = {
        complete: () => Effect.fail("portable request failed"),
        compact: () => Ref.update(fallbackCalls, (value) => value + 1).pipe(
          Effect.as(local),
        ),
        now: Effect.succeed(42),
      };
      const providerFailure: LocalSummaryImplementations = {
        complete: () =>
          Effect.succeed({
            role: "assistant",
            content: [{ type: "text", text: "must not be accepted" }],
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "gpt-5.4",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: "error",
            timestamp: 42,
          }),
        compact: () => Ref.update(fallbackCalls, (value) => value + 1).pipe(
          Effect.as(local),
        ),
        now: Effect.succeed(42),
      };
      const request = {
        event: compactionEvent(),
        model: codexModel(),
        auth: { apiKey: "resolved-token" },
        thinkingLevel: "high",
      } satisfies LocalCompactionRequest;

      expect(
        yield* generateBestEffortLocalSummary(request, requestFailure),
      ).toBe(local);
      expect(
        yield* generateBestEffortLocalSummary(request, providerFailure),
      ).toBe(local);
      expect(yield* Ref.get(fallbackCalls)).toBe(2);
    }),
  );

  it.effect("records failed portable completion separately from Pi fallback", () =>
    Effect.gen(function*() {
      const recorded = createTelemetryRecorder();
      const runtime = yield* harness(dependencies({
        telemetry: recorded.telemetry,
        local: (request) =>
          generateBestEffortLocalSummary(request, {
            complete: () =>
              Effect.succeed({
                role: "assistant",
                content: [{ type: "text", text: "must not be accepted" }],
                api: "openai-codex-responses",
                provider: "openai-codex",
                model: "gpt-5.4",
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
                stopReason: "error",
                timestamp: 42,
              }),
            compact: () => Effect.succeed(local),
            now: Effect.succeed(42),
          }),
        remote: () => Effect.fail("server unavailable"),
      }));

      yield* runtime.emit("session_before_compact", compactionEvent());

      const attempts = recorded.operations[0]?.attempts ?? [];
      const portableAttempts = attempts.filter(
        ({ input }) => input.compactionPath === "portable_summary",
      );
      expect(portableAttempts).toHaveLength(2);
      expect(portableAttempts[0]?.outcome).toMatchObject({
        status: 200,
        error: { name: "ProviderError" },
        inputTokens: 1,
        outputTokens: 1,
        streamOutcome: "upstream_error",
      });
      expect(portableAttempts[1]?.outcome).toMatchObject({
        status: 200,
        inputTokens: 2,
        outputTokens: 3,
        streamOutcome: "completed",
      });
      expect(
        attempts.find(({ input }) => input.compactionPath === "native_server")
          ?.outcome,
      ).toMatchObject({ streamOutcome: "upstream_error" });
    }),
  );
});
