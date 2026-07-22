import {
  compact,
  type CompactionResult,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import {
  requestServerCompaction,
  supportsServerCompaction,
  type ServerCompactionRequest,
  type ServerCompactionResult,
} from "./remote.ts";
import {
  buildCompactionInput,
  nativeCompactionDetails,
  NATIVE_DETAILS_KEY,
  rewriteResponsesPayload,
} from "./session.ts";

type ResolvedAuth = {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
};

type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

type LocalCompactionRequest = {
  event: SessionBeforeCompactEvent;
  model: Model<any>;
  auth: ResolvedAuth;
  thinkingLevel: PiThinkingLevel;
};

export type OpenAIServerCompactionDependencies = {
  runLocalCompaction(request: LocalCompactionRequest): Promise<CompactionResult>;
  runServerCompaction(request: ServerCompactionRequest): Promise<ServerCompactionResult>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function toolsPayload(allTools: ToolInfo[], activeTools: string[]): Record<string, unknown>[] {
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

function reasoningFor(level: PiThinkingLevel, model: Model<any>): Record<string, unknown> | undefined {
  if (!model.reasoning) return undefined;
  const effort = level === "max" ? "xhigh" : level === "off" ? "none" : level;
  return { effort, summary: "auto" };
}

async function defaultLocalCompaction(request: LocalCompactionRequest): Promise<CompactionResult> {
  return compact(
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

const defaults: OpenAIServerCompactionDependencies = {
  runLocalCompaction: defaultLocalCompaction,
  runServerCompaction: requestServerCompaction,
};

function mergedDetails(localDetails: unknown, nativeDetails: Record<string, unknown>) {
  if (isRecord(localDetails)) return { ...localDetails, ...nativeDetails };
  return {
    ...(localDetails === undefined ? {} : { piCompactionDetails: localDetails }),
    ...nativeDetails,
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizedServerUsage(model: Model<any>, raw: Record<string, unknown> | undefined): Usage | undefined {
  if (!raw) return undefined;
  const inputDetails = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : undefined;
  const outputDetails = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : undefined;
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
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
) {
  const model = ctx.model;
  if (!isEnabled() || !supportsServerCompaction(model)) return undefined;

  const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!resolved.ok) return undefined;
  const hasAuthorization = Object.keys(resolved.headers ?? {}).some(
    (name) => name.toLowerCase() === "authorization",
  );
  if (!resolved.apiKey && !hasAuthorization) return undefined;

  const thinkingLevel = pi.getThinkingLevel();
  const localRequest = { event, model, auth: resolved, thinkingLevel };
  const remoteRequest: ServerCompactionRequest = {
    model,
    apiKey: resolved.apiKey,
    headers: mergedHeaders(model.headers, resolved.headers),
    sessionId: ctx.sessionManager.getSessionId(),
    input: buildCompactionInput(event.branchEntries, model.provider, model.id),
    instructions: ctx.getSystemPrompt(),
    tools: toolsPayload(pi.getAllTools(), pi.getActiveTools()),
    reasoning: reasoningFor(thinkingLevel, model),
    signal: event.signal,
    timeoutMs: configuredRemoteTimeout(),
  };

  const [local, remote] = await Promise.allSettled([
    dependencies.runLocalCompaction(localRequest),
    dependencies.runServerCompaction(remoteRequest),
  ]);

  if (local.status !== "fulfilled") return undefined;
  if (remote.status !== "fulfilled") {
    if (!event.signal.aborted && ctx.hasUI) {
      ctx.ui.notify("OpenAI server compaction unavailable; using Pi's portable summary.", "warning");
    }
    return { compaction: local.value };
  }

  const native = nativeCompactionDetails(
    model.provider,
    model.id,
    remote.value.artifact,
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

export function createOpenAIServerCompactionExtension(
  dependencies: OpenAIServerCompactionDependencies = defaults,
) {
  return (pi: ExtensionAPI) => {
    pi.on("session_before_compact", (event, ctx) =>
      handleCompaction(pi, dependencies, event, ctx),
    );
    pi.on("before_provider_request", (event, ctx) => {
      const model = ctx.model;
      if (!isEnabled() || !supportsServerCompaction(model)) return undefined;
      return rewriteResponsesPayload(
        event.payload,
        ctx.sessionManager.getBranch(),
        model.provider,
        model.id,
      );
    });
  };
}

export { NATIVE_DETAILS_KEY };
export default createOpenAIServerCompactionExtension();
