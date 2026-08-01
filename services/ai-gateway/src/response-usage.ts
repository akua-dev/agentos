import { Effect, Option, Ref, Schema } from "effect";

const SafeTokenCount = Schema.Number.pipe(
  Schema.check(Schema.makeFilter(
    (value) => Number.isSafeInteger(value) && value >= 0,
    { title: "safe non-negative token count" },
  )),
);

const TerminalTypeEnvelope = Schema.Struct({
  type: Schema.Literals(["response.completed", "response.done"]),
});

const TerminalEvent = Schema.Struct({
  type: Schema.Literals(["response.completed", "response.done"]),
  response: Schema.Struct({
    status: Schema.Literal("completed"),
    usage: Schema.Struct({
      input_tokens: SafeTokenCount,
      output_tokens: SafeTokenCount,
      input_tokens_details: Schema.optional(Schema.Struct({
        cached_tokens: Schema.optional(SafeTokenCount),
      })),
    }),
  }),
});

const OpenAITerminalUsageErrorCode = Schema.Literals([
  "invalid_configuration",
  "terminal_usage_missing",
  "terminal_usage_invalid",
  "terminal_usage_ambiguous",
]);

export class OpenAITerminalUsageError extends Schema.TaggedErrorClass<OpenAITerminalUsageError>()(
  "OpenAITerminalUsageError",
  { code: OpenAITerminalUsageErrorCode },
) {}

export interface OpenAITerminalUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly spendMicros: 0;
}

export interface OpenAITerminalUsageObserver {
  readonly observe: (
    chunk: Uint8Array,
  ) => Effect.Effect<void, OpenAITerminalUsageError>;
  readonly finish: Effect.Effect<
    OpenAITerminalUsage,
    OpenAITerminalUsageError
  >;
}

export interface OpenAITerminalUsageObserverOptions {
  readonly maximumEventBytes: number;
}

interface ObserverState {
  readonly lineBuffer: string;
  readonly lineBytes: number;
  readonly discardLine: boolean;
  readonly eventData: string;
  readonly eventBytes: number;
  readonly discardEvent: boolean;
  readonly terminalEvents: number;
  readonly terminalUsage: OpenAITerminalUsage | undefined;
  readonly terminalInvalid: boolean;
  readonly ended: boolean;
}

const initialState: ObserverState = {
  lineBuffer: "",
  lineBytes: 0,
  discardLine: false,
  eventData: "",
  eventBytes: 0,
  discardEvent: false,
  terminalEvents: 0,
  terminalUsage: undefined,
  terminalInvalid: false,
  ended: false,
};

export const makeOpenAITerminalUsageObserver = Effect.fn(
  "agentos.aiGateway.makeOpenAITerminalUsageObserver",
)(function*(options: OpenAITerminalUsageObserverOptions) {
  if (
    !Number.isSafeInteger(options.maximumEventBytes) ||
    options.maximumEventBytes < 1
  ) {
    return yield* usageError("invalid_configuration");
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();
  const state = yield* Ref.make(initialState);

  const observe = Effect.fn("agentos.aiGateway.observeOpenAIUsage")(
    function*(chunk: Uint8Array) {
      const text = yield* Effect.sync(() => decoder.decode(chunk, {
        stream: true,
      }));
      yield* Ref.update(
        state,
        (current) => current.ended
          ? current
          : consumeText(
            current,
            text,
            options.maximumEventBytes,
            encoder,
          ),
      );
    },
  );

  const finish = Effect.gen(function*() {
    const trailing = yield* Effect.sync(() => decoder.decode());
    const finalState = yield* Ref.modify(state, (current) => {
      if (current.ended) return [current, current];
      const consumed = consumeText(
        current,
        trailing,
        options.maximumEventBytes,
        encoder,
      );
      const withLine = consumed.discardLine
        ? resetLine(consumed)
        : consumed.lineBuffer.length > 0
          ? processLine(
            resetLine(consumed),
            stripCarriageReturn(consumed.lineBuffer),
            options.maximumEventBytes,
            encoder,
          )
          : consumed;
      const finalized = finalizeEvent(withLine);
      const ended = { ...finalized, ended: true };
      return [ended, ended];
    });
    if (finalState.terminalEvents > 1) {
      return yield* usageError("terminal_usage_ambiguous");
    }
    if (finalState.terminalInvalid) {
      return yield* usageError("terminal_usage_invalid");
    }
    if (finalState.terminalUsage === undefined) {
      return yield* usageError("terminal_usage_missing");
    }
    return finalState.terminalUsage;
  });

  return { observe, finish } satisfies OpenAITerminalUsageObserver;
});

function consumeText(
  initial: ObserverState,
  text: string,
  maximumEventBytes: number,
  encoder: TextEncoder,
): ObserverState {
  let state = initial;
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline;
    state = appendLineFragment(
      state,
      text.slice(offset, end),
      maximumEventBytes,
      encoder,
    );
    if (newline === -1) return state;
    if (state.discardLine) {
      state = resetLine(state);
    } else {
      const line = stripCarriageReturn(state.lineBuffer);
      state = processLine(
        resetLine(state),
        line,
        maximumEventBytes,
        encoder,
      );
    }
    offset = newline + 1;
  }
  return state;
}

