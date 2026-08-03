import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunPath from "@effect/platform-bun/BunPath";
import { describe, expect, it } from "@effect/vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import {
  buildRemoteCompactionHistory,
  compactionResponseFromWeb,
  endpointForModel,
  requestServerCompaction,
  resolveCodexInstallationId,
  supportsServerCompaction,
  type OpenAICompactionHttpResponse,
  type OpenAICompactionModel,
  type ServerCompactionRequest,
} from "../remote.ts";
import {
  ResponseItemsSchema,
  type CompactionArtifact,
  type ResponseItem,
} from "../schemas.ts";
import {
  nativeCompactionDetails,
  rewriteResponsesPayload,
} from "../session.ts";

const platformLayer = Layer.mergeAll(
  BunCrypto.layer,
  BunFileSystem.layer,
  BunHttpClient.layer,
  BunPath.layer,
);
const JsonString = Schema.fromJsonString(Schema.Unknown);
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const completeUsage = {
  input_tokens: 40,
  input_tokens_details: { cached_tokens: 10 },
  output_tokens: 4,
  output_tokens_details: { reasoning_tokens: 2 },
  total_tokens: 44,
};

function codexModel(baseUrl = "http://ai-gateway:8787"): OpenAICompactionModel {
  return {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100_000,
  };
}

function directModel(): OpenAICompactionModel {
  return {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100_000,
  };
}

function execute(params: ServerCompactionRequest) {
  return requestServerCompaction({
    ...params,
    codexInstallationId: params.codexInstallationId ??
      (() => Effect.succeed(INSTALLATION_ID)),
  }).pipe(Effect.provide(platformLayer));
}

function encodeJson(value: unknown) {
  return Schema.encodeEffect(JsonString)(value).pipe(Effect.orDie);
}

function decodeJson(source: RequestInit["body"]) {
  return typeof source === "string"
    ? Schema.decodeUnknownEffect(JsonString)(source).pipe(Effect.orDie)
    : Effect.die("Expected a string request body fixture.");
}

function responseItems(value: unknown) {
  return Schema.decodeUnknownEffect(ResponseItemsSchema)(value).pipe(
    Effect.orDie,
  );
}

function sse(events: ReadonlyArray<unknown>, done = true) {
  return Effect.forEach(events, encodeJson).pipe(
    Effect.map((encoded) =>
      [
        ...encoded.map((event) => `data: ${event}`),
        ...(done ? ["data: [DONE]"] : []),
        "",
      ].join("\n\n")
    ),
  );
}

function textResponse(
  source: string,
  status = 200,
  headers?: Readonly<Record<string, string>>,
) {
  return compactionResponseFromWeb(new Response(source, { status, headers }));
}

function jsonResponse(value: unknown, status = 200) {
  return encodeJson(value).pipe(
    Effect.map((source) =>
      textResponse(source, status, { "content-type": "application/json" })
    ),
  );
}

function terminalEvents(
  artifact: CompactionArtifact,
  options: {
    readonly type?: "response.completed" | "response.done";
    readonly output?: unknown;
    readonly status?: unknown;
    readonly usage?: unknown;
  } = {},
) {
  return [
    { type: "response.output_item.done", item: artifact },
    {
      type: options.type ?? "response.completed",
      response: {
        status: options.status ?? "completed",
        output: options.output ?? [artifact],
        ...(options.usage === undefined ? {} : { usage: options.usage }),
      },
    },
  ];
}

