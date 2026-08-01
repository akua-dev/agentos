import type { Api, Model, TSchema } from "@earendil-works/pi-ai";
import {
  Config,
  Crypto,
  Effect,
  Equal,
  FileSystem,
  Option,
  Path,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";

import {
  isCompactionArtifact,
  type CompactionArtifact,
  type ResponseItem,
} from "./messages.ts";
import {
  JsonObjectSchema,
  parseDirectCompactResponse,
  parseJsonObject,
  parseOutputItemDoneEvent,
  parseProviderEvent,
  parseResponseItems,
  parseResponseUsage,
  parseTerminalEvent,
  ResponseContentItemSchema,
  type JsonObject,
  type ProviderEvent,
  type ResponseUsage,
} from "./schemas.ts";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const REMOTE_COMPACTION_FEATURE = "remote_compaction_v2";
const RETAINED_MESSAGE_TOKEN_BUDGET = 20_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const INSTALLATION_FILE_MODE = 0o644;

const OpenAICompactionErrorCode = Schema.Literals([
  "aborted",
  "identity_unavailable",
  "invalid_endpoint",
  "invalid_request",
  "invalid_response",
  "missing_account_identity",
  "missing_artifact",
  "missing_authorization",
  "network_failure",
  "response_failed",
  "response_too_large",
  "timeout",
]);

export class OpenAICompactionError extends Schema.TaggedErrorClass<OpenAICompactionError>()(
  "OpenAICompactionError",
  {
    code: OpenAICompactionErrorCode,
    message: Schema.String,
  },
) {}

export class OpenAICompactionHttpError extends Schema.TaggedErrorClass<OpenAICompactionHttpError>()(
  "OpenAICompactionHttpError",
  {
    message: Schema.String,
    status: Schema.Int,
  },
) {
  constructor(status: number) {
    super({
      message: `OpenAI server compaction request failed with HTTP ${status}.`,
      status,
    });
  }
}

export type OpenAICompactionFailure =
  | OpenAICompactionError
  | OpenAICompactionHttpError;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Effect.Effect<OpenAICompactionHttpResponse, unknown, Scope.Scope>;

export type OpenAICompactionHttpResponse = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Stream.Stream<Uint8Array, unknown> | null;
  readonly close: Effect.Effect<void>;
};

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
  codexInstallationId?: () => Effect.Effect<string, unknown>;
  route?: "direct" | "ai_gateway";
};

type CompactionPlatform =
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path;

type BoundedBody = {
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly length: number;
};

const UnknownJsonString = Schema.fromJsonString(Schema.Unknown);
const UserMessageSchema = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.Literal("user"),
  content: Schema.mutable(Schema.Array(ResponseContentItemSchema)),
});

function compactionError(
  code: OpenAICompactionError["code"],
  message: string,
): OpenAICompactionError {
  return OpenAICompactionError.make({ code, message });
}

export function supportsServerCompaction(
  model: Model<Api> | undefined,
): model is OpenAICompactionModel {
  return Boolean(
    model &&
      ((model.provider === "openai" && model.api === "openai-responses") ||
        (model.provider === "openai-codex" &&
          model.api === "openai-codex-responses")),
  );
}

function normalizedBaseUrl(model: OpenAICompactionModel): string {
  const fallback = model.provider === "openai-codex"
    ? "https://chatgpt.com/backend-api"
    : "https://api.openai.com/v1";
  return (model.baseUrl?.trim() || fallback).replace(/\/+$/, "");
}

