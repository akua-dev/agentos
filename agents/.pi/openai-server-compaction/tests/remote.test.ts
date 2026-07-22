import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import {
  endpointForModel,
  requestServerCompaction,
  supportsServerCompaction,
} from "../remote.ts";

function model(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
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
}

describe("OpenAI server compaction transport", () => {
  test("supports only native OpenAI Responses models and resolves their endpoints", () => {
    expect(supportsServerCompaction(model())).toBe(true);
    expect(endpointForModel(model())).toBe("http://ai-gateway:8787/codex/responses");
    expect(
      endpointForModel(
        model({ provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" }),
      ),
    ).toBe("https://api.openai.com/v1/responses");
    expect(supportsServerCompaction(model({ provider: "anthropic", api: "anthropic-messages" }))).toBe(
      false,
    );
  });

  test("requests compaction over bounded SSE without any WebSocket transport", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const artifact = { type: "compaction" as const, encrypted_content: "opaque-server-state" };
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}`,
      `data: ${JSON.stringify({
        type: "response.completed",
        response: { output: [artifact], usage: { input_tokens: 50, output_tokens: 3 } },
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
      tools: [{ type: "function", name: "read", description: "Read", parameters: {} }],
      signal: undefined,
      fetchImpl: async (input, init) => {
        request = { url: String(input), init: init ?? {} };
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });

    expect(result).toEqual({ artifact, usage: { input_tokens: 50, output_tokens: 3 } });
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
});
