import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, Model, TSchema } from "@earendil-works/pi-ai";
import {
  isCompactionArtifact,
  type CompactionArtifact,
  type ResponseContentItem,
  type ResponseItem,
} from "./messages.ts";
import {
  parseJsonObject,
  parseDirectCompactResponse,
  parseOutputItemDoneEvent,
  parseProviderEvent,
  parseTerminalEvent,
  parseResponseItems,
  parseResponseUsage,
  type JsonObject,
  type ProviderEvent,
  type ResponseUsage,
} from "./schemas.ts";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
const RETAINED_MESSAGE_TOKEN_BUDGET = 20_000;
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
  reasoning?: JsonObject;
  text?: JsonObject;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  codexInstallationId?: () => string | Promise<string>;
  route?: "direct" | "ai_gateway";
};

export class OpenAICompactionHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`OpenAI server compaction request failed with HTTP ${status}.`);
    this.name = "OpenAICompactionHttpError";
    this.status = status;
  }
}

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
    const payload = parseJsonObject(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    if (!payload) return undefined;
    const auth = parseJsonObject(payload["https://api.openai.com/auth"]);
    if (!auth) return undefined;
    return typeof auth.chatgpt_account_id === "string"
      ? auth.chatgpt_account_id
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalUuid(value: string): string | undefined {
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function defaultCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".codex");
}

