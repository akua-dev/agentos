import { describe, expect, test } from "bun:test";
import type {
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  createOpenAIServerCompactionExtension,
  generateBestEffortLocalSummary,
} from "../extension.ts";
import { OpenAICompactionHttpError } from "../remote.ts";
import { nativeCompactionDetails } from "../session.ts";
import { createTelemetryRecorder } from "../../telemetry/tests/fake-telemetry.ts";

type Handler = (event: any, context: ExtensionContext) => any;

function model(): Model<any> {
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

function harness(dependencies: Parameters<typeof createOpenAIServerCompactionExtension>[0]) {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getAllTools: () => [],
    getActiveTools: () => [],
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI;
  createOpenAIServerCompactionExtension(dependencies)(pi);
  return handlers;
}

function context(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    model: model(),
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "token", headers: {} }),
    },
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "hello", timestamp: 1 },
        },
      ],
      getSessionId: () => "session-1",
    },
    getSystemPrompt: () => "system",
    hasUI: true,
    ui: { notify: () => undefined },
    ...overrides,
  } as unknown as ExtensionContext;
}

const event = {
  type: "session_before_compact",
  preparation: { firstKeptEntryId: "m1", tokensBefore: 100 },
  branchEntries: [],
  reason: "threshold",
  willRetry: false,
  signal: new AbortController().signal,
} as unknown as SessionBeforeCompactEvent;

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