export function endpointForModel(model: OpenAICompactionModel): string {
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

function accountIdFromToken(token: string) {
  const encoded = token.split(".")[1];
  if (encoded === undefined) return Effect.succeed(undefined);
  return Effect.try({
    try: () => Buffer.from(encoded, "base64url").toString("utf8"),
    catch: () =>
      compactionError(
        "missing_account_identity",
        "OpenAI Codex authorization identity could not be decoded.",
      ),
  }).pipe(
    Effect.flatMap((source) =>
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(JsonObjectSchema),
      )(source)
    ),
    Effect.option,
    Effect.map((decoded) => {
      if (!Option.isSome(decoded)) return undefined;
      const auth = parseJsonObject(
        decoded.value["https://api.openai.com/auth"],
      );
      if (auth === undefined) return undefined;
      const accountId = auth.chatgpt_account_id;
      return typeof accountId === "string" ? accountId : undefined;
    }),
  );
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

function configuredCodexHome() {
  return Effect.gen(function*() {
    const paths = yield* Path.Path;
    const configured = yield* Config.option(Config.string("CODEX_HOME"));
    if (Option.isSome(configured) && configured.value.trim()) {
      return paths.resolve(configured.value.trim());
    }
    const home = yield* Config.option(Config.string("HOME"));
    return Option.isSome(home) && home.value.trim()
      ? paths.join(paths.resolve(home.value.trim()), ".codex")
      : paths.resolve(".codex");
  });
}

export function resolveCodexInstallationId(
  codexHome?: string,
): Effect.Effect<string, OpenAICompactionError, CompactionPlatform> {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const fallback = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() =>
        compactionError(
          "identity_unavailable",
          "OpenAI Codex installation identity could not be generated.",
        )
      ),
    );
    const directory = codexHome === undefined
      ? yield* configuredCodexHome().pipe(
        Effect.mapError(() =>
          compactionError(
            "identity_unavailable",
            "OpenAI Codex home could not be resolved.",
          )
        ),
      )
      : paths.resolve(codexHome);
    const installationPath = paths.join(directory, "installation_id");
    const readCanonical = fileSystem.readFileString(installationPath).pipe(
      Effect.map(canonicalUuid),
    );
    const persisted = Effect.gen(function*() {
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const exists = yield* fileSystem.exists(installationPath);
      if (exists) {
        return (yield* readCanonical) ?? fallback;
      }

      const installationId = yield* crypto.randomUUIDv4;
      const temporaryId = yield* crypto.randomUUIDv4;
      const temporaryPath = paths.join(
        directory,
        `.installation_id-${temporaryId}.tmp`,
      );
      return yield* Effect.gen(function*() {
        yield* fileSystem.writeFileString(temporaryPath, installationId, {
          flag: "wx",
          mode: INSTALLATION_FILE_MODE,
        });
        const linked = yield* fileSystem.link(
          temporaryPath,
          installationPath,
        ).pipe(Effect.option);
        if (Option.isSome(linked)) return installationId;
        const existing = yield* readCanonical.pipe(Effect.option);
        return Option.isSome(existing) && existing.value !== undefined
          ? existing.value
          : fallback;
      }).pipe(
        Effect.ensuring(
          fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore),
        ),
      );
    });

    return yield* persisted.pipe(Effect.catch(() => Effect.succeed(fallback)));
  });
}

function normalizedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function callerAbort(signal: AbortSignal | undefined) {
  if (signal === undefined) return Effect.never;
  const failure = compactionError(
    "aborted",
    "OpenAI server compaction request was aborted.",
  );
  return Effect.callback<never, OpenAICompactionError>((resume) => {
    const onAbort = () => resume(Effect.fail(failure));
    if (signal.aborted) {
      onAbort();
      return Effect.void;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

function defaultFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Effect.Effect<
  OpenAICompactionHttpResponse,
  OpenAICompactionError,
  HttpClient.HttpClient | Scope.Scope
> {
  return Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient;
    const request = yield* Effect.try({
      try: () => {
        const url = input instanceof Request ? input.url : input;
        const body = init?.body;
        const headers = new Headers(init?.headers);
        const base = HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders(headers),
        );
        return typeof body === "string"
          ? base.pipe(HttpClientRequest.bodyText(body, headers.get("content-type") ?? undefined))
          : base;
      },
      catch: () =>
        compactionError(
          "invalid_request",
          "OpenAI server compaction request is invalid.",
        ),
    });
    const response = yield* HttpClient.withScope(client).execute(request).pipe(
      Effect.mapError(() =>
        compactionError(
          "network_failure",
          "OpenAI server compaction request failed before receiving a response.",
        )
      ),
    );
    return {
      status: response.status,
      headers: new Headers(response.headers),
      body: response.stream,
      close: Effect.void,
    } satisfies OpenAICompactionHttpResponse;
  });
}

export function compactionResponseFromWeb(
  response: Response,
): OpenAICompactionHttpResponse {
  const body = response.body;
  const close = body === null
    ? Effect.void
    : Effect.tryPromise({
      try: () => body.cancel(),
      catch: () => undefined,
    }).pipe(Effect.ignore);
  return {
    status: response.status,
    headers: response.headers,
    body: body === null
      ? null
      : Stream.fromReadableStream({
        evaluate: () => body,
        onError: (error) => error,
      }),
    close,
  };
}

function endpointHostname(endpoint: string) {
  return Effect.try({
    try: () => new URL(endpoint).hostname,
    catch: () =>
      compactionError(
        "invalid_endpoint",
        "OpenAI server compaction endpoint is invalid.",
      ),
  });
}

function requestHeaders(
  params: ServerCompactionRequest,
  endpoint: string,
): Effect.Effect<Headers, OpenAICompactionError, CompactionPlatform> {
  return Effect.gen(function*() {
    const headers = yield* Effect.try({
      try: () => new Headers(params.headers),
      catch: () =>
        compactionError(
          "invalid_request",
          "OpenAI server compaction headers are invalid.",
        ),
    });
    if (params.apiKey) headers.set("authorization", `Bearer ${params.apiKey}`);
    if (!headers.has("authorization")) {
      return yield* compactionError(
        "missing_authorization",
        "OpenAI server compaction has no resolved authorization.",
      );
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
        if (name.toLowerCase().startsWith("x-agentos-")) headers.delete(name);
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

    headers.set("originator", "pi");
    headers.set("OpenAI-Beta", "responses=experimental");
    const installationId = canonicalUuid(
      yield* (params.codexInstallationId === undefined
        ? resolveCodexInstallationId()
        : params.codexInstallationId().pipe(
          Effect.mapError(() =>
            compactionError(
              "identity_unavailable",
              "OpenAI Codex installation identity could not be resolved.",
            )
          ),
        )),
    );
    if (installationId) headers.set("x-codex-installation-id", installationId);
    else headers.delete("x-codex-installation-id");

    const crypto = yield* Crypto.Crypto;
    const requestId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() =>
        compactionError(
          "identity_unavailable",
          "OpenAI Codex request identity could not be generated.",
        )
      ),
    );
    headers.set("x-client-request-id", requestId);
    if (params.sessionId) {
      headers.set("session-id", params.sessionId);
      headers.set("thread-id", params.sessionId);
      headers.set("x-codex-window-id", `${params.sessionId}:0`);
    }

    const hostname = yield* endpointHostname(endpoint);
    if (hostname === "chatgpt.com" && !headers.has("chatgpt-account-id")) {
      const accountId = params.apiKey === undefined
        ? undefined
        : yield* accountIdFromToken(params.apiKey);
      if (!accountId) {
        return yield* compactionError(
          "missing_account_identity",
          "OpenAI Codex authorization has no account identity.",
        );
      }
      headers.set("chatgpt-account-id", accountId);
    }
    return headers;
  });
}

function emptyBoundedBody(): BoundedBody {
  return { chunks: [], length: 0 };
}

function boundedResponseText(response: OpenAICompactionHttpResponse) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_RESPONSE_BYTES
  ) {
    return Effect.fail(
      compactionError(
        "response_too_large",
        "OpenAI server compaction response exceeded the size limit.",
      ),
    );
  }
  if (response.body === null) return Effect.succeed("");
  return response.body.pipe(
    Stream.mapError(() =>
      compactionError(
        "network_failure",
        "OpenAI server compaction response stream failed.",
      )
    ),
    Stream.runFoldEffect(emptyBoundedBody, (state, chunk) => {
      const length = state.length + chunk.byteLength;
      return length > MAX_RESPONSE_BYTES
        ? Effect.fail(
          compactionError(
            "response_too_large",
            "OpenAI server compaction response exceeded the size limit.",
          ),
        )
        : Effect.succeed({ chunks: [...state.chunks, chunk], length });
    }),
    Effect.map(({ chunks, length }) => {
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    }),
  );
}

function decodeJson(source: string) {
  return Schema.decodeUnknownEffect(UnknownJsonString)(source).pipe(
    Effect.mapError(() =>
      compactionError(
        "invalid_response",
        "OpenAI server compaction returned invalid JSON.",
      )
    ),
  );
}

function parseSse(text: string) {
  return Effect.gen(function*() {
    const events: ProviderEvent[] = [];
    for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data || data === "[DONE]") continue;
      const value = yield* decodeJson(data).pipe(
        Effect.mapError(() =>
          compactionError(
            "invalid_response",
            "OpenAI server compaction returned invalid SSE data.",
          )
        ),
      );
      const event = parseProviderEvent(value);
      if (event === undefined) {
        return yield* compactionError(
          "invalid_response",
          "OpenAI server compaction returned invalid SSE data.",
        );
      }
      events.push(event);
    }
    return events;
  });
}

function cloneResponseItem<T extends ResponseItem>(item: T): T {
  return structuredClone(item);
}

