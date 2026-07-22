import type { Model } from "@earendil-works/pi-ai";
import {
  isCompactionArtifact,
  isResponseItem,
  type CompactionArtifact,
  type ResponseItem,
} from "./messages.ts";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ServerCompactionResult = {
  output: ResponseItem[];
  usage?: Record<string, unknown>;
};

export type ServerCompactionRequest = {
  model: Model<any>;
  apiKey?: string;
  headers?: Record<string, string>;
  sessionId?: string;
  input: ResponseItem[];
  instructions?: string;
  tools: Record<string, unknown>[];
  reasoning?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsServerCompaction(model: Model<any> | undefined): model is Model<any> {
  return Boolean(
    model &&
      ((model.provider === "openai" && model.api === "openai-responses") ||
        (model.provider === "openai-codex" && model.api === "openai-codex-responses")),
  );
}

function normalizedBaseUrl(model: Model<any>): string {
  const fallback =
    model.provider === "openai-codex"
      ? "https://chatgpt.com/backend-api"
      : "https://api.openai.com/v1";
  return (model.baseUrl?.trim() || fallback).replace(/\/+$/, "");
}

export function endpointForModel(model: Model<any>): string {
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
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!isRecord(payload)) return undefined;
    const auth = payload["https://api.openai.com/auth"];
    if (!isRecord(auth)) return undefined;
    return typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

function isCodexModel(model: Model<any>): boolean {
  return model.provider === "openai-codex";
}

function normalizedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(value!), MAX_TIMEOUT_MS);
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
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("OpenAI server compaction returned invalid JSON.");
  }
  if (!isRecord(value) || !Array.isArray(value.output) || value.output.length === 0) {
    throw new Error("OpenAI server compaction returned an invalid compacted response.");
  }
  const output = value.output;
  if (!output.every(isResponseItem)) {
    throw new Error("OpenAI server compaction returned an invalid compacted response.");
  }
  const artifacts = output.filter(artifactFrom);
  if (artifacts.length !== 1) {
    throw new Error(`OpenAI server compaction expected one artifact, received ${artifacts.length}.`);
  }
  const usage = isRecord(value.usage) ? value.usage : undefined;
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

function parseSse(text: string): unknown[] {
  const events: unknown[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as unknown);
    } catch {
      throw new Error("OpenAI server compaction returned invalid SSE data.");
    }
  }
  return events;
}

function artifactFrom(value: unknown): CompactionArtifact | undefined {
  return isCompactionArtifact(value) ? value : undefined;
}

function recordArtifact(artifacts: Map<string, CompactionArtifact>, artifact: CompactionArtifact): void {
  const existing = artifacts.get(artifact.encrypted_content);
  if (existing && JSON.stringify(existing) !== JSON.stringify(artifact)) {
    throw new Error("OpenAI server compaction returned ambiguous compaction artifacts.");
  }
  artifacts.set(artifact.encrypted_content, existing ?? artifact);
}

function parseCompactionEvents(events: unknown[]): ServerCompactionResult {
  let terminalType: "response.completed" | "response.done" | undefined;
  let terminalOutput: ResponseItem[] | undefined;
  let usage: Record<string, unknown> | undefined;
  const artifacts = new Map<string, CompactionArtifact>();

  for (const value of events) {
    if (!isRecord(value)) continue;
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
      if (!isResponseItem(value.item)) {
        throw new Error("OpenAI server compaction returned an invalid output item.");
      }
      const artifact = artifactFrom(value.item);
      if (artifact) recordArtifact(artifacts, artifact);
      continue;
    }
    if (value.type !== "response.completed" && value.type !== "response.done") {
      continue;
    }
    if (terminalType) {
      throw new Error("OpenAI server compaction returned multiple terminal events.");
    }
    terminalType = value.type;
    const response = value.response;
    if (!isRecord(response)) throw new Error("OpenAI server compaction returned no terminal response.");
    if (response.status !== "completed") {
      throw new Error("OpenAI server compaction terminal response was not completed.");
    }
    if (isRecord(response.usage)) usage = response.usage;
    if (!Array.isArray(response.output) || response.output.length === 0) {
      throw new Error("OpenAI server compaction returned an invalid terminal response.");
    }
    if (!response.output.every(isResponseItem)) {
      throw new Error("OpenAI server compaction returned an invalid terminal response.");
    }
    terminalOutput = response.output;
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
