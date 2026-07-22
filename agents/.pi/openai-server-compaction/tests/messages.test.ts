import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { isResponseItem, messagesToResponseItems } from "../messages.ts";
import { parseResponseUsage } from "../schemas.ts";

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("Responses message conversion", () => {
  test("accepts only JSON-safe opaque provider items", () => {
    expect(
      isResponseItem({
        type: "future_item",
        metadata: { nested: [1, true, null] },
      }),
    ).toBe(true);
    expect(
      isResponseItem({
        type: "future_item",
        callback: () => undefined,
      }),
    ).toBe(false);
  });

  test("validates known provider discriminants instead of treating malformed items as opaque", () => {
    expect(
      isResponseItem({
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "AgentOS" },
      }),
    ).toBe(true);
    expect(
      isResponseItem({
        type: "web_search_call",
        id: "ws_1",
        action: { type: "search", query: "AgentOS" },
        status: 42,
      }),
    ).toBe(false);
    expect(
      isResponseItem({
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
      }),
    ).toBe(false);
    expect(
      isResponseItem({
        type: "web_search_call",
        id: "ws_1",
        action: { type: "search" },
        status: "completed",
      }),
    ).toBe(false);
    expect(
      isResponseItem({
        type: "file_search_call",
        queries: ["find"],
        status: "completed",
      }),
    ).toBe(false);
    expect(
      isResponseItem({
        type: "computer_call",
        id: "cc_1",
        call_id: "call_1",
        pending_safety_checks: [],
        status: "completed",
        action: "click",
      }),
    ).toBe(false);
  });

  test("validates item references and reasoning text as known discriminants", () => {
    expect(isResponseItem({ type: "item_reference" })).toBe(false);
    expect(isResponseItem({ type: "item_reference", id: "item_1" })).toBe(true);
    expect(
      isResponseItem({
        type: "message",
        role: "assistant",
        content: [{ type: "reasoning_text" }],
      }),
    ).toBe(false);
    expect(
      isResponseItem({
        type: "message",
        role: "assistant",
        content: [{ type: "reasoning_text", text: "retained reasoning" }],
      }),
    ).toBe(true);
  });

  test("validates tool-search and MCP items against provider output contracts", () => {
    expect(
      isResponseItem({
        type: "tool_search_call",
        id: "ts_1",
        arguments: ["search", 1],
        call_id: null,
        execution: "server",
        status: "completed",
      }),
    ).toBe(true);
    expect(
      isResponseItem({
        type: "tool_search_call",
        id: "ts_1",
        arguments: {},
        call_id: null,
        status: "completed",
      }),
    ).toBe(false);
    expect(
      isResponseItem({
        type: "tool_search_output",
        id: "tso_1",
        call_id: null,
        execution: "server",
        status: "completed",
        tools: [{ type: "web_search" }],
      }),
    ).toBe(true);
    expect(
      isResponseItem({
        type: "mcp_call",
        id: "mcp_1",
        arguments: "{}",
        name: "read",
        server_label: "server",
        status: "surprising",
      }),
    ).toBe(false);
  });

  test("accepts valid Responses message roles, image details, and file content", () => {
    expect(
      isResponseItem({
        type: "message",
        role: "system",
        content: [
          { type: "input_image", detail: "high", file_id: "file-image" },
          { type: "input_image", detail: "auto", file_id: null, image_url: null },
          { type: "input_file", file_id: "file-document" },
        ],
      }),
    ).toBe(true);
    expect(
      isResponseItem({
        type: "function_call_output",
        call_id: "call_1",
        output: [{ type: "input_file", file_url: "https://example.test/document.pdf" }],
      }),
    ).toBe(true);
    expect(
      isResponseItem({
        type: "message",
        role: "system",
        content: [{ type: "input_file", detail: "auto", file_id: "file-document" }],
      }),
    ).toBe(false);
    expect(
      isResponseItem({
        type: "message",
        role: "system",
        content: [{ type: "input_file", detail: "low", file_id: null, file_url: "https://example.test/document.pdf" }],
      }),
    ).toBe(true);
    expect(
      isResponseItem({
        type: "function_call_output",
        call_id: "call_2",
        output: [{ type: "input_file", file_data: null, filename: null }],
      }),
    ).toBe(true);
  });

  test("rejects fractional token usage", () => {
    expect(parseResponseUsage({ input_tokens: 1.5, output_tokens: 2 })).toBeUndefined();
  });

  test("rejects a malformed reasoning signature", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "private",
            thinkingSignature: JSON.stringify({ type: "reasoning", summary: [42] }),
          },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.4",
        usage,
        stopReason: "stop",
        timestamp: 1,
      },
    ];

    expect(messagesToResponseItems(messages)).toEqual([]);
  });

  test("preserves text, images, reasoning, tool calls, and tool results", () => {
    const reasoning = JSON.stringify({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "kept summary" }],
      encrypted_content: "opaque-reasoning",
      status: "completed",
    });
    const phase = JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" });
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", thinkingSignature: reasoning },
          { type: "text", text: "I will inspect it.", textSignature: phase },
          { type: "toolCall", id: "call-1|fc-1", name: "read", arguments: { path: "a.ts" } },
        ],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.4",
        usage,
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call-1|fc-1",
        toolName: "read",
        content: [
          { type: "text", text: "contents" },
          { type: "image", data: "cmVzdWx0", mimeType: "image/jpeg" },
        ],
        isError: false,
        timestamp: 3,
      },
    ];

    expect(messagesToResponseItems(messages)).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "inspect this" },
          { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aW1hZ2U=" },
        ],
      },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "kept summary" }],
        encrypted_content: "opaque-reasoning",
        status: "completed",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I will inspect it.", annotations: [] }],
        status: "completed",
        id: "msg_1",
        phase: "commentary",
      },
      {
        type: "function_call",
        id: "fc-1",
        call_id: "call-1",
        name: "read",
        arguments: '{"path":"a.ts"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: [
          { type: "input_text", text: "contents" },
          { type: "input_image", detail: "auto", image_url: "data:image/jpeg;base64,cmVzdWx0" },
        ],
      },
    ]);
  });
});
