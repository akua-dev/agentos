import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createAIGatewayService } from "../../../../../services/ai-gateway/src/service.ts";
import {
  buildRemoteCompactionHistory,
  endpointForModel,
  requestServerCompaction as requestServerCompactionImpl,
  resolveCodexInstallationId,
  supportsServerCompaction,
  type OpenAICompactionModel,
  type ServerCompactionRequest,
} from "../remote.ts";
import { parseResponseItems, type ResponseItem } from "../schemas.ts";
import { nativeCompactionDetails, rewriteResponsesPayload } from "../session.ts";

const completeUsage = {
  input_tokens: 40,
  input_tokens_details: { cached_tokens: 10 },
  output_tokens: 4,
  output_tokens_details: { reasoning_tokens: 2 },
  total_tokens: 44,
};
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

function requestServerCompaction(
  params: ServerCompactionRequest,
) {
  return requestServerCompactionImpl({
    ...params,
    codexInstallationId: params.codexInstallationId ??
      (() => INSTALLATION_ID),
  });
}

function responseItems(value: unknown): ResponseItem[] {
  const parsed = parseResponseItems(value);
  if (!parsed) throw new Error("Invalid response item fixture.");
  return parsed;
}

function model(overrides: Partial<Model<Api>> = {}): OpenAICompactionModel {
  const candidate: Model<Api> = {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "http://ai-gateway:8787",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 100_000,
    ...overrides,
  };
  if (!supportsServerCompaction(candidate)) throw new Error("Invalid compaction model fixture.");
  return candidate;
}

