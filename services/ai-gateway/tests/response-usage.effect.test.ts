import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  OpenAITerminalUsageError,
  makeOpenAITerminalUsageObserver,
} from "../src/response-usage.ts";

const encoder = new TextEncoder();

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

describe("OpenAI terminal usage observer", () => {
  it.effect("extracts authoritative usage across arbitrary UTF-8 and SSE chunk boundaries", () =>
    Effect.gen(function*() {
      const observer = yield* makeOpenAITerminalUsageObserver({
        maximumEventBytes: 4_096,
      });
      const source = [
        sse({ type: "response.output_text.delta", delta: "private prompt echo" }),
        sse({
          type: "response.completed",
          response: {
            status: "completed",
            usage: {
              input_tokens: 41,
              input_tokens_details: { cached_tokens: 13 },
              output_tokens: 7,
              total_tokens: 48,
            },
          },
        }),
        "data: [DONE]\n\n",
      ].join("");
      const bytes = encoder.encode(source);
      const boundaries = [0, 1, 2, 5, 17, bytes.byteLength];
      for (let index = 1; index < boundaries.length; index += 1) {
        yield* observer.observe(bytes.subarray(
          boundaries[index - 1] ?? 0,
          boundaries[index],
        ));
      }
      const usage = yield* observer.finish;
      assert.deepStrictEqual(usage, {
        inputTokens: 41,
        outputTokens: 7,
        cachedInputTokens: 13,
        spendMicros: 0,
      });
    }));

  it.effect("accepts response.done and defaults absent cached usage to zero", () =>
    Effect.gen(function*() {
      const observer = yield* makeOpenAITerminalUsageObserver({
        maximumEventBytes: 1_024,
      });
      yield* observer.observe(encoder.encode(sse({
        type: "response.done",
        response: {
          status: "completed",
          usage: { input_tokens: 8, output_tokens: 2 },
        },
      })));
      assert.deepStrictEqual(yield* observer.finish, {
        inputTokens: 8,
        outputTokens: 2,
        cachedInputTokens: 0,
        spendMicros: 0,
      });
    }));

  it.effect("discards oversized non-terminal events without retaining their payload", () =>
    Effect.gen(function*() {
      const observer = yield* makeOpenAITerminalUsageObserver({
        maximumEventBytes: 256,
      });
      yield* observer.observe(encoder.encode(sse({
        type: "response.output_text.delta",
        delta: "secret".repeat(1_000),
      })));
      yield* observer.observe(encoder.encode(sse({
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 5,
            input_tokens_details: { cached_tokens: 1 },
            output_tokens: 3,
          },
        },
      })));
      assert.deepStrictEqual(yield* observer.finish, {
        inputTokens: 5,
        outputTokens: 3,
        cachedInputTokens: 1,
        spendMicros: 0,
      });
    }));

  it.effect("fails closed for missing, malformed, or ambiguous terminal usage", () =>
    Effect.gen(function*() {
      const cases = [
        {
          expected: "terminal_usage_missing",
          source: sse({ type: "response.output_text.delta", delta: "x" }),
        },
        {
          expected: "terminal_usage_invalid",
          source: sse({
            type: "response.completed",
            response: {
              status: "completed",
              usage: { input_tokens: "5", output_tokens: 1 },
            },
          }),
        },
        {
          expected: "terminal_usage_invalid",
          source: sse({
            type: "response.completed",
            response: {
              status: "completed",
              usage: {
                input_tokens: 5,
                input_tokens_details: { cached_tokens: 6 },
                output_tokens: 1,
              },
            },
          }),
        },
        {
          expected: "terminal_usage_ambiguous",
          source: [
            sse({
              type: "response.completed",
              response: {
                status: "completed",
                usage: { input_tokens: 5, output_tokens: 1 },
              },
            }),
            sse({
              type: "response.done",
              response: {
                status: "completed",
                usage: { input_tokens: 5, output_tokens: 1 },
              },
            }),
          ].join(""),
        },
      ];
      for (const candidate of cases) {
        const observer = yield* makeOpenAITerminalUsageObserver({
          maximumEventBytes: 4_096,
        });
        yield* observer.observe(encoder.encode(candidate.source));
        const failure = yield* Effect.flip(observer.finish);
        assert.instanceOf(failure, OpenAITerminalUsageError);
        assert.strictEqual(failure.code, candidate.expected);
      }
    }));

  it.effect("rejects invalid memory bounds before observing provider data", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(makeOpenAITerminalUsageObserver({
        maximumEventBytes: 0,
      }));
      assert.instanceOf(failure, OpenAITerminalUsageError);
      assert.strictEqual(failure.code, "invalid_configuration");
    }));
});
