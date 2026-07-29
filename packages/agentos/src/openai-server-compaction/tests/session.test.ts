import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildCompactionInput,
  nativeCompactionDetails,
  NATIVE_DETAILS_KEY,
  rewriteResponsesPayload,
} from "../session.ts";
import { parseResponseItems } from "../schemas.ts";

function message(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: 1 },
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

    expect(buildCompactionInput(entries, "openai-codex", "gpt-5.4")).toEqual([
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
    const details = nativeCompactionDetails("openai", "gpt-5.4", output);
    const entries = [
      message("old", null, "already compacted"),
      compaction("compact", "old", "portable summary", details),
      message("new", "compact", "after"),
    ];

    expect(buildCompactionInput(entries, "openai", "gpt-5.4")).toEqual([
      ...output,
      { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] },
    ]);
    expect(
      rewriteResponsesPayload(
        { model: "gpt-5.4", input: [{ type: "message", role: "user", content: [] }] },
        entries,
        "openai",
        "gpt-5.4",
      ),
    ).toEqual({ model: "gpt-5.4", input: [...output, expect.any(Object)] });
  });

  test("never reuses an older artifact across a newer local compaction or model mismatch", () => {
    const artifact = { type: "compaction" as const, encrypted_content: "opaque" };
    const native = nativeCompactionDetails("openai-codex", "gpt-5.4", [artifact]);
    const superseded = [
      message("old", null, "old"),
      compaction("native", "old", "one", native),
      message("middle", "native", "middle"),
      compaction("local", "middle", "two"),
    ];
    expect(
      rewriteResponsesPayload({ input: [] }, superseded, "openai-codex", "gpt-5.4"),
    ).toBeUndefined();

    const matching = superseded.slice(0, 2);
    expect(
      rewriteResponsesPayload({ input: [] }, matching, "openai-codex", "gpt-5.3"),
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

    expect(buildCompactionInput(entries, "openai", "gpt-5.4")).toEqual([
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

    expect(buildCompactionInput(entries, "openai", "gpt-5.4")).toEqual([
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
        nativeCompactionDetails("openai", "gpt-5.4", [artifact]),
      ),
    ];

    expect(
      rewriteResponsesPayload({ model: "gpt-5.3", input: [] }, entries, "openai", "gpt-5.4"),
    ).toBeUndefined();
  });
});
