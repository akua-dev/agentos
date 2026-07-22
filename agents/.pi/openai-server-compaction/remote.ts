import type { Model } from "@earendil-works/pi-ai";
import type { CompactionArtifact, ResponseItem } from "./messages.ts";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ServerCompactionResult = {
  artifact: CompactionArtifact;
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
  if (baseUrl.endsWith("/responses")) return baseUrl;
  return `${baseUrl}/responses`;
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

function requestHeaders(params: ServerCompactionRequest, endpoint: string): Headers {
  const headers = new Headers(params.headers);
  if (params.apiKey) headers.set("authorization", `Bearer ${params.apiKey}`);
  if (!caseInsensitiveHeader(headers, "authorization")) {
    throw new Error("OpenAI server compaction has no resolved authorization.");
  }
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");

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

async function boundedResponseText(response: Response): Promise<string> {
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
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("OpenAI server compaction response exceeded the size limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseSse(text: string): unknown[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .flatMap((block) => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data || data === "[DONE]") return [];
      try {
        return [JSON.parse(data) as unknown];
      } catch {
        return [];
      }
    });
}

function artifactFrom(value: unknown): CompactionArtifact | undefined {
  if (
    !isRecord(value) ||
    value.type !== "compaction" ||
    typeof value.encrypted_content !== "string" ||
    value.encrypted_content.length === 0
  ) {
    return undefined;
  }
  return { type: "compaction", encrypted_content: value.encrypted_content };
}

function parseCompactionEvents(events: unknown[]): ServerCompactionResult {
  let completed = false;
  let usage: Record<string, unknown> | undefined;
  const artifacts = new Map<string, CompactionArtifact>();

  for (const value of events) {
    if (!isRecord(value)) continue;
    if (value.type === "error" || value.type === "response.failed") {
      throw new Error("OpenAI server compaction failed.");
    }
    if (value.type === "response.output_item.done") {
      const artifact = artifactFrom(value.item);
      if (artifact) artifacts.set(artifact.encrypted_content, artifact);
      continue;
    }
    if (value.type !== "response.completed") continue;
    completed = true;
    const response = value.response;
    if (!isRecord(response)) continue;
    if (isRecord(response.usage)) usage = response.usage;
    if (Array.isArray(response.output)) {
      for (const output of response.output) {
        const artifact = artifactFrom(output);
        if (artifact) artifacts.set(artifact.encrypted_content, artifact);
      }
    }
  }

  if (!completed) {
    throw new Error("OpenAI server compaction stream ended before response.completed.");
  }
  if (artifacts.size !== 1) {
    throw new Error(`OpenAI server compaction expected one artifact, received ${artifacts.size}.`);
  }
  const artifact = artifacts.values().next().value;
  if (!artifact) throw new Error("OpenAI server compaction returned no artifact.");
  return { artifact, ...(usage ? { usage } : {}) };
}

export async function requestServerCompaction(
  params: ServerCompactionRequest,
): Promise<ServerCompactionResult> {
  const endpoint = endpointForModel(params.model);
  const response = await (params.fetchImpl ?? fetch)(endpoint, {
    method: "POST",
    headers: requestHeaders(params, endpoint),
    body: JSON.stringify({
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
    }),
    signal: params.signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OpenAI server compaction request failed with HTTP ${response.status}.`);
  }
  return parseCompactionEvents(parseSse(await boundedResponseText(response)));
}
