import { describe, expect, test } from "bun:test";
import type {
  CompactionResult,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createOpenAIServerCompactionExtension } from "../extension.ts";
import { nativeCompactionDetails } from "../session.ts";

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
          version: 1,
          provider: "openai-codex",
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
    let request: any;
    const handlers = harness({
      runLocalCompaction: async () => local,
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
    });
  });

  test("forwards Pi custom compaction instructions to the native request", async () => {
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

    expect(request?.instructions).toBe("system\n\nKeep the deployment caveat.");
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
        details: nativeCompactionDetails("openai-codex", "gpt-5.4", [artifact]),
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
});
