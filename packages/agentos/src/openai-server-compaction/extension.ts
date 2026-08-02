import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient";
import * as BunPath from "@effect/platform-bun/BunPath";
import {
  compact,
  convertToLlm,
  serializeConversation,
  type CompactionResult,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionMessageEntry,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
  Clock,
  Config,
  Effect,
  FileSystem,
  Layer,
  Result,
  Schema,
} from "effect";

import {
  OpenAICompactionHttpError,
  requestServerCompaction,
  supportsServerCompaction,
  type OpenAICompactionModel,
  type OpenAICompactionReasoning,
  type OpenAICompactionTool,
  type ServerCompactionRequest,
  type ServerCompactionResult,
} from "./remote.ts";
import { normalizeResponseItemsForPrompt } from "./messages.ts";
import {
  parseJsonObject,
  parseJsonValue,
  type JsonObject,
  type ResponseUsage,
} from "./schemas.ts";
import {
  buildCompactionInput,
  nativeCompactionDetails,
  NATIVE_DETAILS_KEY,
  rewriteResponsesPayload,
} from "./session.ts";
import {
  isGatewaySecurityHeader,
  resolvePiWorkloadIdentity,
  type PiWorkloadIdentityOptions,
} from "../access/pi-workload-identity.ts";
import {
  legacyEnvironmentConfigLayer,
  runPromiseLegacy,
} from "../shared/legacy.ts";
import type { AgentOSTelemetrySource } from "../telemetry/auxiliary.ts";
import {
  agentOSRouteForModel,
  safeAssistantFailure,
  safeTokenCount,
  startAgentOSAuxiliaryOperation,
} from "../telemetry/auxiliary.ts";
import type {
  AgentOSProviderAttempt,
  AgentOSProviderAttemptOutcome,
} from "../telemetry/runtime.ts";

type ResolvedAuth = {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
};

type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type CompleteResult = Awaited<ReturnType<typeof complete>>;

export type LocalCompactionRequest = {
  event: SessionBeforeCompactEvent;
  model: OpenAICompactionModel;
  auth: ResolvedAuth;
  thinkingLevel: PiThinkingLevel;
  telemetry?: LocalCompactionTelemetry;
};

export type LocalCompactionTelemetry = {
  currentAttempt(): AgentOSProviderAttempt;
  startFallbackAttempt(): void;
};

export type LocalSummaryImplementations = {
  complete(
    ...args: Parameters<typeof complete>
  ): Effect.Effect<CompleteResult, unknown>;
  compact(
    ...args: Parameters<typeof compact>
  ): Effect.Effect<CompactionResult, unknown>;
  readonly now: Effect.Effect<number>;
};

export type OpenAIServerCompactionConfig = {
  readonly enabled: boolean;
  readonly remoteTimeoutMs?: number;
};

export type OpenAIServerCompactionDependencies = {
  runLocalCompaction(
    request: LocalCompactionRequest,
  ): Effect.Effect<CompactionResult, unknown>;
  runServerCompaction(
    request: ServerCompactionRequest,
  ): Effect.Effect<ServerCompactionResult, unknown>;
  readonly config?: Effect.Effect<OpenAIServerCompactionConfig, unknown>;
  readonly telemetry?: AgentOSTelemetrySource;
  readonly workloadIdentity?: PiWorkloadIdentityOptions;
};

const LocalSummaryFailureCode = Schema.Literals([
  "portable_provider_failed",
  "portable_request_failed",
]);

class LocalSummaryFailure extends Schema.TaggedErrorClass<LocalSummaryFailure>()(
  "LocalSummaryFailure",
  {
    cause: Schema.Unknown,
    code: LocalSummaryFailureCode,
    inputTokens: Schema.optional(Schema.Number),
    outputTokens: Schema.optional(Schema.Number),
    status: Schema.optional(Schema.Number),
    streamOutcome: Schema.Literals(["aborted", "upstream_error"]),
  },
) {}