function isRealUserMessage(item: ResponseItem): boolean {
  const decoded = Schema.decodeUnknownOption(UserMessageSchema)(item);
  return Option.isSome(decoded) && decoded.value.content.length > 0;
}

function responseMessageText(item: ResponseItem): string {
  const decoded = Schema.decodeUnknownOption(UserMessageSchema)(item);
  if (!Option.isSome(decoded)) return "";
  return decoded.value.content
    .flatMap((part) =>
      "text" in part && typeof part.text === "string" ? [part.text] : []
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
  const decoded = Schema.decodeUnknownOption(UserMessageSchema)(item);
  if (!Option.isSome(decoded)) return undefined;
  let remainingCharacters = Math.max(0, maxTokens * 4);
  const content = decoded.value.content.flatMap((part) => {
    if (!("text" in part) || typeof part.text !== "string") {
      return [structuredClone(part)];
    }
    if (remainingCharacters === 0) return [];
    const text = part.text.slice(0, remainingCharacters);
    remainingCharacters -= text.length;
    return text ? [{ ...structuredClone(part), text }] : [];
  });
  if (content.length === 0) return undefined;
  return parseResponseItems([{ ...cloneResponseItem(item), content }])?.[0];
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
  return [...retainedReversed.reverse(), cloneResponseItem(artifact)];
}

function requiredResponseUsage(value: unknown) {
  if (value === undefined) return Effect.succeed(undefined);
  const usage = parseResponseUsage(value);
  return usage === undefined
    ? Effect.fail(
      compactionError(
        "invalid_response",
        "OpenAI server compaction returned invalid usage.",
      ),
    )
    : Effect.succeed(usage);
}

function recordArtifact(
  artifacts: Map<string, CompactionArtifact>,
  artifact: CompactionArtifact,
) {
  const existing = artifacts.get(artifact.encrypted_content);
  if (existing !== undefined && !Equal.equals(existing, artifact)) {
    return Effect.fail(
      compactionError(
        "invalid_response",
        "OpenAI server compaction returned ambiguous compaction artifacts.",
      ),
    );
  }
  artifacts.set(artifact.encrypted_content, existing ?? artifact);
  return Effect.void;
}

function parseCompactionEvents(events: ProviderEvent[]) {
  return Effect.gen(function*() {
    let terminalType: "response.completed" | "response.done" | undefined;
    let terminalOutput: ResponseItem[] | undefined;
    const streamedOutput: ResponseItem[] = [];
    let usage: ResponseUsage | undefined;
    const artifacts = new Map<string, CompactionArtifact>();

    for (const value of events) {
      if (value.type === "response.incomplete") {
        return yield* compactionError(
          "response_failed",
          "OpenAI server compaction response was incomplete.",
        );
      }
      if (
        value.type === "error" ||
        value.type === "response.error" ||
        value.type === "response.failed" ||
        value.type === "response.cancelled"
      ) {
        return yield* compactionError(
          "response_failed",
          "OpenAI server compaction failed.",
        );
      }
      if (value.type === "response.output_item.done") {
        const event = parseOutputItemDoneEvent(value);
        if (event === undefined) {
          return yield* compactionError(
            "invalid_response",
            "OpenAI server compaction returned an invalid output item.",
          );
        }
        streamedOutput.push(event.item);
        if (isCompactionArtifact(event.item)) {
          yield* recordArtifact(artifacts, event.item);
        }
        continue;
      }
      if (value.type !== "response.completed" && value.type !== "response.done") {
        continue;
      }
      if (terminalType !== undefined) {
        return yield* compactionError(
          "invalid_response",
          "OpenAI server compaction returned multiple terminal events.",
        );
      }
      const event = parseTerminalEvent(value);
      if (event === undefined) {
        return yield* compactionError(
          "invalid_response",
          "OpenAI server compaction returned no terminal response.",
        );
      }
      terminalType = event.type;
      const response = event.response;
      if (response.status !== "completed") {
        return yield* compactionError(
          "response_failed",
          "OpenAI server compaction terminal response was not completed.",
        );
      }
      usage = yield* requiredResponseUsage(response.usage);
      if (response.output !== undefined && response.output !== null) {
        const parsedOutput = parseResponseItems(response.output);
        if (parsedOutput === undefined || parsedOutput.length === 0) {
          return yield* compactionError(
            "invalid_response",
            "OpenAI server compaction returned an invalid terminal response.",
          );
        }
        terminalOutput = parsedOutput;
        for (const output of terminalOutput) {
          if (isCompactionArtifact(output)) {
            yield* recordArtifact(artifacts, output);
          }
        }
      }
    }

    if (terminalType === undefined) {
      return yield* compactionError(
        "invalid_response",
        "OpenAI server compaction stream ended before response.completed.",
      );
    }
    if (artifacts.size !== 1) {
      return yield* compactionError(
        "invalid_response",
        `OpenAI server compaction expected one artifact, received ${artifacts.size}.`,
      );
    }
    const output = terminalOutput ?? streamedOutput;
    if (output.length === 0) {
      return yield* compactionError(
        "missing_artifact",
        "OpenAI server compaction returned no canonical output.",
      );
    }
    const outputArtifacts = output.filter(isCompactionArtifact);
    if (outputArtifacts.length !== 1) {
      return yield* compactionError(
        "invalid_response",
        `OpenAI server compaction canonical output expected one artifact, received ${outputArtifacts.length}.`,
      );
    }
    return { output, ...(usage ? { usage } : {}) } satisfies ServerCompactionResult;
  });
}

function parseDirectCompactionResponse(text: string) {
  return Effect.gen(function*() {
    const value = yield* decodeJson(text).pipe(
      Effect.mapError(() =>
        compactionError(
          "invalid_response",
          "OpenAI server compaction returned invalid compact response JSON.",
        )
      ),
    );
    const parsed = parseDirectCompactResponse(value);
    if (parsed === undefined) {
      return yield* compactionError(
        "invalid_response",
        "OpenAI server compaction returned an invalid compact response.",
      );
    }
    const artifacts = parsed.output.filter(isCompactionArtifact);
    if (artifacts.length !== 1) {
      return yield* compactionError(
        "invalid_response",
        `OpenAI server compaction compact response expected one artifact, received ${artifacts.length}.`,
      );
    }
    return {
      output: parsed.output,
      usage: parsed.usage,
    } satisfies ServerCompactionResult;
  });
}

function encodeRequestBody(value: unknown) {
  return Schema.encodeEffect(UnknownJsonString)(value).pipe(
    Effect.mapError(() =>
      compactionError(
        "invalid_request",
        "OpenAI server compaction request body is not JSON-safe.",
      )
    ),
  );
}

export function requestServerCompaction(
  params: ServerCompactionRequest,
): Effect.Effect<
  ServerCompactionResult,
  OpenAICompactionFailure,
  CompactionPlatform
> {
  const request = Effect.scoped(Effect.gen(function*() {
    const endpoint = endpointForModel(params.model);
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
    const encodedBody = yield* encodeRequestBody(body);
    const headers = yield* requestHeaders(params, endpoint);
    const transportEffect: Effect.Effect<
      OpenAICompactionHttpResponse,
      unknown,
      HttpClient.HttpClient | Scope.Scope
    > = params.fetchImpl === undefined
      ? defaultFetch(endpoint, {
        method: "POST",
        headers,
        body: encodedBody,
      })
      : params.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: encodedBody,
      });
    const response = yield* transportEffect.pipe(
      Effect.mapError(() =>
        compactionError(
          "network_failure",
          "OpenAI server compaction request failed before receiving a response.",
        )
      ),
    );
    return yield* Effect.gen(function*() {
      if (response.status < 200 || response.status >= 300) {
        return yield* new OpenAICompactionHttpError(response.status);
      }
      const responseText = yield* boundedResponseText(response);
      if (!isCodexModel(params.model)) {
        return yield* parseDirectCompactionResponse(responseText);
      }
      const events = yield* parseSse(responseText);
      const result = yield* parseCompactionEvents(events);
      const artifact = result.output.find(isCompactionArtifact);
      if (artifact === undefined) {
        return yield* compactionError(
          "missing_artifact",
          "OpenAI server compaction returned no canonical artifact.",
        );
      }
      return {
        output: buildRemoteCompactionHistory(params.input, artifact),
        ...(result.usage ? { usage: result.usage } : {}),
      } satisfies ServerCompactionResult;
    }).pipe(Effect.ensuring(response.close));
  }));

  const timed = request.pipe(
    Effect.timeoutOrElse({
      duration: normalizedTimeout(params.timeoutMs),
      orElse: () =>
        Effect.fail(
          compactionError(
            "timeout",
            `OpenAI server compaction timed out after ${normalizedTimeout(params.timeoutMs)}ms.`,
          ),
        ),
    }),
  );
  return Effect.raceFirst(timed, callerAbort(params.signal));
}