describe("OpenAI server compaction Effect runtime", () => {
  it.effect("constructs a lazy Effect with an Effect transport", () =>
    Effect.sync(() => {
      let transportInvoked = false;
      const request = {
        model: directModel(),
        apiKey: "test-token",
        input: [{ type: "message", role: "user", content: [] }],
        tools: [],
        fetchImpl: () => {
          transportInvoked = true;
          return Effect.succeed(textResponse("", 200));
        },
      } satisfies ServerCompactionRequest;

      const program = requestServerCompaction(request);

      expect(Effect.isEffect(program)).toBe(true);
      expect(transportInvoked).toBe(false);
    }),
  );

  it.effect("supports only matching Responses providers and resolves endpoints", () =>
    Effect.sync(() => {
      const unsupported = {
        ...codexModel(),
        provider: "anthropic",
        api: "anthropic-messages",
      } satisfies Model<Api>;

      expect(supportsServerCompaction(codexModel())).toBe(true);
      expect(supportsServerCompaction(directModel())).toBe(true);
      expect(supportsServerCompaction(unsupported)).toBe(false);
      expect(endpointForModel(codexModel())).toBe(
        "http://ai-gateway:8787/codex/responses",
      );
      expect(endpointForModel(directModel())).toBe(
        "https://api.openai.com/v1/responses/compact",
      );
    }),
  );

  it.effect("retains a cloned 20K-token window of recent real user messages", () =>
    Effect.gen(function*() {
      const boundary = {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "b".repeat(60_000) }],
      };
      const newest = {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "c".repeat(40_000) }],
      };
      const artifact = {
        type: "compaction",
        encrypted_content: "opaque-history",
      } satisfies CompactionArtifact;
      const input = yield* responseItems([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "a".repeat(20_000) }],
        },
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "not retained", annotations: [] },
          ],
        },
        boundary,
        { type: "message", role: "user", content: [] },
        newest,
      ]);

      const history = buildRemoteCompactionHistory(input, artifact);

      expect(history).toEqual([
        {
          ...boundary,
          content: [{ type: "input_text", text: "b".repeat(40_000) }],
        },
        newest,
        artifact,
      ]);
      input.splice(0, input.length);
      artifact.encrypted_content = "mutated";
      expect(history.at(-1)).toEqual({
        type: "compaction",
        encrypted_content: "opaque-history",
      });
    }),
  );

  it.effect("exposes HTTP status without consuming an upstream error body", () =>
    Effect.gen(function*() {
      const bodyRead = yield* Ref.make(false);
      const responseClosed = yield* Ref.make(false);
      const response: OpenAICompactionHttpResponse = {
        status: 503,
        headers: new Headers(),
        body: Stream.fromEffect(
          Ref.set(bodyRead, true).pipe(Effect.andThen(Effect.fail("private"))),
        ),
        close: Ref.set(responseClosed, true),
      };
      const error = yield* execute({
        model: codexModel(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: () => Effect.succeed(response),
      }).pipe(Effect.flip);

      expect(error._tag).toBe("OpenAICompactionHttpError");
      expect("status" in error ? error.status : undefined).toBe(503);
      expect(yield* Ref.get(bodyRead)).toBe(false);
      expect(yield* Ref.get(responseClosed)).toBe(true);
    }),
  );

  it.effect("sends bounded Codex SSE requests and persists canonical replay", () =>
    Effect.gen(function*() {
      const observed = yield* Ref.make<Option.Option<{
        readonly url: string;
        readonly init: RequestInit;
      }>>(Option.none());
      const artifact = {
        type: "compaction",
        encrypted_content: "opaque-server-state",
      } satisfies CompactionArtifact;
      const source = yield* sse(terminalEvents(artifact, {
        usage: { input_tokens: 50, output_tokens: 3 },
      }));
      const input = yield* responseItems([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ]);
      const result = yield* execute({
        model: codexModel(),
        apiKey: "resolved-provider-token",
        headers: { "x-extra": "kept" },
        sessionId: "session-1",
        input,
        instructions: "system prompt",
        tools: [
          {
            type: "function",
            name: "read",
            description: "Read",
            parameters: {},
            strict: false,
          },
        ],
        fetchImpl: (requestInput, init) =>
          Ref.set(observed, Option.some({
            url: String(requestInput),
            init: init ?? {},
          })).pipe(Effect.as(textResponse(source))),
      });

      expect(result).toEqual({
        output: [...input, artifact],
        usage: { input_tokens: 50, output_tokens: 3 },
      });
      const request = Option.getOrUndefined(yield* Ref.get(observed));
      expect(request?.url).toBe("http://ai-gateway:8787/codex/responses");
      const headers = new Headers(request?.init.headers);
      expect(headers.get("authorization")).toBe("Bearer resolved-provider-token");
      expect(headers.get("x-codex-beta-features")).toBe(
        "remote_compaction_v2",
      );
      expect(headers.get("x-codex-installation-id")).toBe(INSTALLATION_ID);
      expect(headers.get("x-codex-window-id")).toBe("session-1:0");
      expect(headers.get("session-id")).toBe("session-1");
      expect(headers.get("thread-id")).toBe("session-1");
      expect(headers.get("x-client-request-id")).toMatch(UUID_PATTERN);
      expect(headers.get("x-extra")).toBe("kept");
      expect(yield* decodeJson(request?.init.body)).toMatchObject({
        model: "gpt-5.4",
        input: [...input, { type: "compaction_trigger" }],
        instructions: "system prompt",
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      });

      const entries: SessionEntry[] = [
        {
          type: "compaction",
          id: "c1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          summary: "portable",
          firstKeptEntryId: "m1",
          tokensBefore: 100,
          details: nativeCompactionDetails(
            "openai-codex",
            "openai-codex-responses",
            "gpt-5.4",
            result.output,
            result.usage,
          ),
        },
      ];
      expect(rewriteResponsesPayload(
        { model: "gpt-5.4", input: [] },
        entries,
        "openai-codex",
        "openai-codex-responses",
        "gpt-5.4",
      )).toMatchObject({ input: result.output });
    }),
  );

  it.effect("accepts response.done and completed items when terminal output is null", () =>
    Effect.gen(function*() {
      const artifact = {
        type: "compaction",
        encrypted_content: "opaque-done-items",
      } satisfies CompactionArtifact;
      const events = [
        {
          type: "response.output_item.done",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "retained" }],
          },
        },
        { type: "response.output_item.done", item: artifact },
        {
          type: "response.done",
          response: {
            status: "completed",
            output: null,
            usage: { input_tokens: 8, output_tokens: 2 },
          },
        },
      ];
      const source = yield* sse(events);
      const result = yield* execute({
        model: codexModel(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: () => Effect.succeed(textResponse(source)),
      });

      expect(result).toEqual({
        output: [artifact],
        usage: { input_tokens: 8, output_tokens: 2 },
      });
    }),
  );

  it.effect("rejects incomplete, failed, ambiguous, and non-canonical streams", () =>
    Effect.gen(function*() {
      const artifact = {
        type: "compaction",
        encrypted_content: "opaque-invalid",
      } satisfies CompactionArtifact;
      const cases: ReadonlyArray<{
        readonly events: ReadonlyArray<unknown>;
        readonly message: string;
      }> = [
        {
          events: [{ type: "response.output_item.done", item: artifact }],
          message: "before response.completed",
        },
        {
          events: [
            { type: "response.output_item.done", item: artifact },
            { type: "response.incomplete" },
          ],
          message: "incomplete",
        },
        {
          events: [
            ...terminalEvents(artifact),
            {
              type: "response.done",
              response: { status: "completed", output: [artifact] },
            },
          ],
          message: "multiple terminal",
        },
        {
          events: terminalEvents(artifact, {
            output: [{ type: "message", role: "user", content: [] }],
          }),
          message: "canonical output expected one artifact",
        },
        {
          events: [
            {
              type: "response.done",
              response: { status: "completed" },
            },
          ],
          message: "expected one artifact",
        },
      ];

      yield* Effect.forEach(cases, (testCase) =>
        Effect.gen(function*() {
          const source = yield* sse(testCase.events);
          const error = yield* execute({
            model: codexModel(),
            apiKey: "token",
            input: [],
            tools: [],
            fetchImpl: () => Effect.succeed(textResponse(source)),
          }).pipe(Effect.flip);
          expect(error.message).toContain(testCase.message);
        })
      );
    }),
  );

  it.effect("rejects every non-completed terminal status", () =>
    Effect.gen(function*() {
      const statuses: ReadonlyArray<unknown> = [
        "queued",
        "in_progress",
        "incomplete",
        "failed",
        "cancelled",
        undefined,
      ];
      yield* Effect.forEach(statuses, (status) =>
        Effect.gen(function*() {
          const artifact = {
            type: "compaction",
            encrypted_content: `opaque-${String(status)}`,
          } satisfies CompactionArtifact;
          const response = status === undefined
            ? { output: [artifact] }
            : { status, output: [artifact] };
          const source = yield* sse([
            { type: "response.output_item.done", item: artifact },
            { type: "response.done", response },
          ]);
          const error = yield* execute({
            model: codexModel(),
            apiKey: "token",
            input: [],
            tools: [],
            fetchImpl: () => Effect.succeed(textResponse(source)),
          }).pipe(Effect.flip);
          expect(error.message).toContain("not completed");
        })
      );
    }),
  );

  it.effect("rejects artifacts with equal ciphertext and divergent metadata", () =>
    Effect.gen(function*() {
      const eventArtifact = {
        type: "compaction",
        encrypted_content: "opaque-ambiguous-artifact",
        provider_metadata: { source: "item-done" },
      };
      const terminalArtifact = {
        type: "compaction",
        encrypted_content: "opaque-ambiguous-artifact",
        provider_metadata: { source: "terminal-output" },
      };
      const source = yield* sse([
        { type: "response.output_item.done", item: eventArtifact },
        {
          type: "response.done",
          response: { status: "completed", output: [terminalArtifact] },
        },
      ]);
      const error = yield* execute({
        model: codexModel(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: () => Effect.succeed(textResponse(source)),
      }).pipe(Effect.flip);

      expect(error.message).toContain("ambiguous");
    }),
  );

  it.effect("uses the direct JSON compact endpoint without Codex headers", () =>
    Effect.gen(function*() {
      const observed = yield* Ref.make<Option.Option<{
        readonly url: string;
        readonly init: RequestInit;
      }>>(Option.none());
      const artifact = {
        type: "compaction",
        encrypted_content: "opaque-openai",
        provider_metadata: { version: 2 },
      };
      const input = yield* responseItems([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ]);
      const response = yield* jsonResponse({
        id: "cmp_direct",
        created_at: 1,
        object: "response.compaction",
        output: [...input, artifact],
        usage: completeUsage,
      });
      const result = yield* execute({
        model: directModel(),
        apiKey: "openai-token",
        headers: {
          "x-client-request-id": "attempt-direct-1",
          "x-agentos-request-attempt-id": "attempt-private",
          traceparent:
            "00-11111111111111111111111111111111-2222222222222222-01",
        },
        input,
        instructions: "system prompt",
        tools: [],
        sessionId: "session-2",
        fetchImpl: (requestInput, init) =>
          Ref.set(observed, Option.some({
            url: String(requestInput),
            init: init ?? {},
          })).pipe(Effect.as(response)),
      });

      expect(result).toEqual({ output: [...input, artifact], usage: completeUsage });
      const request = Option.getOrUndefined(yield* Ref.get(observed));
      expect(request?.url).toBe("https://api.openai.com/v1/responses/compact");
      const headers = new Headers(request?.init.headers);
      expect(headers.get("authorization")).toBe("Bearer openai-token");
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.has("x-codex-beta-features")).toBe(false);
      expect(headers.has("openai-beta")).toBe(false);
      expect(headers.has("x-codex-installation-id")).toBe(false);
      expect(headers.has("x-codex-window-id")).toBe(false);
      expect(headers.has("session-id")).toBe(false);
      expect(headers.get("x-client-request-id")).toBe("attempt-direct-1");
      expect(headers.has("x-agentos-request-attempt-id")).toBe(false);
      expect(headers.get("traceparent")).toBe(
        "00-11111111111111111111111111111111-2222222222222222-01",
      );
      expect(yield* decodeJson(request?.init.body)).toEqual({
        model: "gpt-5.4",
        input,
        instructions: "system prompt",
        tools: [],
        parallel_tool_calls: true,
        prompt_cache_key: "session-2",
      });
    }),
  );

  it.effect("rejects malformed direct output and malformed provider usage", () =>
    Effect.gen(function*() {
      const malformedDirect = yield* jsonResponse({
        id: "cmp_invalid",
        created_at: 1,
        object: "response.compaction",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: 42, annotations: [] }],
          },
          { type: "compaction", encrypted_content: "opaque-invalid" },
        ],
        usage: completeUsage,
      });
      const directError = yield* execute({
        model: directModel(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: () => Effect.succeed(malformedDirect),
      }).pipe(Effect.flip);
      expect(directError.message).toContain("invalid compact response");

      const artifact = {
        type: "compaction",
        encrypted_content: "opaque-sse-usage",
      } satisfies CompactionArtifact;
      const source = yield* sse(terminalEvents(artifact, {
        usage: { input_tokens: "not-a-number", output_tokens: 2 },
      }));
      const usageError = yield* execute({
        model: codexModel(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: () => Effect.succeed(textResponse(source)),
      }).pipe(Effect.flip);
      expect(usageError.message).toContain("invalid usage");
    }),
  );

  it.effect("uses fresh request IDs and scopes AgentOS headers to Gateway routes", () =>
    Effect.gen(function*() {
      const ids = yield* Ref.make<ReadonlyArray<string>>([]);
      const correlations = yield* Ref.make<ReadonlyArray<string | null>>([]);
      const artifact = {
        type: "compaction",
        encrypted_content: "opaque-request-id",
      } satisfies CompactionArtifact;
      const source = yield* sse(terminalEvents(artifact));
      const run = (route: "direct" | "ai_gateway") =>
        execute({
          model: codexModel("https://proxy.example.test"),
          route,
          apiKey: "token",
          sessionId: "stable-session",
          headers: { "x-agentos-request-attempt-id": "attempt-private" },
          input: [],
          tools: [],
          fetchImpl: (_input, init) => {
            const headers = new Headers(init?.headers);
            return Ref.update(
              ids,
              (values) => [
                ...values,
                headers.get("x-client-request-id") ?? "",
              ],
            ).pipe(
              Effect.andThen(
                Ref.update(correlations, (values) => [
                  ...values,
                  headers.get("x-agentos-request-attempt-id"),
                ]),
              ),
              Effect.as(textResponse(source)),
            );
          },
        });

      yield* run("direct");
      yield* run("ai_gateway");

      const requestIds = yield* Ref.get(ids);
      expect(requestIds).toHaveLength(2);
      expect(requestIds[0]).toMatch(UUID_PATTERN);
      expect(requestIds[1]).toMatch(UUID_PATTERN);
      expect(requestIds[0]).not.toBe(requestIds[1]);
      expect(yield* Ref.get(correlations)).toEqual([null, "attempt-private"]);
    }),
  );

  it.effect("captures only a bounded provider request ID from response headers", () =>
    Effect.gen(function*() {
      const artifact = {
        type: "compaction",
        encrypted_content: "opaque-provider-request-id",
      } satisfies CompactionArtifact;
      const source = yield* sse(terminalEvents(artifact));
      const safe = yield* execute({
        model: codexModel(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: () =>
          Effect.succeed(textResponse(source, 200, {
            "x-oai-request-id": "req_safe_compaction_1",
          })),
      });
      expect(safe.providerRequestId).toBe("req_safe_compaction_1");

      const malformed = yield* execute({
        model: codexModel(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: () =>
          Effect.succeed(textResponse(source, 200, {
            "x-request-id": "private request body with spaces",
          })),
      });
      expect(malformed.providerRequestId).toBeUndefined();
    }),
  );

  it.effect("derives ChatGPT account identity from the bearer token", () =>
    Effect.gen(function*() {
      const payload = yield* encodeJson({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "account-123",
        },
      });
      const token = `header.${Buffer.from(payload).toString("base64url")}.signature`;
      const observed = yield* Ref.make<string | null>(null);
      const artifact = {
        type: "compaction",
        encrypted_content: "opaque-account",
      } satisfies CompactionArtifact;
      const source = yield* sse(terminalEvents(artifact));
      yield* execute({
        model: codexModel("https://chatgpt.com/backend-api"),
        apiKey: token,
        input: [],
        tools: [],
        fetchImpl: (_input, init) =>
          Ref.set(
            observed,
            new Headers(init?.headers).get("chatgpt-account-id"),
          ).pipe(Effect.as(textResponse(source))),
      });

      expect(yield* Ref.get(observed)).toBe("account-123");
    }),
  );

  it.effect("enforces declared and streamed response size limits", () =>
    Effect.gen(function*() {
      const declared = textResponse("", 200, {
        "content-length": String(16 * 1024 * 1024 + 1),
      });
      const declaredError = yield* execute({
        model: directModel(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: () => Effect.succeed(declared),
      }).pipe(Effect.flip);
      expect(declaredError.message).toContain("size limit");

      const streamed: OpenAICompactionHttpResponse = {
        status: 200,
        headers: new Headers(),
        body: Stream.succeed(new Uint8Array(16 * 1024 * 1024 + 1)),
        close: Effect.void,
      };
      const streamedError = yield* execute({
        model: directModel(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: () => Effect.succeed(streamed),
      }).pipe(Effect.flip);
      expect(streamedError.message).toContain("size limit");
    }),
  );

  it.effect("interrupts on caller abort and the bounded Effect deadline", () =>
    Effect.gen(function*() {
      const controller = new AbortController();
      const abortedFiber = yield* Effect.forkChild(
        execute({
          model: directModel(),
          apiKey: "token",
          input: [],
          tools: [],
          signal: controller.signal,
          fetchImpl: () => Effect.never,
        }).pipe(Effect.flip),
      );
      yield* Effect.sync(() => controller.abort());
      const aborted = yield* Fiber.join(abortedFiber);
      expect(aborted._tag).toBe("OpenAICompactionError");
      if (aborted._tag === "OpenAICompactionError") {
        expect(aborted.code).toBe("aborted");
      }

      const timedFiber = yield* Effect.forkChild(
        execute({
          model: directModel(),
          apiKey: "token",
          input: [],
          tools: [],
          timeoutMs: 10,
          fetchImpl: () => Effect.never,
        }).pipe(Effect.flip),
      );
      yield* TestClock.adjust(10);
      const timed = yield* Fiber.join(timedFiber);
      expect(timed._tag).toBe("OpenAICompactionError");
      if (timed._tag === "OpenAICompactionError") {
        expect(timed.code).toBe("timeout");
      }
    }),
  );

  it.effect("persists one canonical installation ID across concurrent first use", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const codexHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "agentos-codex-home-",
        });
        const ids = yield* Effect.all(
          Array.from(
            { length: 16 },
            () => resolveCodexInstallationId(codexHome),
          ),
          { concurrency: "unbounded" },
        );
        const installationPath = paths.join(codexHome, "installation_id");
        const persisted = yield* fileSystem.readFileString(installationPath);

        expect(new Set(ids).size).toBe(1);
        expect(persisted).toBe(ids[0]);
        expect(persisted).toMatch(UUID_PATTERN);

        yield* fileSystem.writeFileString(
          installationPath,
          "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA\n",
        );
        expect(yield* resolveCodexInstallationId(codexHome)).toBe(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        );
      }),
    ).pipe(Effect.provide(platformLayer)),
  );
});
