import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildCompactionInput,
  nativeCompactionDetails,
  rewriteResponsesPayload,
} from "../session.ts";

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
    const artifact = { type: "compaction" as const, encrypted_content: "opaque" };
    const details = nativeCompactionDetails("openai-codex", "gpt-5.4", artifact);
    const entries = [
      message("old", null, "already compacted"),
      compaction("compact", "old", "portable summary", details),
      message("new", "compact", "after"),
    ];

    expect(buildCompactionInput(entries, "openai-codex", "gpt-5.4")).toEqual([
      artifact,
      { type: "message", role: "user", content: [{ type: "input_text", text: "after" }] },
    ]);
    expect(
      rewriteResponsesPayload(
        { model: "gpt-5.4", input: [{ type: "message", role: "user", content: [] }] },
        entries,
        "openai-codex",
        "gpt-5.4",
      ),
    ).toEqual({ model: "gpt-5.4", input: [artifact, expect.any(Object)] });
  });

  test("never reuses an older artifact across a newer local compaction or model mismatch", () => {
    const artifact = { type: "compaction" as const, encrypted_content: "opaque" };
    const native = nativeCompactionDetails("openai-codex", "gpt-5.4", artifact);
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
});
