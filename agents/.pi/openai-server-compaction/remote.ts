import type { Api, Model, TSchema } from "@earendil-works/pi-ai";
import {
  isCompactionArtifact,
  type CompactionArtifact,
  type ResponseItem,
} from "./messages.ts";
import {
  DirectCompactResponseSchema,
  JsonObjectSchema,
  OutputItemDoneEventSchema,
  ProviderEventSchema,
  TerminalEventSchema,
  parseResponseItems,
  parseResponseUsage,
  type ProviderEvent,
  type ResponseUsage,
} from "./schemas.ts";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type OpenAICompactionModel = Model<Api> &
  (
    | { provider: "openai"; api: "openai-responses" }
    | { provider: "openai-codex"; api: "openai-codex-responses" }
  );

export type OpenAICompactionTool = {
  type: "function";
  name: string;
  description: string;
  parameters: TSchema;
  strict: false;
};

export type OpenAICompactionReasoning = {
  effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  summary: "auto";
};

export type ServerCompactionResult = {
  output: ResponseItem[];
  usage?: ResponseUsage;
};

export type ServerCompactionRequest = {
  model: OpenAICompactionModel;
  apiKey?: string;
  headers?: Record<string, string>;
  sessionId?: string;
  input: ResponseItem[];
  instructions?: string;
  tools: OpenAICompactionTool[];
  reasoning?: OpenAICompactionReasoning;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

export function supportsServerCompaction(
  model: Model<Api> | undefined,
): model is OpenAICompactionModel {
  return Boolean(
    model &&
      ((model.provider === "openai" && model.api === "openai-responses") ||
        (model.provider === "openai-codex" && model.api === "openai-codex-responses")),
  );
}

function normalizedBaseUrl(model: OpenAICompactionModel): string {
  const fallback =
    model.provider === "openai-codex"
      ? "https://chatgpt.com/backend-api"
      : "https://api.openai.com/v1";
  return (model.baseUrl?.trim() || fallback).replace(/\/+$/, "");
}

export function endpointForModel(model: Model<Api>): string {
  if (!supportsServerCompaction(model)) {
    throw new Error("OpenAI server compaction requires a native Responses model.");
  }
  const baseUrl = normalizedBaseUrl(model);
  if (model.provider === "openai-codex") {
    if (baseUrl.endsWith("/codex/responses")) return baseUrl;
    if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
    return `${baseUrl}/codex/responses`;
  }
  if (baseUrl.endsWith("/responses/compact")) return baseUrl;
  if (baseUrl.endsWith("/responses")) return `${baseUrl}/compact`;
  return `${baseUrl}/responses/compact`;
}

function caseInsensitiveHeader(headers: Headers, name: string): string | null {
  return headers.get(name);
}

function accountIdFromToken(token: string): string | undefined {
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try {
    const payload = JsonObjectSchema.safeParse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    if (!payload.success) return undefined;
    const auth = JsonObjectSchema.safeParse(payload.data["https://api.openai.com/auth"]);
    if (!auth.success) return undefined;
    return typeof auth.data.chatgpt_account_id === "string"
      ? auth.data.chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
}

function isCodexModel(
  model: OpenAICompactionModel,
): model is OpenAICompactionModel & { provider: "openai-codex" } {
  return model.provider === "openai-codex";
}

function normalizedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

type Deadline = { signal: AbortSignal; cleanup: () => void };

function deadlineSignal(callerSignal: AbortSignal | undefined, timeoutMs: number | undefined): Deadline {
  const controller = new AbortController();
  const duration = normalizedTimeout(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);

  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  if (!controller.signal.aborted) {
    timer = setTimeout(() => {
      controller.abort(new Error(`OpenAI server compaction timed out after ${duration}ms.`));
    }, duration);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("OpenAI server compaction request was aborted.");
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

async function parseCompactResponse(text: string): Promise<ServerCompactionResult> {
  let parsed: ReturnType<typeof DirectCompactResponseSchema.safeParse>;
  try {
    parsed = DirectCompactResponseSchema.safeParse(JSON.parse(text));
  } catch {
    throw new Error("OpenAI server compaction returned invalid JSON.");
  }
  if (!parsed.success) {
    throw new Error("OpenAI server compaction returned an invalid compacted response.");
  }
  const output = parsed.data.output;
  const artifacts = output.filter(artifactFrom);
  if (artifacts.length !== 1) {
    throw new Error(`OpenAI server compaction expected one artifact, received ${artifacts.length}.`);
  }
  const usage = requiredResponseUsage(parsed.data.usage);
  return { output, ...(usage ? { usage } : {}) };
}

function requestHeaders(params: ServerCompactionRequest, endpoint: string): Headers {
  const headers = new Headers(params.headers);
  if (params.apiKey) headers.set("authorization", `Bearer ${params.apiKey}`);
  if (!caseInsensitiveHeader(headers, "authorization")) {
    throw new Error("OpenAI server compaction has no resolved authorization.");
  }
  headers.set("content-type", "application/json");

  if (!isCodexModel(params.model)) {
    headers.delete("x-codex-beta-features");
    headers.delete("openai-beta");
    headers.delete("originator");
    headers.delete("session-id");
    headers.set("accept", "application/json");
    return headers;
  }

  headers.set("accept", "text/event-stream");

  const configured = (headers.get("x-codex-beta-features") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  headers.set(
    "x-codex-beta-features",
    [...new Set([...configured, REMOTE_COMPACTION_FEATURE])].join(","),
  );

  if (params.model.provider === "openai-codex") {
    headers.set("originator", "pi");
    headers.set("OpenAI-Beta", "responses=experimental");
    if (params.sessionId) {
      headers.set("session-id", params.sessionId);
      headers.set("x-client-request-id", params.sessionId);
    }
    const hostname = new URL(endpoint).hostname;
    if (hostname === "chatgpt.com" && !headers.has("chatgpt-account-id")) {
      const accountId = params.apiKey ? accountIdFromToken(params.apiKey) : undefined;
      if (!accountId) throw new Error("OpenAI Codex authorization has no account identity.");
      headers.set("chatgpt-account-id", accountId);
    }
  }
  return headers;
}

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("OpenAI server compaction response exceeded the size limit.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    try {
      const { done, value } = await awaitWithAbort(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error("OpenAI server compaction response exceeded the size limit.");
      }
      text += decoder.decode(value, { stream: true });
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
  }
  await reader.cancel().catch(() => undefined);
  return text + decoder.decode();
}

function parseSse(text: string): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = ProviderEventSchema.safeParse(JSON.parse(data));
      if (!parsed.success) throw new Error("invalid provider event");
      events.push(parsed.data);
    } catch {
      throw new Error("OpenAI server compaction returned invalid SSE data.");
    }
  }
  return events;
}

function artifactFrom(value: unknown): CompactionArtifact | undefined {
  return isCompactionArtifact(value) ? value : undefined;
}

function requiredResponseUsage(value: unknown): ResponseUsage | undefined {
  if (value === undefined) return undefined;
  const usage = parseResponseUsage(value);
  if (!usage) {
    throw new Error("OpenAI server compaction returned invalid usage.");
  }
  return usage;
}

function recordArtifact(artifacts: Map<string, CompactionArtifact>, artifact: CompactionArtifact): void {
  const existing = artifacts.get(artifact.encrypted_content);
  if (existing && JSON.stringify(existing) !== JSON.stringify(artifact)) {
    throw new Error("OpenAI server compaction returned ambiguous compaction artifacts.");
  }
  artifacts.set(artifact.encrypted_content, existing ?? artifact);
}

function parseCompactionEvents(events: ProviderEvent[]): ServerCompactionResult {
  let terminalType: "response.completed" | "response.done" | undefined;
  let terminalOutput: ResponseItem[] | undefined;
  let usage: ResponseUsage | undefined;
  const artifacts = new Map<string, CompactionArtifact>();

  for (const value of events) {
    if (value.type === "response.incomplete") {
      throw new Error("OpenAI server compaction response was incomplete.");
    }
    if (
      value.type === "error" ||
      value.type === "response.error" ||
      value.type === "response.failed" ||
      value.type === "response.cancelled"
    ) {
      throw new Error("OpenAI server compaction failed.");
    }
    if (value.type === "response.output_item.done") {
      const event = OutputItemDoneEventSchema.safeParse(value);
      if (!event.success) {
        throw new Error("OpenAI server compaction returned an invalid output item.");
      }
      const artifact = artifactFrom(event.data.item);
      if (artifact) recordArtifact(artifacts, artifact);
      continue;
    }
    if (value.type !== "response.completed" && value.type !== "response.done") {
      continue;
    }
    if (terminalType) {
      throw new Error("OpenAI server compaction returned multiple terminal events.");
    }
    const event = TerminalEventSchema.safeParse(value);
    if (!event.success) throw new Error("OpenAI server compaction returned no terminal response.");
    terminalType = event.data.type;
    const response = event.data.response;
    if (response.status !== "completed") {
      throw new Error("OpenAI server compaction terminal response was not completed.");
    }
    usage = requiredResponseUsage(response.usage);
    const parsedOutput = parseResponseItems(response.output);
    if (!parsedOutput || parsedOutput.length === 0) {
      throw new Error("OpenAI server compaction returned an invalid terminal response.");
    }
    terminalOutput = parsedOutput;
    for (const output of terminalOutput) {
      const artifact = artifactFrom(output);
      if (artifact) recordArtifact(artifacts, artifact);
    }
  }

  if (!terminalType) {
    throw new Error("OpenAI server compaction stream ended before response.completed.");
  }
  if (artifacts.size !== 1) {
    throw new Error(`OpenAI server compaction expected one artifact, received ${artifacts.size}.`);
  }
  if (!terminalOutput) {
    throw new Error("OpenAI server compaction returned no terminal output.");
  }
  const terminalArtifacts = terminalOutput.filter(artifactFrom);
  if (terminalArtifacts.length !== 1) {
    throw new Error(
      `OpenAI server compaction terminal output expected one artifact, received ${terminalArtifacts.length}.`,
    );
  }
  return { output: terminalOutput, ...(usage ? { usage } : {}) };
}

export async function requestServerCompaction(
  params: ServerCompactionRequest,
): Promise<ServerCompactionResult> {
  const endpoint = endpointForModel(params.model);
  const deadline = deadlineSignal(params.signal, params.timeoutMs);
  try {
    if (deadline.signal.aborted) throw abortReason(deadline.signal);
    const codex = isCodexModel(params.model);
    const body = codex
      ? {
          model: params.model.id,
          input: [...params.input, { type: "compaction_trigger" }],
          instructions: params.instructions,
          tools: params.tools,
          parallel_tool_calls: true,
          tool_choice: "auto",
          stream: true,
          store: false,
          include: ["reasoning.encrypted_content"],
          ...(params.sessionId ? { prompt_cache_key: params.sessionId } : {}),
          ...(params.reasoning ? { reasoning: params.reasoning } : {}),
        }
      : {
          model: params.model.id,
          input: params.input,
          instructions: params.instructions,
          ...(params.sessionId ? { prompt_cache_key: params.sessionId } : {}),
        };
    const response = await awaitWithAbort(
      (params.fetchImpl ?? fetch)(endpoint, {
        method: "POST",
        headers: requestHeaders(params, endpoint),
        body: JSON.stringify(body),
        signal: deadline.signal,
      }),
      deadline.signal,
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`OpenAI server compaction request failed with HTTP ${response.status}.`);
    }
    const responseText = await boundedResponseText(response, deadline.signal);
    return codex ? parseCompactionEvents(parseSse(responseText)) : parseCompactResponse(responseText);
  } finally {
    deadline.cleanup();
  }
}
