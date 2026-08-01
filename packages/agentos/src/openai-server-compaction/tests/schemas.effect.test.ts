import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import {
  NativeCompactionStateSchema,
  ResponseItemSchema,
  ResponseUsageSchema,
} from "../schemas.ts";

describe("OpenAI server compaction Effect schemas", () => {
  it.effect("preserves JSON-safe provider extensions", () =>
    Effect.sync(() => {
      const input = {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "hello",
            provider_extension: { nested: [1, true, null] },
          },
        ],
        provider_extension: "retained",
      };

      const decoded = Schema.decodeUnknownOption(ResponseItemSchema, {
        onExcessProperty: "preserve",
      })(input);

      expect(Option.getOrUndefined(decoded)).toEqual(input);
    }),
  );

  it.effect("accepts only unknown JSON-safe provider item discriminants", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownOption(ResponseItemSchema, {
        onExcessProperty: "preserve",
      });

      expect(
        Option.isSome(
          decode({ type: "future_item", metadata: { nested: [1, true, null] } }),
        ),
      ).toBe(true);
      expect(
        Option.isNone(decode({ type: "future_item", callback: () => undefined })),
      ).toBe(true);
      expect(
        Option.isNone(
          decode({
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
          }),
        ),
      ).toBe(true);
    }),
  );

  it.effect("keeps persisted native state strict and replacement input canonical", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownOption(NativeCompactionStateSchema, {
        onExcessProperty: "error",
      });
      const state = {
        version: 2,
        implementation: "responses_compaction_v2",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5",
        replacementInput: [
          { type: "compaction", encrypted_content: "opaque" },
        ],
      };

      expect(Option.isSome(decode(state))).toBe(true);
      expect(Option.isNone(decode({ ...state, unexpected: true }))).toBe(true);
      expect(
        Option.isNone(
          decode({
            ...state,
            replacementInput: [
              { type: "compaction", encrypted_content: "first" },
              { type: "compaction", encrypted_content: "second" },
            ],
          }),
        ),
      ).toBe(true);
    }),
  );

  it.effect("requires a real non-negative integer usage observation", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownOption(ResponseUsageSchema, {
        onExcessProperty: "preserve",
      });

      expect(Option.isNone(decode({}))).toBe(true);
      expect(Option.isNone(decode({ input_tokens: -1 }))).toBe(true);
      expect(Option.isNone(decode({ input_tokens: 1.5 }))).toBe(true);
      expect(Option.isSome(decode({ input_tokens: 0 }))).toBe(true);
    }),
  );
});