export async function resolveCodexInstallationId(
  codexHome = defaultCodexHome(),
): Promise<string> {
  const installationPath = join(codexHome, "installation_id");
  try {
    await mkdir(codexHome, { recursive: true });
    try {
      const existing = canonicalUuid(await readFile(installationPath, "utf8"));
      return existing ?? randomUUID();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const installationId = randomUUID();
    const temporaryPath = join(codexHome, `.installation_id-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, installationId, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
      try {
        await link(temporaryPath, installationPath);
        return installationId;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return (
          canonicalUuid(await readFile(installationPath, "utf8")) ??
          randomUUID()
        );
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  } catch {
    // Installation identity is affinity metadata; failure must not block AI.
    return randomUUID();
  }
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

async function requestHeaders(
  params: ServerCompactionRequest,
  endpoint: string,
): Promise<Headers> {
  const headers = new Headers(params.headers);
  if (params.apiKey) headers.set("authorization", `Bearer ${params.apiKey}`);
  if (!caseInsensitiveHeader(headers, "authorization")) {
    throw new Error("OpenAI server compaction has no resolved authorization.");
  }
  headers.set("content-type", "application/json");

  if (isCodexModel(params.model)) {
    headers.set("accept", "text/event-stream");
    const configured = (headers.get("x-codex-beta-features") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    headers.set(
      "x-codex-beta-features",
      [...new Set([...configured, REMOTE_COMPACTION_FEATURE])].join(","),
    );
  } else {
    headers.set("accept", "application/json");
    headers.delete("x-codex-beta-features");
  }
  if (params.route !== "ai_gateway") {
    for (const [name] of headers) {
      if (name.toLowerCase().startsWith("x-agentos-")) {
        headers.delete(name);
      }
    }
  }

  if (!isCodexModel(params.model)) {
    headers.delete("openai-beta");
    headers.delete("originator");
    headers.delete("session-id");
    headers.delete("thread-id");
    headers.delete("x-client-request-id");
    headers.delete("x-codex-installation-id");
    headers.delete("x-codex-window-id");
    return headers;
  }

  if (params.model.provider === "openai-codex") {
    headers.set("originator", "pi");
    headers.set("OpenAI-Beta", "responses=experimental");
    const installationId = canonicalUuid(
      await (
        params.codexInstallationId ??
        resolveCodexInstallationId
      )(),
    );
    if (installationId) {
      headers.set("x-codex-installation-id", installationId);
    } else {
      headers.delete("x-codex-installation-id");
    }
    headers.set("x-client-request-id", randomUUID());
    if (params.sessionId) {
      headers.set("session-id", params.sessionId);
      headers.set("thread-id", params.sessionId);
      headers.set("x-codex-window-id", `${params.sessionId}:0`);
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
      const parsed = parseProviderEvent(JSON.parse(data));
      if (!parsed) throw new Error("invalid provider event");
      events.push(parsed);
    } catch {
      throw new Error("OpenAI server compaction returned invalid SSE data.");
    }
  }
  return events;
}

function artifactFrom(value: unknown): CompactionArtifact | undefined {
  return isCompactionArtifact(value) ? value : undefined;
}

function cloneResponseItem<T extends ResponseItem>(item: T): T {
  return structuredClone(item);
}

function isRealUserMessage(item: ResponseItem): boolean {
  return (
    item.type === "message" &&
    item.role === "user" &&
    Array.isArray(item.content) &&
    item.content.length > 0
  );
}

function responseMessageText(item: ResponseItem): string {
  if (item.type !== "message" || !Array.isArray(item.content)) return "";
  return (item.content as ResponseContentItem[])
    .flatMap((part) =>
      "text" in part && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");
}

function approximateMessageTokens(item: ResponseItem): number {
  return Math.max(1, Math.ceil(responseMessageText(item).length / 4));
}

function truncateMessageToTokenBudget(
  item: ResponseItem,
  maxTokens: number,
): ResponseItem | undefined {
  if (item.type !== "message" || !Array.isArray(item.content)) {
    return undefined;
  }
  let remainingCharacters = Math.max(0, maxTokens * 4);
  const content = (item.content as ResponseContentItem[]).flatMap((part) => {
    if (!("text" in part) || typeof part.text !== "string") {
      return [structuredClone(part)];
    }
    if (remainingCharacters === 0) return [];
    const text = part.text.slice(0, remainingCharacters);
    remainingCharacters -= text.length;
    return text ? [{ ...structuredClone(part), text }] : [];
  });
  return content.length > 0
    ? ({ ...cloneResponseItem(item), content } as ResponseItem)
    : undefined;
}

export function buildRemoteCompactionHistory(
  input: ResponseItem[],
  artifact: CompactionArtifact,
): ResponseItem[] {
  const retainedUserMessages = input.filter(isRealUserMessage);
  let remainingTokens = RETAINED_MESSAGE_TOKEN_BUDGET;
  const retainedReversed: ResponseItem[] = [];
  for (const item of [...retainedUserMessages].reverse()) {
    if (remainingTokens === 0) break;
    const tokenCount = approximateMessageTokens(item);
    if (tokenCount <= remainingTokens) {
      retainedReversed.push(cloneResponseItem(item));
      remainingTokens -= tokenCount;
      continue;
    }
    const truncated = truncateMessageToTokenBudget(item, remainingTokens);
    if (truncated) retainedReversed.push(truncated);
    remainingTokens = 0;
  }
  return [
    ...retainedReversed.reverse(),
    cloneResponseItem(artifact),
  ];
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
  const streamedOutput: ResponseItem[] = [];
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
      const event = parseOutputItemDoneEvent(value);
      if (!event) {
        throw new Error("OpenAI server compaction returned an invalid output item.");
      }
      streamedOutput.push(event.item);
      const artifact = artifactFrom(event.item);
      if (artifact) recordArtifact(artifacts, artifact);
      continue;
    }
    if (value.type !== "response.completed" && value.type !== "response.done") {
      continue;
    }
    if (terminalType) {
      throw new Error("OpenAI server compaction returned multiple terminal events.");
    }
    const event = parseTerminalEvent(value);
    if (!event) throw new Error("OpenAI server compaction returned no terminal response.");
    terminalType = event.type;
    const response = event.response;
    if (response.status !== "completed") {
      throw new Error("OpenAI server compaction terminal response was not completed.");
    }
    usage = requiredResponseUsage(response.usage);
    if (response.output !== undefined && response.output !== null) {
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
  }

  if (!terminalType) {
    throw new Error("OpenAI server compaction stream ended before response.completed.");
  }
  if (artifacts.size !== 1) {
    throw new Error(`OpenAI server compaction expected one artifact, received ${artifacts.size}.`);
  }
  const output = terminalOutput ?? streamedOutput;
  if (output.length === 0) {
    throw new Error("OpenAI server compaction returned no canonical output.");
  }
  const outputArtifacts = output.filter(artifactFrom);
  if (outputArtifacts.length !== 1) {
    throw new Error(
      `OpenAI server compaction canonical output expected one artifact, received ${outputArtifacts.length}.`,
    );
  }
  return { output, ...(usage ? { usage } : {}) };
}

function parseDirectCompactionResponse(text: string): ServerCompactionResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("OpenAI server compaction returned invalid compact response JSON.");
  }
  const parsed = parseDirectCompactResponse(value);
  if (!parsed) {
    throw new Error("OpenAI server compaction returned an invalid compact response.");
  }
  const artifacts = parsed.output.filter(artifactFrom);
  if (artifacts.length !== 1) {
    throw new Error(
      `OpenAI server compaction compact response expected one artifact, received ${artifacts.length}.`,
    );
  }
  return {
    output: parsed.output,
    usage: parsed.usage,
  };
}

export async function requestServerCompaction(
  params: ServerCompactionRequest,
): Promise<ServerCompactionResult> {
  const endpoint = endpointForModel(params.model);
  const deadline = deadlineSignal(params.signal, params.timeoutMs);
  try {
    if (deadline.signal.aborted) throw abortReason(deadline.signal);
    const sharedBody = {
      model: params.model.id,
      input: params.input,
      instructions: params.instructions,
      tools: params.tools,
      parallel_tool_calls: true,
      ...(params.sessionId ? { prompt_cache_key: params.sessionId } : {}),
      ...(params.reasoning ? { reasoning: params.reasoning } : {}),
      ...(params.text ? { text: params.text } : {}),
    };
    const body = isCodexModel(params.model)
      ? {
          ...sharedBody,
          input: [...params.input, { type: "compaction_trigger" }],
          tool_choice: "auto",
          stream: true,
          store: false,
          include: ["reasoning.encrypted_content"],
        }
      : sharedBody;
    const response = await awaitWithAbort(
      (params.fetchImpl ?? fetch)(endpoint, {
        method: "POST",
        headers: await requestHeaders(params, endpoint),
        body: JSON.stringify(body),
        signal: deadline.signal,
      }),
      deadline.signal,
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new OpenAICompactionHttpError(response.status);
    }
    const responseText = await boundedResponseText(response, deadline.signal);
    if (!isCodexModel(params.model)) {
      return parseDirectCompactionResponse(responseText);
    }
    const result = parseCompactionEvents(parseSse(responseText));
    const artifact = result.output
      .map(artifactFrom)
      .find((value): value is CompactionArtifact => value !== undefined);
    if (!artifact) {
      throw new Error("OpenAI server compaction returned no canonical artifact.");
    }
    return {
      output: buildRemoteCompactionHistory(params.input, artifact),
      ...(result.usage ? { usage: result.usage } : {}),
    };
  } finally {
    deadline.cleanup();
  }
}
