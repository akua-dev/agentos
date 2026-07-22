import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  endpointForModel,
  requestServerCompaction,
  supportsServerCompaction,
  type OpenAICompactionModel,
} from "../remote.ts";
import { parseResponseItems, type ResponseItem } from "../schemas.ts";

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
  test("supports only native OpenAI Responses models and resolves their endpoints", () => {
    expect(supportsServerCompaction(model())).toBe(true);
    expect(endpointForModel(model())).toBe("http://ai-gateway:8787/codex/responses");
    expect(
      endpointForModel(
        model({ provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }),
      ),
    ).toBe("https://api.openai.com/v1/responses/compact");
    expect(
      supportsServerCompaction({
        ...model(),
        provider: "anthropic",
        api: "anthropic-messages",
      }),
    ).toBe(false);
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

    expect(result).toEqual({ output, usage: { input_tokens: 50, output_tokens: 3 } });
    expect(request?.url).toBe("http://ai-gateway:8787/codex/responses");
    const headers = new Headers(request?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer fleet-client-token");
    expect(headers.get("x-codex-beta-features")).toBe("remote_compaction_v2");
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
    ).resolves.toEqual({ output, usage: { input_tokens: 8, output_tokens: 2 } });
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
    const output = [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: 42, annotations: [] }],
      },
      { type: "compaction", encrypted_content: "opaque-invalid-output-text" },
    ];

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
          new Response(JSON.stringify({ output }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("invalid compacted response");
  });

  test("uses the standard OpenAI compact endpoint and JSON response", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const output = responseItems([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "retained" },
          { type: "opaque_content", opaque: { provider_key: "preserve-me" } },
        ],
        provider_metadata: { trace_id: "trace-1" },
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "retained answer", annotations: [] }],
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "ignored",
        arguments: "{}",
        provider_metadata: { region: "test" },
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_text", text: "tool result" }],
      },
      {
        type: "reasoning",
        summary: [],
        encrypted_content: "provider-reasoning",
        provider_metadata: { model_family: "gpt" },
      },
      {
        type: "provider_metadata",
        opaque: { trace_id: "trace-2", region: "test" },
      },
      { type: "compaction", encrypted_content: "opaque-openai", provider_metadata: { version: 2 } },
    ]);
    const result = await requestServerCompaction({
      model: model({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
      apiKey: "openai-token",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
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
        return new Response(
          JSON.stringify({
            id: "cmp_1",
            object: "response.compaction",
            output,
            usage: { input_tokens: 40, output_tokens: 4 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(result).toEqual({ output, usage: { input_tokens: 40, output_tokens: 4 } });
    expect(request?.url).toBe("https://api.openai.com/v1/responses/compact");
    const headers = new Headers(request?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer openai-token");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("x-codex-beta-features")).toBe(false);
    expect(headers.has("openai-beta")).toBe(false);
    expect(JSON.parse(String(request?.init.body))).toEqual({
      model: "gpt-5.4",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      instructions: "system prompt",
      prompt_cache_key: "session-2",
    });
  });

  test("rejects malformed provider usage at the response boundary", async () => {
    const output = [{ type: "compaction" as const, encrypted_content: "opaque-usage" }];

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
          new Response(
            JSON.stringify({
              output,
              usage: { input_tokens: "not-a-number", output_tokens: 2 },
            }),
            { status: 200 },
          ),
      }),
    ).rejects.toThrow("invalid usage");
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
