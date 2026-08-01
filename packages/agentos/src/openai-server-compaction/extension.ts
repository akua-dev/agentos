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
  requestServerCompaction,
  OpenAICompactionHttpError,
  supportsServerCompaction,
  type OpenAICompactionModel,
  type OpenAICompactionReasoning,
  type OpenAICompactionTool,
  type ServerCompactionRequest,
  type ServerCompactionResult,
} from "./remote.ts";
import { normalizeResponseItemsForPrompt } from "./messages.ts";
import {
  JsonObjectSchema,
  JsonValueSchema,
  type JsonObject,
  type ResponseUsage,
} from "./schemas.ts";
import {
  buildCompactionInput,
  nativeCompactionDetails,
  NATIVE_DETAILS_KEY,
  rewriteResponsesPayload,
} from "./session.ts";
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
import {
  isGatewaySecurityHeader,
  resolvePiWorkloadIdentity,
  type PiWorkloadIdentityOptions,
} from "../access/pi-workload-identity.ts";
import { runPromiseLegacy } from "../shared/legacy.ts";

type ResolvedAuth = {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
};

type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

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

type LocalSummaryImplementations = {
  complete: typeof complete;
  compact: typeof compact;
  now: () => number;
};

export type OpenAIServerCompactionDependencies = {
  runLocalCompaction(request: LocalCompactionRequest): Promise<CompactionResult>;
  runServerCompaction(request: ServerCompactionRequest): Promise<ServerCompactionResult>;
  telemetry?: AgentOSTelemetrySource;
  workloadIdentity?: PiWorkloadIdentityOptions;
};

function isEnabled(): boolean {
  const value = process.env.AGENTOS_OPENAI_SERVER_COMPACTION_ENABLED?.trim().toLowerCase();
  return value === undefined || !["0", "false", "no", "off"].includes(value);
}

