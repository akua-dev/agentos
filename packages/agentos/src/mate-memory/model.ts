import type { Api, Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { Clock, Effect, Schema } from "effect";

import type { StartupMemoryContext } from "../memory/store.ts";
import type { AgentOSTelemetrySource } from "../telemetry/auxiliary.ts";
import type { AgentOSTelemetryRuntime } from "../telemetry/runtime-context.ts";
import {
  safeAssistantFailure,
  safeTokenCount,
  startAgentOSAuxiliaryOperation,
} from "../telemetry/auxiliary.ts";
import {
  redactAuxiliaryInput,
  RELEVANT_SELECTION_SYSTEM_PROMPT,
} from "./prompts.ts";

type CompleteResult = Awaited<ReturnType<typeof complete>>;

export type RelevantSelectionAuth =
  | {
    readonly ok: true;
    readonly apiKey?: string;
    readonly headers?: Record<string, string>;
    readonly env?: Record<string, string>;
  }
  | { readonly ok: false; readonly error: string };

export interface RelevantSelectionInput {
  readonly prompt: string;
  readonly startup: StartupMemoryContext;
  readonly model: Model<Api> | undefined;
  readonly resolveAuth: Effect.Effect<RelevantSelectionAuth, unknown>;
  readonly signal?: AbortSignal;
  readonly telemetry?: AgentOSTelemetrySource;
  readonly telemetryRuntime?: AgentOSTelemetryRuntime;
  readonly completeImpl?: (
    ...args: Parameters<typeof complete>
  ) => Effect.Effect<CompleteResult, unknown>;
  readonly now?: Effect.Effect<number>;
}

export type RelevantTopicSelector = (
  input: RelevantSelectionInput,
) => Effect.Effect<ReadonlyArray<string>, RelevantSelectionError>;

const RelevantSelectionErrorCode = Schema.Literals([
  "authentication_unavailable",
  "invalid_response",
  "provider_failed",
  "request_failed",
  "telemetry_unavailable",
]);

export class RelevantSelectionError extends Schema.TaggedErrorClass<RelevantSelectionError>()(
  "RelevantSelectionError",
  {
    cause: Schema.Unknown,
    code: RelevantSelectionErrorCode,
    message: Schema.String,
  },
) {}

const SelectionResponseSchema = Schema.Struct({
  ids: Schema.Array(Schema.String),
});
const SelectionResponseJson = Schema.fromJsonString(SelectionResponseSchema);
const SelectionRequestJson = Schema.fromJsonString(Schema.Unknown);

function selectionError(
  code: RelevantSelectionError["code"],
  message: string,
  cause: unknown,
) {
  return RelevantSelectionError.make({ cause, code, message });
}

function relevantTopicId(index: number): string {
  return `topic-${index}`;
}

export function relevantSelectionMessage(
  input: Pick<RelevantSelectionInput, "prompt" | "startup">,
) {
  return Schema.encodeEffect(SelectionRequestJson)({
    request: redactAuxiliaryInput(input.prompt),
    index: redactAuxiliaryInput(input.startup.index),
    inventory: input.startup.inventory.map((topic, index) => ({
      id: relevantTopicId(index),
      type: redactAuxiliaryInput(topic.type),
      scope: redactAuxiliaryInput(topic.scope),
      modified: redactAuxiliaryInput(topic.modified),
      pinned: topic.pinned,
    })),
  }).pipe(
    Effect.mapError((cause) =>
      selectionError(
        "request_failed",
        "Mate memory selector request could not be encoded.",
        cause,
      )
    ),
  );
}

export function resolveRelevantTopicIds(
  ids: ReadonlyArray<string>,
  inventory: RelevantSelectionInput["startup"]["inventory"],
): ReadonlyArray<string> {
  const pathsById = new Map(
    inventory.map((topic, index) => [relevantTopicId(index), topic.relativePath]),
  );
  return ids.flatMap((id) => {
    const path = pathsById.get(id);
    return path === undefined ? [] : [path];
  });
}

function defaultComplete(
  ...args: Parameters<typeof complete>
): Effect.Effect<CompleteResult, RelevantSelectionError> {
  return Effect.tryPromise({
    try: () => complete(...args),
    catch: (cause) =>
      selectionError(
        "request_failed",
        "Mate memory selector request failed.",
        cause,
      ),
  });
}

function startTelemetry(input: RelevantSelectionInput, model: Model<Api>) {
  return startAgentOSAuxiliaryOperation(
    model,
    input.telemetry,
    "resumed",
    input.telemetryRuntime,
  );
}

export const selectRelevantTopics: RelevantTopicSelector = (input) =>
  Effect.gen(function*() {
    const model = input.model;
    if (model === undefined || input.startup.inventory.length === 0) return [];
    const auth = yield* input.resolveAuth.pipe(
      Effect.mapError((cause) =>
        selectionError(
          "authentication_unavailable",
          "Mate memory selector authentication could not be resolved.",
          cause,
        )
      ),
    );
    if (!auth.ok) {
      return yield* selectionError(
        "authentication_unavailable",
        "Mate memory selector authentication is unavailable.",
        auth.error,
      );
    }
    const operation = yield* startTelemetry(input, model);
    const attempt = yield* operation.startProviderAttempt({
      requestKind: "extension",
      streamMode: "non_streaming",
    });
    const headers = { ...auth.headers };
    yield* attempt.inject(headers);
    const message = yield* relevantSelectionMessage(input);
    const timestamp = yield* input.now ?? Clock.currentTimeMillis;
    const provider = (input.completeImpl ?? defaultComplete)(
      model,
      {
        systemPrompt: RELEVANT_SELECTION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: message,
            timestamp,
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers,
        env: auth.env,
        signal: input.signal,
        temperature: 0,
        maxTokens: 1_024,
      },
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof RelevantSelectionError
          ? cause
          : selectionError(
            "request_failed",
            "Mate memory selector request failed.",
            cause,
          )
      ),
      Effect.tap((response) => {
        const failure = safeAssistantFailure(response.stopReason);
        return attempt.end({
            status: 200,
            error: failure,
            streamOutcome: failure === undefined
              ? "completed"
              : response.stopReason === "aborted"
              ? "aborted"
              : "upstream_error",
            inputTokens: safeTokenCount(response.usage.input),
            outputTokens: safeTokenCount(response.usage.output),
          });
      }),
      Effect.tapError((error) =>
        attempt.end({ error, streamOutcome: "upstream_error" })
      ),
    );

    const selected = yield* Effect.gen(function*() {
      const response = yield* provider;
      const failure = safeAssistantFailure(response.stopReason);
      if (failure !== undefined) {
        return yield* selectionError(
          "provider_failed",
          response.stopReason === "aborted"
            ? "Mate memory selector was aborted."
            : "Mate memory selector provider failed.",
          failure,
        );
      }
      const text = response.content
        .flatMap((part) => part.type === "text" ? [part.text] : [])
        .join("");
      const decoded = yield* Schema.decodeUnknownEffect(
        SelectionResponseJson,
        { onExcessProperty: "error" },
      )(text).pipe(
        Effect.mapError((cause) =>
          selectionError(
            "invalid_response",
            "Mate memory selector returned an invalid ID response.",
            cause,
          )
        ),
      );
      return resolveRelevantTopicIds(decoded.ids, input.startup.inventory);
    }).pipe(
      Effect.tap(() => operation.end({ status: 200 })),
      Effect.tapError((error) => operation.end({ error })),
    );
    return selected;
  });