function appendLineFragment(
  state: ObserverState,
  fragment: string,
  maximumEventBytes: number,
  encoder: TextEncoder,
): ObserverState {
  if (state.discardLine || fragment.length === 0) return state;
  const fragmentBytes = encoder.encode(fragment).byteLength;
  if (state.lineBytes + fragmentBytes > maximumEventBytes) {
    return {
      ...state,
      lineBuffer: "",
      lineBytes: 0,
      discardLine: true,
      discardEvent: true,
    };
  }
  return {
    ...state,
    lineBuffer: `${state.lineBuffer}${fragment}`,
    lineBytes: state.lineBytes + fragmentBytes,
  };
}

function resetLine(state: ObserverState): ObserverState {
  return {
    ...state,
    lineBuffer: "",
    lineBytes: 0,
    discardLine: false,
  };
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function processLine(
  state: ObserverState,
  line: string,
  maximumEventBytes: number,
  encoder: TextEncoder,
): ObserverState {
  if (line.length === 0) return finalizeEvent(state);
  if (state.discardEvent || line.startsWith(":")) return state;
  if (line !== "data" && !line.startsWith("data:")) return state;
  const raw = line === "data" ? "" : line.slice(5);
  const data = raw.startsWith(" ") ? raw.slice(1) : raw;
  const separator = state.eventData.length === 0 ? "" : "\n";
  const additionalBytes = encoder.encode(`${separator}${data}`).byteLength;
  if (state.eventBytes + additionalBytes > maximumEventBytes) {
    return {
      ...state,
      eventData: "",
      eventBytes: 0,
      discardEvent: true,
    };
  }
  return {
    ...state,
    eventData: `${state.eventData}${separator}${data}`,
    eventBytes: state.eventBytes + additionalBytes,
  };
}

function finalizeEvent(state: ObserverState): ObserverState {
  if (state.discardEvent || state.eventData.length === 0) {
    return resetEvent(state);
  }
  const envelope = Schema.decodeUnknownOption(
    Schema.fromJsonString(TerminalTypeEnvelope),
  )(state.eventData);
  if (Option.isNone(envelope)) return resetEvent(state);
  const terminalEvents = state.terminalEvents + 1;
  const terminal = Schema.decodeUnknownOption(
    Schema.fromJsonString(TerminalEvent),
  )(state.eventData);
  if (Option.isNone(terminal)) {
    return resetEvent({
      ...state,
      terminalEvents,
      terminalInvalid: true,
    });
  }
  const inputTokens = terminal.value.response.usage.input_tokens;
  const outputTokens = terminal.value.response.usage.output_tokens;
  const cachedInputTokens =
    terminal.value.response.usage.input_tokens_details?.cached_tokens ?? 0;
  if (cachedInputTokens > inputTokens) {
    return resetEvent({
      ...state,
      terminalEvents,
      terminalInvalid: true,
    });
  }
  return resetEvent({
    ...state,
    terminalEvents,
    terminalUsage: {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      spendMicros: 0,
    },
  });
}

function resetEvent(state: ObserverState): ObserverState {
  return {
    ...state,
    eventData: "",
    eventBytes: 0,
    discardEvent: false,
  };
}

function usageError(code: OpenAITerminalUsageError["code"]) {
  return OpenAITerminalUsageError.make({ code });
}