function configuredRemoteTimeout(): number | undefined {
  const value = Number(process.env.AGENTOS_OPENAI_SERVER_COMPACTION_TIMEOUT_MS?.trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

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

function toolsPayload(allTools: ToolInfo[], activeTools: string[]): OpenAICompactionTool[] {
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
  let hostname = "api.openai.com";
  try {
    if (model.baseUrl) hostname = new URL(model.baseUrl).hostname;
  } catch {
    // A malformed custom base URL should not prevent portable fallback text.
  }
  return `OpenAI remote compaction applied for ${model.provider}/${model.id} via ${hostname}. Pi keeps this textual summary for portability, while compatible future OpenAI turns can use provider-native replacement history stored in compaction details.`;
}

const localSummaryDefaults: LocalSummaryImplementations = {
  complete,
  compact,
  now: Date.now,
};

export async function generateBestEffortLocalSummary(
  request: LocalCompactionRequest,
  implementations: LocalSummaryImplementations = localSummaryDefaults,
): Promise<CompactionResult> {
  let portableAttemptEnded = false;
  try {
    const messages = request.event.branchEntries
      .filter(
        (entry): entry is SessionMessageEntry =>
          entry.type === "message" && "message" in entry,
      )
      .map((entry) => entry.message);
    const conversation = serializeConversation(convertToLlm(messages));
    const response = await implementations.complete(
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
            timestamp: implementations.now(),
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
    );
    const failure = safeAssistantFailure(response.stopReason);
    if (failure) {
      portableAttemptEnded = true;
      request.telemetry?.currentAttempt().end({
        status: 200,
        error: failure,
        streamOutcome:
          response.stopReason === "aborted" ? "aborted" : "upstream_error",
        inputTokens: safeTokenCount(response.usage.input),
        outputTokens: safeTokenCount(response.usage.output),
      });
      request.telemetry?.startFallbackAttempt();
      throw new Error(
        response.stopReason === "aborted"
          ? "OpenAI portable compaction aborted"
          : "OpenAI portable compaction failed",
      );
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
    };
  } catch (error) {
    if (!portableAttemptEnded) {
      request.telemetry?.currentAttempt().end({
        error,
        streamOutcome: "upstream_error",
      });
      request.telemetry?.startFallbackAttempt();
    }
    return implementations.compact(
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
  }
}

async function defaultLocalCompaction(
  request: LocalCompactionRequest,
): Promise<CompactionResult> {
  return generateBestEffortLocalSummary(request);
}

const defaults: OpenAIServerCompactionDependencies = {
  runLocalCompaction: defaultLocalCompaction,
  runServerCompaction: requestServerCompaction,
};

function mergedDetails(
  localDetails: unknown,
  nativeDetails: ReturnType<typeof nativeCompactionDetails>,
): JsonObject {
  const localObject = JsonObjectSchema.safeParse(localDetails);
  if (localObject.success) return { ...localObject.data, ...nativeDetails };
  const localValue = JsonValueSchema.safeParse(localDetails);
  return {
    ...(localValue.success ? { piCompactionDetails: localValue.data } : {}),
    ...nativeDetails,
  };
}

function finiteNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
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

function combinedUsage(local: Usage | undefined, remote: Usage | undefined): Usage | undefined {
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

async function handleCompaction(
  pi: ExtensionAPI,
  dependencies: OpenAIServerCompactionDependencies,
  requestShapes: Map<string, ProviderRequestShape>,
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
) {
  const model = ctx.model;
  if (!isEnabled() || !supportsServerCompaction(model)) return undefined;

  const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!resolved.ok) return undefined;
  const workloadIdentity = await runPromiseLegacy(
    resolvePiWorkloadIdentity(model, dependencies.workloadIdentity),
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
  const telemetryOperation = await startAgentOSAuxiliaryOperation(
    model,
    dependencies.telemetry,
    "resumed",
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
    streamMode: model.provider === "openai-codex" ? "streaming" : "non_streaming",
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
  const localRequest = {
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
  const requestShape = requestShapes.get(requestShapeKey(ctx));
  requestShapes.delete(requestShapeKey(ctx));
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
    timeoutMs: configuredRemoteTimeout(),
  };

  const [local, remote] = await Promise.allSettled([
    observeCompactionAttempt(
      () => localAttempt,
      () => dependencies.runLocalCompaction(localRequest),
      (result) => ({
        inputTokens: safeTokenCount(result.usage?.input),
        outputTokens: safeTokenCount(result.usage?.output),
      }),
    ),
    observeCompactionAttempt(
      remoteAttempt,
      () => dependencies.runServerCompaction(remoteRequest),
      (result) => ({
        inputTokens: safeTokenCount(result.usage?.input_tokens),
        outputTokens: safeTokenCount(result.usage?.output_tokens),
      }),
    ),
  ]);

  if (local.status !== "fulfilled") {
    telemetryOperation.end({ error: local.reason });
    return undefined;
  }
  telemetryOperation.end({ status: 200 });
  if (remote.status !== "fulfilled") {
    if (!event.signal.aborted && ctx.hasUI) {
      ctx.ui.notify("OpenAI server compaction unavailable; using Pi's portable summary.", "warning");
    }
    return { compaction: local.value };
  }

  const native = nativeCompactionDetails(
    model.provider,
    model.api,
    model.id,
    remote.value.output,
    remote.value.usage,
  );
  return {
    compaction: {
      ...local.value,
      usage: combinedUsage(local.value.usage, normalizedServerUsage(model, remote.value.usage)),
      details: mergedDetails(local.value.details, native),
    },
  };
}

async function observeCompactionAttempt<T>(
  attempt: AgentOSProviderAttempt | (() => AgentOSProviderAttempt),
  run: () => Promise<T>,
  counts: (
    result: T,
  ) => Pick<
    AgentOSProviderAttemptOutcome,
    "inputTokens" | "outputTokens"
  >,
): Promise<T> {
  try {
    const result = await run();
    resolveAttempt(attempt).end({
      status: 200,
      streamOutcome: "completed",
      ...counts(result),
    });
    return result;
  } catch (error) {
    resolveAttempt(attempt).end({
      ...(error instanceof OpenAICompactionHttpError
        ? { status: error.status }
        : {}),
      error,
      streamOutcome: "upstream_error",
    });
    throw error;
  }
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
  const sessionId = (
    ctx.sessionManager as { getSessionId?: () => string }
  ).getSessionId?.() ?? "";
  return [
    sessionId,
    model?.provider,
    model?.api,
    model?.id,
  ].join("\u0000");
}

function requestShapeFromPayload(payload: unknown): ProviderRequestShape | undefined {
  const parsed = JsonObjectSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const reasoning = JsonObjectSchema.safeParse(parsed.data.reasoning);
  const text = JsonObjectSchema.safeParse(parsed.data.text);
  if (!reasoning.success && !text.success) return undefined;
  return {
    ...(reasoning.success ? { reasoning: reasoning.data } : {}),
    ...(text.success ? { text: text.data } : {}),
  };
}

export function createOpenAIServerCompactionExtension(
  dependencies: OpenAIServerCompactionDependencies = defaults,
) {
  return (pi: ExtensionAPI) => {
    const requestShapes = new Map<string, ProviderRequestShape>();
    pi.on("session_before_compact", (event, ctx) =>
      handleCompaction(pi, dependencies, requestShapes, event, ctx),
    );
    pi.on("before_provider_request", (event, ctx) => {
      const model = ctx.model;
      if (!isEnabled() || !supportsServerCompaction(model)) return undefined;
      const key = requestShapeKey(ctx);
      requestShapes.delete(key);
      const requestShape = requestShapeFromPayload(event.payload);
      if (requestShape) requestShapes.set(key, requestShape);
      return rewriteResponsesPayload(
        event.payload,
        ctx.sessionManager.getBranch(),
        model.provider,
        model.api,
        model.id,
      );
    });
    pi.on("session_start", () => requestShapes.clear());
    pi.on("session_before_switch", () => requestShapes.clear());
    pi.on("session_before_fork", () => requestShapes.clear());
    pi.on("session_before_tree", () => requestShapes.clear());
    pi.on("session_tree", () => requestShapes.clear());
    pi.on("session_compact", () => requestShapes.clear());
    pi.on("model_select", () => requestShapes.clear());
    pi.on("session_shutdown", () => requestShapes.clear());
  };
}

export { NATIVE_DETAILS_KEY };
export default createOpenAIServerCompactionExtension();