const ExtensionFailureCode = Schema.Literals([
  "model_registry_unavailable",
  "telemetry_unavailable",
]);

export class OpenAIServerCompactionExtensionError extends Schema.TaggedErrorClass<OpenAIServerCompactionExtensionError>()(
  "OpenAIServerCompactionExtensionError",
  {
    cause: Schema.Unknown,
    code: ExtensionFailureCode,
  },
) {}

const compactionPlatformLayer = Layer.mergeAll(
  BunCrypto.layer,
  BunFileSystem.layer,
  BunHttpClient.layer,
  BunPath.layer,
);

const openAIServerCompactionConfig = Config.all({
  enabledValue: Config.string(
    "AGENTOS_OPENAI_SERVER_COMPACTION_ENABLED",
  ).pipe(Config.withDefault("")),
  timeoutValue: Config.string(
    "AGENTOS_OPENAI_SERVER_COMPACTION_TIMEOUT_MS",
  ).pipe(Config.withDefault("")),
}).pipe(
  Effect.map(({ enabledValue, timeoutValue }) => {
    const normalizedEnabled = enabledValue.trim().toLowerCase();
    const timeout = Number(timeoutValue.trim());
    return {
      enabled: !["0", "false", "no", "off"].includes(normalizedEnabled),
      ...(Number.isFinite(timeout) && timeout > 0
        ? { remoteTimeoutMs: Math.floor(timeout) }
        : {}),
    } satisfies OpenAIServerCompactionConfig;
  }),
);

function mergedHeaders(
  modelHeaders: Record<string, string> | undefined,
  resolvedHeaders: Record<string, string> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  const names = new Map<string, string>();
  for (const [name, value] of Object.entries(modelHeaders ?? {})) {
    result[name] = value;
    names.set(name.toLowerCase(), name);
  }
  for (const [name, value] of Object.entries(resolvedHeaders ?? {})) {
    const previous = names.get(name.toLowerCase());
    if (previous) delete result[previous];
    result[name] = value;
    names.set(name.toLowerCase(), name);
  }
  return result;
}

function toolsPayload(
  allTools: ToolInfo[],
  activeTools: string[],
): OpenAICompactionTool[] {
  const active = new Set(activeTools);
  return allTools
    .filter((tool) => active.has(tool.name))
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }));
}

function reasoningFor(
  level: PiThinkingLevel,
  model: OpenAICompactionModel,
): OpenAICompactionReasoning | undefined {
  if (!model.reasoning) return undefined;
  const effort = level === "max" ? "xhigh" : level === "off" ? "none" : level;
  return { effort, summary: "auto" };
}

function portableSummaryPrompt(
  conversation: string,
  customInstructions: string | undefined,
): string {
  const custom = customInstructions?.trim();
  const instructionSuffix = custom
    ? `\n\nAdditional summarization instructions:\n${custom}`
    : "";
  return `Summarize this conversation for future continuation in pi. Preserve goals, decisions, important facts, file paths, open questions, and next steps. Be concise but include information needed to continue work.${instructionSuffix}\n\n<conversation>\n${conversation}\n</conversation>`;
}

function portableFallbackSummary(model: OpenAICompactionModel): string {
  const hostname = model.baseUrl && URL.canParse(model.baseUrl)
    ? new URL(model.baseUrl).hostname
    : "api.openai.com";
  return `OpenAI remote compaction applied for ${model.provider}/${model.id} via ${hostname}. Pi keeps this textual summary for portability, while compatible future OpenAI turns can use provider-native replacement history stored in compaction details.`;
}

const localSummaryDefaults: LocalSummaryImplementations = {
  complete: (...args) =>
    Effect.tryPromise({
      try: () => complete(...args),
      catch: (cause) => cause,
    }),
  compact: (...args) =>
    Effect.tryPromise({
      try: () => compact(...args),
      catch: (cause) => cause,
    }),
  now: Clock.currentTimeMillis,
};