describe("AgentOS OpenAI server-compaction extension", () => {
  test("attributes both local and native provider calls as compaction", async () => {
    const recorded = createTelemetryRecorder();
    const handlers = harness({
      telemetry: recorded.telemetry,
      runLocalCompaction: async () => local,
      runServerCompaction: async () => ({
        output: [{ type: "compaction", encrypted_content: "opaque" }],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      }),
    });

    await handlers.get("session_before_compact")?.(event, context());

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
          status: 200,
          streamOutcome: "completed",
        },
      },
    ]);
    expect(recorded.operations[0]?.outcome).toEqual({ status: 200 });
  });

  test("uses the native transport mode for direct OpenAI compaction", async () => {
    const recorded = createTelemetryRecorder();
    const handlers = harness({
      telemetry: recorded.telemetry,
      runLocalCompaction: async () => local,
      runServerCompaction: async () => ({
        output: [{ type: "compaction", encrypted_content: "opaque" }],
      }),
    });

    await handlers.get("session_before_compact")?.(
      event,
      context({
        model: {
          ...model(),
          provider: "openai",
          api: "openai-responses",
        } as any,
      }),
    );

    expect(
      recorded.operations[0]?.attempts.map(({ input }) => input.streamMode),
    ).toEqual(["non_streaming", "non_streaming"]);
  });

  test("persists native state alongside Pi's portable local summary", async () => {
    const handlers = harness({
      runLocalCompaction: async () => local,
      runServerCompaction: async () => ({
        output: [{ type: "compaction", encrypted_content: "opaque" }],
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      }),
    });

    const result = await handlers.get("session_before_compact")?.(event, context());
    expect(result.compaction).toEqual({
      ...local,
      usage: {
        input: 12,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 16,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      details: {
        readFiles: ["a.ts"],
        agentosOpenAIServerCompaction: {
          version: 2,
          implementation: "responses_compaction_v2",
          provider: "openai-codex",
          api: "openai-codex-responses",
          model: "gpt-5.4",
          replacementInput: [{ type: "compaction", encrypted_content: "opaque" }],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        },
      },
    });
  });

  test("uses the portable summary when the server request fails", async () => {
    const warnings: string[] = [];
    const handlers = harness({
      runLocalCompaction: async () => local,
      runServerCompaction: async () => {
        throw new Error("provider unavailable");
      },
    });

    const result = await handlers.get("session_before_compact")?.(
      event,
      context({ ui: { notify: (message: string) => warnings.push(message) } as any }),
    );
    expect(result).toEqual({ compaction: local });
    expect(warnings).toEqual(["OpenAI server compaction unavailable; using Pi's portable summary."]);
  });

  test("records native HTTP status while portable fallback succeeds", async () => {
    const recorded = createTelemetryRecorder();
    const handlers = harness({
      telemetry: recorded.telemetry,
      runLocalCompaction: async () => local,
      runServerCompaction: async () => {
        throw new OpenAICompactionHttpError(503);
      },
    });

    await expect(
      handlers.get("session_before_compact")?.(event, context()),
    ).resolves.toEqual({ compaction: local });
    expect(recorded.operations[0]?.attempts[1]?.outcome).toEqual({
      status: 503,
      error: expect.objectContaining({
        name: "OpenAICompactionHttpError",
        status: 503,
      }),
      streamOutcome: "upstream_error",
    });
    expect(recorded.operations[0]?.outcome).toEqual({ status: 200 });
  });

  test("lets Pi handle compaction when the portable summary fails", async () => {
    const handlers = harness({
      runLocalCompaction: async () => {
        throw new Error("local failed");
      },
      runServerCompaction: async () => ({
        output: [{ type: "compaction", encrypted_content: "must-not-persist" }],
      }),
    });
    expect(await handlers.get("session_before_compact")?.(event, context())).toBeUndefined();
  });

  test("forwards model headers and keeps resolved authentication headers authoritative", async () => {
    const recorded = createTelemetryRecorder();
    let localRequest: any;
    let request: any;
    const handlers = harness({
      telemetry: recorded.telemetry,
      runLocalCompaction: async (value) => {
        localRequest = value;
        return local;
      },
      runServerCompaction: async (value) => {
        request = value;
        return { output: [{ type: "compaction", encrypted_content: "opaque" }] };
      },
    });

    await handlers.get("session_before_compact")?.(
      event,
      context({
        model: {
          ...model(),
          headers: {
            "X-AI-Gateway-Token": "fleet-token",
            Authorization: "Bearer configured-token",
          },
        } as any,
        modelRegistry: {
          getApiKeyAndHeaders: async () => ({
            ok: true,
            apiKey: "resolved-token",
            headers: { authorization: "Bearer resolved-header", "X-Resolved": "yes" },
          }),
        } as any,
      }),
    );

    expect(request.headers).toEqual({
      "X-AI-Gateway-Token": "fleet-token",
      authorization: "Bearer resolved-header",
      "X-Resolved": "yes",
      traceparent: expect.stringMatching(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
      ),
      "x-agentos-request-attempt-id": "attempt-3",
    });
    expect(localRequest.auth.headers).toEqual({
      "X-AI-Gateway-Token": "fleet-token",
      authorization: "Bearer resolved-header",
      "X-Resolved": "yes",
      traceparent: expect.stringMatching(
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
      ),
      "x-agentos-request-attempt-id": "attempt-2",
    });
    expect(localRequest.auth.headers).not.toBe(request.headers);
  });

  test("keeps portable custom instructions out of the native request", async () => {
    let request: { instructions?: string } | undefined;
    const handlers = harness({
      runLocalCompaction: async () => local,
      runServerCompaction: async (value) => {
        request = value;
        return { output: [{ type: "compaction", encrypted_content: "opaque" }] };
      },
    });

    await handlers.get("session_before_compact")?.(
      { ...event, customInstructions: "Keep the deployment caveat." },
      context(),
    );

    expect(request?.instructions).toBe("system");
  });

  test("normalizes native prompt input before transport", async () => {
    let request: any;
    const artifact = {
      type: "compaction" as const,
      encrypted_content: "opaque-normalized",
    };
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "old", timestamp: 1 },
      },
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
          [
            { type: "ghost_snapshot", state: "remove" } as any,
            {
              type: "function_call",
              call_id: "call-1",
              name: "read",
              arguments: "{}",
            },
            artifact,
          ],
        ),
      },
    ];
    const handlers = harness({
      runLocalCompaction: async () => local,
      runServerCompaction: async (value) => {
        request = value;
        return { output: [artifact] };
      },
    });

    await handlers.get("session_before_compact")?.(
      { ...event, branchEntries: entries },
      context(),
    );

    expect(request.input).toEqual([
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
  });

  test("reuses validated request shape only for the same session and model", async () => {
    const requests: any[] = [];
    const handlers = harness({
      runLocalCompaction: async () => local,
      runServerCompaction: async (value) => {
        requests.push(value);
        return {
          output: [{ type: "compaction", encrypted_content: "opaque" }],
        };
      },
    });
    const ctx = context();

    handlers.get("before_provider_request")?.(
      {
        type: "before_provider_request",
        payload: {
          model: "gpt-5.4",
          input: [],
          reasoning: { effort: "low", summary: "detailed" },
          text: { verbosity: "low" },
        },
      },
      ctx,
    );
    await handlers.get("session_before_compact")?.(event, ctx);
    await handlers.get("session_before_compact")?.(event, ctx);

    expect(requests[0]).toMatchObject({
      reasoning: { effort: "low", summary: "detailed" },
      text: { verbosity: "low" },
    });
    expect(requests[1]?.text).toBeUndefined();
    expect(requests[1]?.reasoning).toEqual({
      effort: "high",
      summary: "auto",
    });

    handlers.get("before_provider_request")?.(
      {
        type: "before_provider_request",
        payload: {
          model: "gpt-5.4",
          input: [],
          reasoning: "invalid",
          text: ["invalid"],
        },
      },
      ctx,
    );
    await handlers.get("session_before_compact")?.(
      event,
      context({
        model: { ...model(), id: "gpt-5.5" } as any,
      }),
    );
    expect(requests[2]?.text).toBeUndefined();
    expect(requests[2]?.reasoning).toEqual({
      effort: "high",
      summary: "auto",
    });
  });

  test("clears request shape at every session lifecycle boundary", async () => {
    const resets = [
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
      [
        "session_compact",
        { type: "session_compact", reason: "manual" },
      ],
      ["model_select", { type: "model_select", source: "user" }],
      ["session_shutdown", { type: "session_shutdown", reason: "reload" }],
    ] as const;

    for (const [name, resetEvent] of resets) {
      let request: any;
      const handlers = harness({
        runLocalCompaction: async () => local,
        runServerCompaction: async (value) => {
          request = value;
          return {
            output: [
              { type: "compaction", encrypted_content: `opaque-${name}` },
            ],
          };
        },
      });
      const ctx = context();
      handlers.get("before_provider_request")?.(
        {
          type: "before_provider_request",
          payload: {
            model: "gpt-5.4",
            input: [],
            text: { verbosity: "low" },
          },
        },
        ctx,
      );
      await handlers.get(name)?.(resetEvent, ctx);
      await handlers.get("session_before_compact")?.(event, ctx);
      expect(request?.text, name).toBeUndefined();
    }
  });

  test("registration is inert and installs only in-memory handlers", () => {
    let providerCalls = 0;
    const handlers = harness({
      runLocalCompaction: async () => {
        providerCalls += 1;
        return local;
      },
      runServerCompaction: async () => {
        providerCalls += 1;
        return {
          output: [{ type: "compaction", encrypted_content: "opaque" }],
        };
      },
    });

    expect(providerCalls).toBe(0);
    expect([...handlers.keys()].sort()).toEqual([
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
  });

  test("replays persisted native state through Pi's existing provider request", () => {
    const artifact = { type: "compaction" as const, encrypted_content: "opaque" };
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "old", timestamp: 1 },
      },
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
    const handlers = harness({
      runLocalCompaction: async () => local,
      runServerCompaction: async () => ({ output: [artifact] }),
    });

    const result = handlers.get("before_provider_request")?.(
      { type: "before_provider_request", payload: { model: "gpt-5.4", input: [] } },
      context({ sessionManager: { getBranch: () => entries } as any }),
    );
    expect(result).toEqual({
      model: "gpt-5.4",
      input: [
        artifact,
        { type: "message", role: "user", content: [{ type: "input_text", text: "new" }] },
      ],
    });
  });

  test("builds the portable summary from every message in the branch", async () => {
    let completionContext: any;
    let completionOptions: any;
    const result = await generateBestEffortLocalSummary(
      {
        event: {
          ...event,
          customInstructions: "Keep the deployment caveat.",
          branchEntries: [
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
          ],
        } as SessionBeforeCompactEvent,
        model: model() as never,
        auth: {
          apiKey: "resolved-token",
          headers: { "x-attempt": "portable" },
          env: { OPENAI_API_KEY: "scoped-token" },
        },
        thinkingLevel: "high",
      },
      {
        complete: async (_model, completion, options) => {
          completionContext = completion;
          completionOptions = options;
          return {
            role: "assistant",
            content: [{ type: "text", text: " full branch summary " }],
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
          } as never;
        },
        compact: async () => {
          throw new Error("Pi fallback must not run");
        },
        now: () => 42,
      },
    );

    expect(result).toEqual({
      summary: "full branch summary",
      firstKeptEntryId: "m1",
      tokensBefore: 100,
    });
    const prompt = completionContext.messages[0].content[0].text;
    expect(prompt).toContain("old goal");
    expect(prompt).toContain("new decision");
    expect(prompt).toContain("Additional summarization instructions:");
    expect(prompt).toContain("Keep the deployment caveat.");
    expect(prompt).not.toContain("must not replace the branch");
    expect(completionContext.messages[0].timestamp).toBe(42);
    expect(completionOptions).toMatchObject({
      apiKey: "resolved-token",
      headers: { "x-attempt": "portable" },
      maxTokens: 4096,
      signal: event.signal,
      env: { OPENAI_API_KEY: "scoped-token" },
    });
  });

  test("falls back to Pi compaction when full-branch summarization fails", async () => {
    let compactArguments: unknown[] | undefined;
    const result = await generateBestEffortLocalSummary(
      {
        event: {
          ...event,
          customInstructions: "Keep the caveat.",
        },
        model: model() as never,
        auth: {
          apiKey: "resolved-token",
          headers: { "x-attempt": "portable" },
          env: { OPENAI_API_KEY: "scoped-token" },
        },
        thinkingLevel: "high",
      },
      {
        complete: async () => {
          throw new Error("portable request failed");
        },
        compact: async (...args) => {
          compactArguments = args;
          return local;
        },
        now: () => 42,
      },
    );

    expect(result).toBe(local);
    expect(compactArguments).toEqual([
      event.preparation,
      model(),
      "resolved-token",
      { "x-attempt": "portable" },
      "Keep the caveat.",
      event.signal,
      "high",
      undefined,
      { OPENAI_API_KEY: "scoped-token" },
    ]);
  });

  test("falls back to Pi compaction when the portable model reports a failure", async () => {
    let compactCalled = false;
    const result = await generateBestEffortLocalSummary(
      {
        event,
        model: model() as never,
        auth: { apiKey: "resolved-token" },
        thinkingLevel: "high",
      },
      {
        complete: async () =>
          ({
            role: "assistant",
            content: [{ type: "text", text: "must not be accepted" }],
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
          }) as never,
        compact: async () => {
          compactCalled = true;
          return local;
        },
        now: () => 42,
      },
    );

    expect(compactCalled).toBe(true);
    expect(result).toBe(local);
  });
});
