import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildCompactionInput,
  nativeCompactionDetails,
  NATIVE_DETAILS_KEY,
  rewriteResponsesPayload,
} from "../session.ts";
import { parseResponseItems } from "../schemas.ts";

const usage = {
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
};

function message(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 1 },
  };
}

function assistant(
  id: string,
  parentId: string,
  text: string,
  api: "openai-responses" | "openai-codex-responses",
  provider: "openai" | "openai-codex",
  model: string,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api,
      provider,
      model,
      usage,
      stopReason: "stop",
      timestamp: 1,
    },
  };
}

function toolResult(
  id: string,
  parentId: string,
  callId: string,
  text: string,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1,
    },
  };
}

function compaction(
  id: string,
  parentId: string,
  summary: string,
  details?: unknown,
): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    summary,
    firstKeptEntryId: parentId,
    tokensBefore: 100,
    details,
  };
}

describe("native compaction session replay", () => {
  test("uses Pi's active local summary when there is no native artifact", () => {
    const entries = [
      message("old", null, "discarded"),
      message("kept", "old", "kept"),
      compaction("compact", "kept", "portable summary"),
      message("new", "compact", "after"),
    ];

    expect(
      buildCompactionInput(
        entries,
        "openai-codex",
        "openai-codex-responses",
        "gpt-5.4",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "message",
        role: "user",
        content: [
          expect.objectContaining({
            type: "input_text",
            text: expect.stringContaining("portable summary"),
          }),
        ],
      }),
      { type: "message", role: "user", content: [{ type: "input_text", text: "kept" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] },
    ]);
  });

  test("continues from the latest matching opaque artifact", () => {
    const output = parseResponseItems([
      {
        type: "message" as const,
        role: "user" as const,
        content: [
          { type: "input_text" as const, text: "retained" },
          { type: "opaque_content", opaque: { provider_key: "preserve-me" } },
        ],
        provider_metadata: { trace_id: "trace-1" },
      },
      {
        type: "function_call" as const,
        call_id: "call_1",
        name: "read",
        arguments: "{}",
        provider_metadata: { region: "test" },
      },
      { type: "opaque_item", opaque: { provider_key: "preserve-me" } },
      { type: "compaction" as const, encrypted_content: "opaque" },
    ]);
    if (!output) throw new Error("Invalid response item fixture.");
    const details = nativeCompactionDetails(
      "openai",
      "openai-responses",
      "gpt-5.4",
      output,
    );
    expect(details).toEqual({
      [NATIVE_DETAILS_KEY]: {
        version: 2,
        implementation: "responses_compaction_v2",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
        replacementInput: output,
      },
    });
    const entries = [
      message("old", null, "already compacted"),
      compaction("compact", "old", "portable summary", details),
      message("new", "compact", "after"),
    ];

    expect(
      buildCompactionInput(
        entries,
        "openai",
        "openai-responses",
        "gpt-5.4",
      ),
    ).toEqual([
      ...output,
      { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] },
    ]);
    expect(
      rewriteResponsesPayload(
        { model: "gpt-5.4", input: [{ type: "message", role: "user", content: [] }] },
        entries,
        "openai",
        "openai-responses",
        "gpt-5.4",
      ),
    ).toEqual({ model: "gpt-5.4", input: [...output, expect.any(Object)] });
  });

  test("never reuses an older artifact across a newer local compaction or model mismatch", () => {
    const artifact = { type: "compaction" as const, encrypted_content: "opaque" };
    const native = nativeCompactionDetails(
      "openai-codex",
      "openai-codex-responses",
      "gpt-5.4",
      [artifact],
    );
    const superseded = [
      message("old", null, "old"),
      compaction("native", "old", "one", native),
      message("middle", "native", "middle"),
      compaction("local", "middle", "two"),
    ];
    expect(
      rewriteResponsesPayload(
        { input: [] },
        superseded,
        "openai-codex",
        "openai-codex-responses",
        "gpt-5.4",
      ),
    ).toBeUndefined();

    const matching = superseded.slice(0, 2);
    expect(
      rewriteResponsesPayload(
        { input: [] },
        matching,
        "openai-codex",
        "openai-codex-responses",
        "gpt-5.3",
      ),
    ).toBeUndefined();
  });

  test("fails closed when persisted native replay input is malformed", () => {
    const entries = [
      message("old", null, "discarded"),
      compaction("compact", "old", "portable summary", {
        [NATIVE_DETAILS_KEY]: {
          version: 1,
          provider: "openai",
          model: "gpt-5.4",
          replacementInput: [
            { type: "compaction", encrypted_content: "opaque" },
            { type: "message", role: "user", content: [null] },
          ],
        },
      }),
      message("new", "compact", "after"),
    ];

    expect(
      buildCompactionInput(
        entries,
        "openai",
        "openai-responses",
        "gpt-5.4",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "message",
        content: [expect.objectContaining({ text: expect.stringContaining("portable summary") })],
      }),
      { type: "message", role: "user", content: [{ type: "input_text", text: "discarded" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] },
    ]);
  });

  test("fails closed when persisted native usage is malformed", () => {
    const entries = [
      message("old", null, "discarded"),
      compaction("compact", "old", "portable summary", {
        [NATIVE_DETAILS_KEY]: {
          version: 1,
          provider: "openai",
          model: "gpt-5.4",
          replacementInput: [{ type: "compaction", encrypted_content: "opaque" }],
          usage: { input_tokens: "not-a-number" },
        },
      }),
      message("new", "compact", "after"),
    ];

    expect(
      buildCompactionInput(
        entries,
        "openai",
        "openai-responses",
        "gpt-5.4",
      ),
    ).toEqual([
      expect.objectContaining({
        type: "message",
        content: [expect.objectContaining({ text: expect.stringContaining("portable summary") })],
      }),
      { type: "message", role: "user", content: [{ type: "input_text", text: "discarded" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] },
    ]);
  });

  test("does not replay native output for a different payload model", () => {
    const artifact = { type: "compaction" as const, encrypted_content: "opaque" };
    const entries = [
      message("old", null, "discarded"),
      compaction(
        "compact",
        "old",
        "portable summary",
        nativeCompactionDetails(
          "openai",
          "openai-responses",
          "gpt-5.4",
          [artifact],
        ),
      ),
    ];

    expect(
      rewriteResponsesPayload(
        { model: "gpt-5.3", input: [] },
        entries,
        "openai",
        "openai-responses",
        "gpt-5.4",
      ),
    ).toBeUndefined();
  });

  test("reads version-1 state and rejects version-2 API mismatches", () => {
    const artifact = {
      type: "compaction" as const,
      encrypted_content: "opaque-legacy",
    };
    const legacy = [
      message("old", null, "discarded"),
      compaction("compact", "old", "portable summary", {
        [NATIVE_DETAILS_KEY]: {
          version: 1,
          provider: "openai",
          model: "gpt-5.4",
          replacementInput: [artifact],
        },
      }),
      message("new", "compact", "after"),
    ];
    expect(
      buildCompactionInput(
        legacy,
        "openai",
        "openai-responses",
        "gpt-5.4",
      ),
    ).toEqual([
      artifact,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "after" }],
      },
    ]);

    const versionTwo = [
      message("old", null, "discarded"),
      compaction(
        "compact",
        "old",
        "portable summary",
        nativeCompactionDetails(
          "openai-codex",
          "openai-codex-responses",
          "gpt-5.4",
          [artifact],
        ),
      ),
    ];
    expect(
      rewriteResponsesPayload(
        { input: [] },
        versionTwo,
        "openai-codex",
        "openai-responses",
        "gpt-5.4",
      ),
    ).toBeUndefined();
  });

  test("replays only matching completed turns plus the pending tail", () => {
    const artifact = {
      type: "compaction" as const,
      encrypted_content: "opaque-turns",
    };
    const entries = [
      message("old", null, "discarded"),
      compaction(
        "compact",
        "old",
        "portable summary",
        nativeCompactionDetails(
          "openai-codex",
          "openai-codex-responses",
          "gpt-5.4",
          [artifact],
        ),
      ),
      message("foreign-user", "compact", "omit user"),
      assistant(
        "foreign-assistant",
        "foreign-user",
        "omit assistant",
        "openai-codex-responses",
        "openai-codex",
        "gpt-5.3",
      ),
      message("matching-user", "foreign-assistant", "keep user"),
      assistant(
        "matching-assistant",
        "matching-user",
        "keep assistant",
        "openai-codex-responses",
        "openai-codex",
        "gpt-5.4",
      ),
      message("pending-user", "matching-assistant", "current user"),
      toolResult("pending-tool", "pending-user", "call-1", "current tool"),
    ];

    expect(
      buildCompactionInput(
        entries,
        "openai-codex",
        "openai-codex-responses",
        "gpt-5.4",
      ),
    ).toEqual([
      artifact,
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "keep user" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "keep assistant",
            annotations: [],
          },
        ],
        status: "completed",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "current user" }],
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: [{ type: "input_text", text: "current tool" }],
      },
    ]);
  });
});