describe("OpenAI server compaction transport", () => {
  test("composes the gateway handler, compaction transport, and persisted replay", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "ai-gateway-compaction-"));
    const artifact = { type: "compaction" as const, encrypted_content: "opaque-gateway-state" };
    const output = responseItems([artifact]);
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          output,
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        },
      })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    let forwarded: Request | undefined;
    const service = await createAIGatewayService({
      stateDirectory,
      clientToken: "fleet-token",
      allowApiKeyFallback: true,
      openAIApiKey: "provider-fixture-key",
      oauth: { refresh: async () => { throw new Error("OAuth is not used by this fixture."); } },
      fetchImpl: async (input, init) => {
        forwarded = new Request(input instanceof Request ? input.url : input.toString(), init);
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });

    const result = await requestServerCompaction({
      model: model(),
      apiKey: "fleet-token",
      sessionId: "session-1",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] }],
      tools: [],
      fetchImpl: (input, init) =>
        service.fetch(new Request(input instanceof Request ? input.url : input.toString(), init)),
    });

    expect(forwarded?.url).toBe("https://api.openai.com/v1/responses");
    expect(forwarded?.headers.get("authorization")).toBe("Bearer provider-fixture-key");
    expect(JSON.parse(await forwarded!.text())).toEqual(
      expect.objectContaining({
        input: [expect.any(Object), { type: "compaction_trigger" }],
        stream: true,
      }),
    );

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
          result.output,
          result.usage,
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

    expect(rewriteResponsesPayload(
      { model: "gpt-5.4", input: [] },
      entries,
      "openai-codex",
      "openai-codex-responses",
      "gpt-5.4",
    ))
      .toEqual({
        model: "gpt-5.4",
        input: [
          ...result.output,
          { type: "message", role: "user", content: [{ type: "input_text", text: "new" }] },
        ],
      });
  });

  test("supports only native OpenAI Responses models and resolves their endpoints", () => {
    expect(supportsServerCompaction(model())).toBe(true);
    expect(endpointForModel(model())).toBe("http://ai-gateway:8787/codex/responses");
    expect(
      endpointForModel(
        model({ provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }),
      ),
    ).toBe("https://api.openai.com/v1/responses");
    expect(
      supportsServerCompaction({
        ...model(),
        provider: "anthropic",
        api: "anthropic-messages",
      }),
    ).toBe(false);
  });

  test("retains a cloned 20K-token window of recent real user messages", () => {
    const oldest = {
      type: "message" as const,
      role: "user" as const,
      content: [{ type: "input_text" as const, text: "a".repeat(20_000) }],
    };
    const boundary = {
      type: "message" as const,
      role: "user" as const,
      content: [{ type: "input_text" as const, text: "b".repeat(60_000) }],
    };
    const newest = {
      type: "message" as const,
      role: "user" as const,
      content: [{ type: "input_text" as const, text: "c".repeat(40_000) }],
    };
    const artifact = {
      type: "compaction" as const,
      encrypted_content: "opaque-history",
    };
    const input = responseItems([
      oldest,
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "not retained", annotations: [] }],
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
    input[2]!.content = [];
    artifact.encrypted_content = "mutated";
    expect(history[0]).toEqual({
      ...boundary,
      content: [{ type: "input_text", text: "b".repeat(40_000) }],
    });
    expect(history.at(-1)).toEqual({
      type: "compaction",
      encrypted_content: "opaque-history",
    });
  });

  test("exposes a safe numeric status without reading an upstream error body", async () => {
    let bodyRead = false;
    const body = new ReadableStream({
      pull() {
        bodyRead = true;
        throw new Error("private provider response body");
      },
    }, { highWaterMark: 0 });

    await expect(
      requestServerCompaction({
        model: model(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: async () => new Response(body, { status: 503 }),
      }),
    ).rejects.toMatchObject({
      name: "OpenAICompactionHttpError",
      status: 503,
    });
    expect(bodyRead).toBe(false);
  });

  test("requests compaction over bounded SSE without any WebSocket transport", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const artifact = { type: "compaction" as const, encrypted_content: "opaque-server-state" };
    const output = responseItems([
      {
        type: "message" as const,
        role: "user" as const,
        content: [{ type: "input_text" as const, text: "retained" }],
        provider_metadata: { trace_id: "trace-1" },
      },
      {
        type: "reasoning" as const,
        summary: [],
        encrypted_content: "provider-reasoning",
        provider_metadata: { model_family: "gpt" },
      },
      { type: "opaque_item" as const, opaque: { provider_key: "preserve-me" } },
      artifact,
    ]);
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          output,
          usage: { input_tokens: 50, output_tokens: 3 },
        },
      })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");

    const result = await requestServerCompaction({
      model: model(),
      apiKey: "fleet-client-token",
      headers: { "x-extra": "kept" },
      sessionId: "session-1",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      instructions: "system prompt",
      tools: [
        { type: "function", name: "read", description: "Read", parameters: {}, strict: false },
      ],
      signal: undefined,
      fetchImpl: async (input, init) => {
        request = { url: String(input), init: init ?? {} };
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });

    expect(result).toEqual({
      output: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
        artifact,
      ],
      usage: { input_tokens: 50, output_tokens: 3 },
    });
    expect(request?.url).toBe("http://ai-gateway:8787/codex/responses");
    const headers = new Headers(request?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer fleet-client-token");
    expect(headers.get("x-codex-beta-features")).toBe("remote_compaction_v2");
    expect(headers.get("x-codex-installation-id")).toBe(INSTALLATION_ID);
    expect(headers.get("x-codex-window-id")).toBe("session-1:0");
    expect(headers.get("session-id")).toBe("session-1");
    expect(headers.get("thread-id")).toBe("session-1");
    expect(headers.get("x-client-request-id")).toBe("session-1");
    expect(headers.get("x-extra")).toBe("kept");
    const body = JSON.parse(String(request?.init.body));
    expect(body).toEqual(
      expect.objectContaining({
        model: "gpt-5.4",
        input: [expect.any(Object), { type: "compaction_trigger" }],
        instructions: "system prompt",
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      }),
    );
  });

  test("rejects incomplete streams instead of persisting unverifiable state", async () => {
    await expect(
      requestServerCompaction({
        model: model(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: async () =>
          new Response(
            `data: ${JSON.stringify({
              type: "response.output_item.done",
              item: { type: "compaction", encrypted_content: "opaque" },
            })}\n\n`,
            { status: 200 },
          ),
      }),
    ).rejects.toThrow("before response.completed");
  });

  test("accepts Codex response.done as a successful terminal event", async () => {
    const artifact = { type: "compaction" as const, encrypted_content: "opaque-done" };
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}`,
      `data: ${JSON.stringify({
        type: "response.done",
        response: {
          status: "completed",
          output: [artifact],
          usage: { input_tokens: 7, output_tokens: 2 },
        },
      })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");

    await expect(
      requestServerCompaction({
        model: model(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: async () => new Response(sse, { status: 200 }),
      }),
    ).resolves.toEqual({ output: [artifact], usage: { input_tokens: 7, output_tokens: 2 } });
  });

  test("uses completed output items when the terminal response omits output", async () => {
    const artifact = { type: "compaction" as const, encrypted_content: "opaque-done-items" };
    const output = responseItems([
      { type: "message", role: "user", content: [{ type: "input_text", text: "retained" }] },
      artifact,
    ]);
    const sse = [
      ...output.map((item) => `data: ${JSON.stringify({ type: "response.output_item.done", item })}`),
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          output: null,
          usage: { input_tokens: 8, output_tokens: 2 },
        },
      })}`,
      "",
    ].join("\n\n");

    await expect(
      requestServerCompaction({
        model: model(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: async () => new Response(sse, { status: 200 }),
      }),
    ).resolves.toEqual({ output: [artifact], usage: { input_tokens: 8, output_tokens: 2 } });
  });

  test("rejects a stream whose only artifact is outside terminal output", async () => {
    const artifact = { type: "compaction" as const, encrypted_content: "opaque-noncanonical" };
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}`,
      `data: ${JSON.stringify({
        type: "response.done",
        response: {
          status: "completed",
          output: [{ type: "message", role: "user", content: [] }],
        },
      })}`,
      "",
    ].join("\n\n");

    await expect(
      requestServerCompaction({
        model: model(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: async () => new Response(sse, { status: 200 }),
      }),
    ).rejects.toThrow("canonical output expected one artifact");
  });

  test("rejects a completed stream without any canonical output", async () => {
    const sse = [
      `data: ${JSON.stringify({
        type: "response.done",
        response: { status: "completed" },
      })}`,
      "",
    ].join("\n\n");

    await expect(
      requestServerCompaction({
        model: model(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: async () => new Response(sse, { status: 200 }),
      }),
    ).rejects.toThrow("expected one artifact");
  });

  test("rejects Codex response.incomplete before accepting an artifact", async () => {
    const artifact = { type: "compaction" as const, encrypted_content: "opaque-incomplete" };
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}`,
      `data: ${JSON.stringify({ type: "response.incomplete", response: { output: [artifact] } })}`,
      "",
    ].join("\n\n");

    await expect(
      requestServerCompaction({
        model: model(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: async () => new Response(sse, { status: 200 }),
      }),
    ).rejects.toThrow("incomplete");
  });

  test("rejects every non-completed terminal status", async () => {
    for (const status of ["queued", "in_progress", "incomplete", "failed", "cancelled", undefined]) {
      const artifact = { type: "compaction", encrypted_content: `opaque-${status ?? "missing"}` };
      const response = {
        ...(status === undefined ? {} : { status }),
        output: [artifact],
      };
      const sse = [
        `data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}`,
        `data: ${JSON.stringify({ type: "response.done", response })}`,
        "",
      ].join("\n\n");

      await expect(
        requestServerCompaction({
          model: model(),
          apiKey: "token",
          input: [],
          tools: [],
          fetchImpl: async () => new Response(sse, { status: 200 }),
        }),
      ).rejects.toThrow();
    }
  });

  test("rejects ambiguous multiple terminal events", async () => {
    const artifact = { type: "compaction" as const, encrypted_content: "opaque-ambiguous" };
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { status: "completed", output: [artifact] },
      })}`,
      `data: ${JSON.stringify({
        type: "response.done",
        response: { status: "completed", output: [artifact] },
      })}`,
      "",
    ].join("\n\n");

    await expect(
      requestServerCompaction({
        model: model(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: async () => new Response(sse, { status: 200 }),
      }),
    ).rejects.toThrow("multiple terminal");
  });

  test("rejects compaction items that share encrypted content but differ in metadata", async () => {
    const eventArtifact = {
      type: "compaction" as const,
      encrypted_content: "opaque-ambiguous-artifact",
      provider_metadata: { source: "item-done" },
    };
    const terminalArtifact = {
      type: "compaction" as const,
      encrypted_content: "opaque-ambiguous-artifact",
      provider_metadata: { source: "terminal-output" },
    };
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: eventArtifact })}`,
      `data: ${JSON.stringify({
        type: "response.done",
        response: { status: "completed", output: [terminalArtifact] },
      })}`,
      "",
    ].join("\n\n");

    await expect(
      requestServerCompaction({
        model: model(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: async () => new Response(sse, { status: 200 }),
      }),
    ).rejects.toThrow("ambiguous");
  });

  test("rejects malformed known output_text instead of treating it as opaque content", async () => {
    const artifact = {
      type: "compaction" as const,
      encrypted_content: "opaque-invalid-output-text",
    };
    const output = [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: 42, annotations: [] }],
      },
      artifact,
    ];
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { status: "completed", output },
      })}`,
      "",
    ].join("\n\n");

    await expect(
      requestServerCompaction({
        model: model({
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        }),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: async () =>
          new Response(sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      }),
    ).rejects.toThrow("invalid terminal response");
  });

  test("uses Responses compaction v2 for direct OpenAI models", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const artifact = {
      type: "compaction" as const,
      encrypted_content: "opaque-openai",
      provider_metadata: { version: 2 },
    };
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          output: [artifact],
          usage: completeUsage,
        },
      })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const input = responseItems([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ]);
    const result = await requestServerCompaction({
      model: model({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
      apiKey: "openai-token",
      headers: {
        "x-agentos-request-attempt-id": "attempt-private",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      },
      input,
      instructions: "system prompt",
      tools: [
        {
          type: "function",
          name: "ignored",
          description: "Ignored",
          parameters: {},
          strict: false,
        },
      ],
      sessionId: "session-2",
      fetchImpl: async (input, init) => {
        request = { url: String(input), init: init ?? {} };
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    expect(result).toEqual({ output: [...input, artifact], usage: completeUsage });
    expect(request?.url).toBe("https://api.openai.com/v1/responses");
    const headers = new Headers(request?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer openai-token");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("x-codex-beta-features")).toBe("remote_compaction_v2");
    expect(headers.has("openai-beta")).toBe(false);
    expect(headers.has("x-codex-installation-id")).toBe(false);
    expect(headers.has("x-codex-window-id")).toBe(false);
    expect(headers.has("session-id")).toBe(false);
    expect(headers.has("x-agentos-request-attempt-id")).toBe(false);
    expect(headers.get("traceparent")).toBe(
      "00-11111111111111111111111111111111-2222222222222222-01",
    );
    expect(JSON.parse(String(request?.init.body))).toEqual({
      model: "gpt-5.4",
      input: [...input, { type: "compaction_trigger" }],
      instructions: "system prompt",
      tools: [
        {
          type: "function",
          name: "ignored",
          description: "Ignored",
          parameters: {},
          strict: false,
        },
      ],
      parallel_tool_calls: true,
      tool_choice: "auto",
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session-2",
    });
  });

  test("resolves a stable Codex installation identity only when requested", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "agentos-codex-home-"));
    const installationPath = join(codexHome, "installation_id");

    const generated = await resolveCodexInstallationId(codexHome);
    expect(generated).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await readFile(installationPath, "utf8")).toBe(generated);

    await writeFile(
      installationPath,
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA\n",
    );
    expect(await resolveCodexInstallationId(codexHome)).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  });

  test("rejects malformed provider usage in the SSE terminal response", async () => {
    const artifact = { type: "compaction" as const, encrypted_content: "opaque-sse-usage" };
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}`,
      `data: ${JSON.stringify({
        type: "response.done",
        response: {
          status: "completed",
          output: [artifact],
          usage: { input_tokens: "not-a-number", output_tokens: 2 },
        },
      })}`,
      "",
    ].join("\n\n");

    await expect(
      requestServerCompaction({
        model: model(),
        apiKey: "token",
        input: [],
        tools: [],
        fetchImpl: async () => new Response(sse, { status: 200 }),
      }),
    ).rejects.toThrow("invalid usage");
  });

  test("returns on the bounded deadline when fetch does not settle", async () => {
    const started = performance.now();
    await expect(
      requestServerCompaction({
        model: model(),
        apiKey: "token",
        input: [],
        tools: [],
        timeoutMs: 10,
        fetchImpl: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return new Response("", { status: 200 });
        },
      }),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(80);
  });
});