export function generateBestEffortLocalSummary(
  request: LocalCompactionRequest,
  implementations: LocalSummaryImplementations = localSummaryDefaults,
): Effect.Effect<CompactionResult, unknown> {
  const portable = Effect.gen(function*() {
    const messages = request.event.branchEntries
      .filter(
        (entry): entry is SessionMessageEntry =>
          entry.type === "message" && "message" in entry,
      )
      .map((entry) => entry.message);
    const conversation = serializeConversation(convertToLlm(messages));
    const timestamp = yield* implementations.now;
    const response = yield* implementations.complete(
      request.model,
      {
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: portableSummaryPrompt(
                  conversation,
                  request.event.customInstructions,
                ),
              },
            ],
            timestamp,
          },
        ],
      },
      {
        apiKey: request.auth.apiKey,
        headers: request.auth.headers,
        maxTokens: 4096,
        signal: request.event.signal,
        env: request.auth.env,
      },
    ).pipe(
      Effect.mapError((cause) =>
        LocalSummaryFailure.make({
          cause,
          code: "portable_request_failed",
          streamOutcome: "upstream_error",
        })
      ),
    );
    const failure = safeAssistantFailure(response.stopReason);
    if (failure !== undefined) {
      return yield* LocalSummaryFailure.make({
        cause: failure,
        code: "portable_provider_failed",
        status: 200,
        streamOutcome: response.stopReason === "aborted"
          ? "aborted"
          : "upstream_error",
        ...(safeTokenCount(response.usage.input) === undefined
          ? {}
          : { inputTokens: safeTokenCount(response.usage.input) }),
        ...(safeTokenCount(response.usage.output) === undefined
          ? {}
          : { outputTokens: safeTokenCount(response.usage.output) }),
      });
    }
    const summary = response.content
      .filter(
        (item): item is Extract<typeof item, { type: "text" }> =>
          item.type === "text",
      )
      .map((item) => item.text)
      .join("\n")
      .trim();
    return {
      summary: summary || portableFallbackSummary(request.model),
      firstKeptEntryId: request.event.preparation.firstKeptEntryId,
      tokensBefore: request.event.preparation.tokensBefore,
    } satisfies CompactionResult;
  });

  return portable.pipe(
    Effect.catch((failure) =>
      Effect.gen(function*() {
        yield* Effect.sync(() => {
          request.telemetry?.currentAttempt().end({
            ...(failure.status === undefined ? {} : { status: failure.status }),
            error: failure.cause,
            streamOutcome: failure.streamOutcome,
            ...(failure.inputTokens === undefined
              ? {}
              : { inputTokens: failure.inputTokens }),
            ...(failure.outputTokens === undefined
              ? {}
              : { outputTokens: failure.outputTokens }),
          });
          request.telemetry?.startFallbackAttempt();
        });
        return yield* implementations.compact(
          request.event.preparation,
          request.model,
          request.auth.apiKey,
          request.auth.headers,
          request.event.customInstructions,
          request.event.signal,
          request.thinkingLevel,
          undefined,
          request.auth.env,
        );
      })
    ),
  );
}

function defaultLocalCompaction(request: LocalCompactionRequest) {
  return generateBestEffortLocalSummary(request);
}

function defaultServerCompaction(request: ServerCompactionRequest) {
  return requestServerCompaction(request).pipe(
    Effect.provide(compactionPlatformLayer),
  );
}

const defaults: OpenAIServerCompactionDependencies = {
  runLocalCompaction: defaultLocalCompaction,
  runServerCompaction: defaultServerCompaction,
};

function mergedDetails(
  localDetails: unknown,
  nativeDetails: ReturnType<typeof nativeCompactionDetails>,
): JsonObject {
  const localObject = parseJsonObject(localDetails);
  if (localObject) return { ...localObject, ...nativeDetails };
  const localValue = parseJsonValue(localDetails);
  return {
    ...(localValue !== undefined ? { piCompactionDetails: localValue } : {}),
    ...nativeDetails,
  };
}

function finiteNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function normalizedServerUsage(
  model: OpenAICompactionModel,
  raw: ResponseUsage | undefined,
): Usage | undefined {
  if (!raw) return undefined;
  const inputDetails = raw.input_tokens_details;
  const outputDetails = raw.output_tokens_details;
  const inputTokens = finiteNumber(raw.input_tokens);
  const cacheRead = finiteNumber(inputDetails?.cached_tokens);
  const cacheWrite = finiteNumber(inputDetails?.cache_write_tokens);
  const output = finiteNumber(raw.output_tokens);
  const usage: Usage = {
    input: Math.max(0, inputTokens - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    reasoning: finiteNumber(outputDetails?.reasoning_tokens),
    totalTokens: finiteNumber(raw.total_tokens) || inputTokens + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function combinedUsage(
  local: Usage | undefined,
  remote: Usage | undefined,
): Usage | undefined {
  if (!local) return remote;
  if (!remote) return local;
  return {
    input: local.input + remote.input,
    output: local.output + remote.output,
    cacheRead: local.cacheRead + remote.cacheRead,
    cacheWrite: local.cacheWrite + remote.cacheWrite,
    reasoning: (local.reasoning ?? 0) + (remote.reasoning ?? 0),
    totalTokens: local.totalTokens + remote.totalTokens,
    cost: {
      input: local.cost.input + remote.cost.input,
      output: local.cost.output + remote.cost.output,
      cacheRead: local.cost.cacheRead + remote.cost.cacheRead,
      cacheWrite: local.cost.cacheWrite + remote.cost.cacheWrite,
      total: local.cost.total + remote.cost.total,
    },
  };
}

function startTelemetryOperation(
  model: OpenAICompactionModel,
  telemetry: AgentOSTelemetrySource | undefined,
) {
  return Effect.tryPromise({
    try: () => startAgentOSAuxiliaryOperation(model, telemetry, "resumed"),
    catch: (cause) =>
      OpenAIServerCompactionExtensionError.make({
        cause,
        code: "telemetry_unavailable",
      }),
  });
}

function resolveModelAuth(
  ctx: ExtensionContext,
  model: OpenAICompactionModel,
) {
  return Effect.tryPromise({
    try: () => ctx.modelRegistry.getApiKeyAndHeaders(model),
    catch: (cause) =>
      OpenAIServerCompactionExtensionError.make({
        cause,
        code: "model_registry_unavailable",
      }),
  });
}

function handleCompaction(
  pi: ExtensionAPI,
  dependencies: OpenAIServerCompactionDependencies,
  requestShapes: Map<string, ProviderRequestShape>,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
) {
  return Effect.gen(function*() {
    const config = yield* dependencies.config ?? openAIServerCompactionConfig;
    const model = ctx.model;
    if (!config.enabled || !supportsServerCompaction(model)) return undefined;

    const resolved = yield* resolveModelAuth(ctx, model);
    if (!resolved.ok) return undefined;
    const workloadIdentity = yield* resolvePiWorkloadIdentity(
      model,
      dependencies.workloadIdentity,
    );
    if (workloadIdentity.active && workloadIdentity.headers === undefined) {
      return undefined;
    }
    const hasAuthorization = Object.keys(resolved.headers ?? {}).some(
      (name) => name.toLowerCase() === "authorization",
    );
    if (!workloadIdentity.active && !resolved.apiKey && !hasAuthorization) {
      return undefined;
    }

    const thinkingLevel = pi.getThinkingLevel();
    const telemetryOperation = yield* startTelemetryOperation(
      model,
      dependencies.telemetry,
    );
    const startPortableAttempt = () =>
      telemetryOperation.startProviderAttempt({
        compactionPath: "portable_summary",
        requestKind: "compaction",
        streamMode: "non_streaming",
      });
    let localAttempt = startPortableAttempt();
    const remoteAttempt = telemetryOperation.startProviderAttempt({
      compactionPath: "native_server",
      requestKind: "compaction",
      streamMode: model.provider === "openai-codex"
        ? "streaming"
        : "non_streaming",
    });
    const baseHeaders = mergedHeaders(model.headers, resolved.headers);
    if (workloadIdentity.active) {
      for (const name of Object.keys(baseHeaders)) {
        if (isGatewaySecurityHeader(name)) delete baseHeaders[name];
      }
      Object.assign(baseHeaders, workloadIdentity.headers);
    }
    const localHeaders = { ...baseHeaders };
    const remoteHeaders = { ...baseHeaders };
    localAttempt.inject(localHeaders);
    remoteAttempt.inject(remoteHeaders);
    const localRequest: LocalCompactionRequest = {
      event,
      model,
      auth: {
        ...resolved,
        ...(workloadIdentity.active ? { apiKey: undefined } : {}),
        headers: localHeaders,
      },
      thinkingLevel,
      telemetry: {
        currentAttempt: () => localAttempt,
        startFallbackAttempt: () => {
          localAttempt = startPortableAttempt();
          localAttempt.inject(localHeaders);
        },
      },
    };
    const shapeKey = requestShapeKey(ctx);
    const requestShape = requestShapes.get(shapeKey);
    requestShapes.delete(shapeKey);
    const remoteRequest: ServerCompactionRequest = {
      model,
      route: agentOSRouteForModel(model),
      apiKey: workloadIdentity.active ? undefined : resolved.apiKey,
      headers: remoteHeaders,
      sessionId: ctx.sessionManager.getSessionId(),
      input: normalizeResponseItemsForPrompt(
        buildCompactionInput(
          event.branchEntries,
          model.provider,
          model.api,
          model.id,
        ),
        model,
      ),
      instructions: ctx.getSystemPrompt(),
      tools: toolsPayload(pi.getAllTools(), pi.getActiveTools()),
      reasoning: requestShape?.reasoning ?? reasoningFor(thinkingLevel, model),
      text: requestShape?.text,
      signal: event.signal,
      timeoutMs: config.remoteTimeoutMs,
    };

    const [local, remote] = yield* Effect.all([
      Effect.result(
        observeCompactionAttempt(
          () => localAttempt,
          dependencies.runLocalCompaction(localRequest),
          (result) => ({
            inputTokens: safeTokenCount(result.usage?.input),
            outputTokens: safeTokenCount(result.usage?.output),
          }),
        ),
      ),
      Effect.result(
        observeCompactionAttempt(
          remoteAttempt,
          dependencies.runServerCompaction(remoteRequest),
          (result) => ({
            inputTokens: safeTokenCount(result.usage?.input_tokens),
            outputTokens: safeTokenCount(result.usage?.output_tokens),
          }),
        ),
      ),
    ], { concurrency: "unbounded" });

    if (Result.isFailure(local)) {
      telemetryOperation.end({ error: local.failure });
      return undefined;
    }
    telemetryOperation.end({ status: 200 });
    if (Result.isFailure(remote)) {
      if (!event.signal.aborted && ctx.hasUI) {
        yield* Effect.sync(() =>
          ctx.ui.notify(
            "OpenAI server compaction unavailable; using Pi's portable summary.",
            "warning",
          )
        );
      }
      return { compaction: local.success };
    }

    const native = nativeCompactionDetails(
      model.provider,
      model.api,
      model.id,
      remote.success.output,
      remote.success.usage,
    );
    return {
      compaction: {
        ...local.success,
        usage: combinedUsage(
          local.success.usage,
          normalizedServerUsage(model, remote.success.usage),
        ),
        details: mergedDetails(local.success.details, native),
      },
    };
  });
}

function observeCompactionAttempt<T, E>(
  attempt: AgentOSProviderAttempt | (() => AgentOSProviderAttempt),
  run: Effect.Effect<T, E>,
  counts: (
    result: T,
  ) => Pick<
    AgentOSProviderAttemptOutcome,
    "inputTokens" | "outputTokens"
  >,
) {
  return run.pipe(
    Effect.tap((result) =>
      Effect.sync(() =>
        resolveAttempt(attempt).end({
          status: 200,
          streamOutcome: "completed",
          ...counts(result),
        })
      )
    ),
    Effect.tapError((error) =>
      Effect.sync(() =>
        resolveAttempt(attempt).end({
          ...(error instanceof OpenAICompactionHttpError
            ? { status: error.status }
            : {}),
          error,
          streamOutcome: "upstream_error",
        })
      )
    ),
  );
}

function resolveAttempt(
  attempt: AgentOSProviderAttempt | (() => AgentOSProviderAttempt),
): AgentOSProviderAttempt {
  return typeof attempt === "function" ? attempt() : attempt;
}

type ProviderRequestShape = {
  reasoning?: JsonObject;
  text?: JsonObject;
};

function requestShapeKey(ctx: ExtensionContext): string {
  const model = ctx.model;
  return [
    ctx.sessionManager.getSessionId(),
    model?.provider,
    model?.api,
    model?.id,
  ].join("\u0000");
}

function requestShapeFromPayload(
  payload: unknown,
): ProviderRequestShape | undefined {
  const parsed = parseJsonObject(payload);
  if (!parsed) return undefined;
  const reasoning = parseJsonObject(parsed.reasoning);
  const text = parseJsonObject(parsed.text);
  if (!reasoning && !text) return undefined;
  return {
    ...(reasoning ? { reasoning } : {}),
    ...(text ? { text } : {}),
  };
}

function handleProviderRequest(
  dependencies: OpenAIServerCompactionDependencies,
  requestShapes: Map<string, ProviderRequestShape>,
  payload: unknown,
  ctx: ExtensionContext,
) {
  return Effect.gen(function*() {
    const config = yield* dependencies.config ?? openAIServerCompactionConfig;
    const model = ctx.model;
    if (!config.enabled || !supportsServerCompaction(model)) return undefined;
    const key = requestShapeKey(ctx);
    requestShapes.delete(key);
    const requestShape = requestShapeFromPayload(payload);
    if (requestShape) requestShapes.set(key, requestShape);
    return rewriteResponsesPayload(
      payload,
      ctx.sessionManager.getBranch(),
      model.provider,
      model.api,
      model.id,
    );
  });
}

function runExtensionEffect<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
) {
  return runPromiseLegacy(
    effect.pipe(
      Effect.provide(Layer.merge(
        compactionPlatformLayer,
        legacyEnvironmentConfigLayer(),
      )),
    ),
  );
}

export function createOpenAIServerCompactionExtension(
  dependencies: OpenAIServerCompactionDependencies = defaults,
) {
  return (pi: ExtensionAPI) => {
    const requestShapes = new Map<string, ProviderRequestShape>();
    const clearRequestShapes = () =>
      runExtensionEffect(Effect.sync(() => requestShapes.clear()));
    pi.on("session_before_compact", (event, ctx) =>
      runExtensionEffect(
        handleCompaction(pi, dependencies, requestShapes, event, ctx),
      )
    );
    pi.on("before_provider_request", (event, ctx) =>
      runExtensionEffect(
        handleProviderRequest(dependencies, requestShapes, event.payload, ctx),
      )
    );
    pi.on("session_start", clearRequestShapes);
    pi.on("session_before_switch", clearRequestShapes);
    pi.on("session_before_fork", clearRequestShapes);
    pi.on("session_before_tree", clearRequestShapes);
    pi.on("session_tree", clearRequestShapes);
    pi.on("session_compact", clearRequestShapes);
    pi.on("model_select", clearRequestShapes);
    pi.on("session_shutdown", clearRequestShapes);
  };
}

export { NATIVE_DETAILS_KEY };
export default createOpenAIServerCompactionExtension();
