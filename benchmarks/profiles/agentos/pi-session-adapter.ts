#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Crypto,
  Effect,
  FileSystem,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect";

const SCHEMA_VERSION = "0.1.0";
const SUPPORTED_PI_SESSION_VERSION = 3;
const UNOBSERVED = "unobserved";
const MAX_SESSION_CHARACTERS = 10_000_000;
const MAX_SESSION_ENTRIES = 10_000;
const MAX_EVENTS = 1_000;
const MAX_TEXT_LENGTH = 256;

const ProjectionErrorCodeSchema = Schema.Literals([
  "invalid_argument",
  "invalid_json",
  "invalid_session",
  "unsupported_version",
  "session_limit",
  "invalid_branch",
  "invalid_action",
  "result_mismatch",
  "filesystem",
  "encoding",
  "usage",
]);

export class PiSessionProjectionError extends Schema.TaggedErrorClass<PiSessionProjectionError>()(
  "PiSessionProjectionError",
  {
    code: ProjectionErrorCodeSchema,
    message: Schema.String,
    line: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorExitCode] = 1;
}

type JsonObject = Record<string, unknown>;

export interface PiActionEvent {
  timestamp: string | typeof UNOBSERVED;
  actor: string;
  event_type: "tool_call" | "bash_execution";
  tool_name: string;
  arguments_digest: string | typeof UNOBSERVED;
  result_class: "success" | "error" | typeof UNOBSERVED;
  duration_ms: number | typeof UNOBSERVED;
  retry_of: number | null | typeof UNOBSERVED;
  accepted_work_reference: string;
}

export interface PiActionTrajectory {
  schema_version: typeof SCHEMA_VERSION;
  harness: "pi";
  events: PiActionEvent[];
  redactions: Array<{
    kind: string;
    count: number;
    method: string;
  }>;
}

interface PendingAction {
  readonly toolCallId: string;
  readonly event: PiActionEvent;
  readonly callTimestampMs: number | undefined;
}

interface BranchEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly value: JsonObject;
}

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const JsonObjectFromString = Schema.fromJsonString(JsonObjectSchema);
const JsonValueFromString = Schema.fromJsonString(Schema.Unknown);

const isJsonObject = Schema.is(JsonObjectSchema);

const PiActionEventSchema = Schema.Struct({
  timestamp: Schema.String,
  actor: Schema.String,
  event_type: Schema.Literals(["tool_call", "bash_execution"]),
  tool_name: Schema.String,
  arguments_digest: Schema.String,
  result_class: Schema.Literals(["success", "error", UNOBSERVED]),
  duration_ms: Schema.Union([Schema.Number, Schema.Literal(UNOBSERVED)]),
  retry_of: Schema.Union([
    Schema.Number,
    Schema.Null,
    Schema.Literal(UNOBSERVED),
  ]),
  accepted_work_reference: Schema.String,
});

export const PiActionTrajectorySchema = Schema.Struct({
  schema_version: Schema.Literal(SCHEMA_VERSION),
  harness: Schema.Literal("pi"),
  events: Schema.Array(PiActionEventSchema),
  redactions: Schema.Array(Schema.Struct({
    kind: Schema.String,
    count: Schema.Number,
    method: Schema.String,
  })),
});

const projectionError = (
  code: typeof ProjectionErrorCodeSchema.Type,
  message: string,
  options?: { readonly line?: number; readonly cause?: unknown },
) => PiSessionProjectionError.make({ code, message, ...options });

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isJsonObject(value)) return value;
  const canonical: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    canonical[key] = canonicalize(value[key]);
  }
  return canonical;
}

const argumentDigest = Effect.fn("agentos.benchmark.pi.argumentDigest")(
  function*(value: unknown) {
    if (!isJsonObject(value)) return UNOBSERVED;
    const crypto = yield* Crypto.Crypto;
    const canonical = yield* Schema.encodeEffect(JsonValueFromString)(
      canonicalize(value),
    ).pipe(
      Effect.mapError((cause) =>
        projectionError(
          "encoding",
          "Pi tool arguments could not be canonically encoded",
          { cause },
        )
      ),
    );
    const digest = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    ).pipe(
      Effect.mapError((cause) =>
        projectionError("encoding", "Pi tool arguments could not be hashed", {
          cause,
        })
      ),
    );
    return `sha256:${Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")}`;
  },
);

function timestampMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) &&
        value >= 0 &&
        Number.isFinite(new Date(value).getTime())
      ? value
      : undefined;
  }
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : undefined;
}

function normalizedTimestamp(
  messageTimestamp: unknown,
  entryTimestamp: unknown,
): string | typeof UNOBSERVED {
  const milliseconds = timestampMilliseconds(messageTimestamp) ??
    timestampMilliseconds(entryTimestamp);
  return milliseconds === undefined
    ? UNOBSERVED
    : new Date(milliseconds).toISOString();
}

const parseJsonLines = Effect.fn("agentos.benchmark.pi.parseJsonLines")(
  function*(content: string) {
    if (content.length > MAX_SESSION_CHARACTERS) {
      return yield* projectionError(
        "session_limit",
        "Pi session exceeds the supported size limit",
      );
    }
    const entries: JsonObject[] = [];
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (line.trim() === "") continue;
      const entry = yield* Schema.decodeUnknownEffect(JsonObjectFromString)(
        line,
      ).pipe(
        Effect.mapError((cause) =>
          projectionError(
            "invalid_json",
            `Pi session line ${index + 1} is not a valid JSON object`,
            { cause, line: index + 1 },
          )
        ),
      );
      entries.push(entry);
      if (entries.length > MAX_SESSION_ENTRIES) {
        return yield* projectionError(
          "session_limit",
          "Pi session exceeds the supported entry limit",
        );
      }
    }
    return entries;
  },
);

const activeBranch = Effect.fn("agentos.benchmark.pi.activeBranch")(
  function*(entries: ReadonlyArray<JsonObject>) {
    if (entries.length === 0) return [];
    const entriesById = new Map<string, BranchEntry>();
    let latest: BranchEntry | undefined;
    for (const entry of entries) {
      const id = entry.id;
      if (typeof id !== "string" || id === "") {
        return yield* projectionError(
          "invalid_branch",
          "Pi session entry is missing its id",
        );
      }
      if (entriesById.has(id)) {
        return yield* projectionError(
          "invalid_branch",
          `duplicate Pi session entry id: ${id}`,
        );
      }
      const parentId = entry.parentId;
      if (parentId !== null && typeof parentId !== "string") {
        return yield* projectionError(
          "invalid_branch",
          `Pi session entry ${id} has an invalid parentId`,
        );
      }
      latest = { id, parentId, value: entry };
      entriesById.set(id, latest);
    }

    const branch: JsonObject[] = [];
    const visited = new Set<string>();
    let current = latest;
    while (current !== undefined) {
      if (visited.has(current.id)) {
        return yield* projectionError(
          "invalid_branch",
          "Pi session branch contains a cycle",
        );
      }
      visited.add(current.id);
      branch.push(current.value);
      if (current.parentId === null) break;
      const childId = current.id;
      current = entriesById.get(current.parentId);
      if (current === undefined) {
        return yield* projectionError(
          "invalid_branch",
          `Pi session entry ${childId} references a missing parent`,
        );
      }
    }
    return branch.reverse();
  },
);

function countRedactedContent(
  message: JsonObject,
  counts: Map<string, number>,
): void {
  const role = message.role;
  const content = Array.isArray(message.content) ? message.content : [];
  if (role === "user") {
    counts.set("full_prompts", (counts.get("full_prompts") ?? 0) + 1);
  }
  if (role === "toolResult") {
    counts.set("tool_results", (counts.get("tool_results") ?? 0) + 1);
  }
  if (role !== "assistant") return;
  for (const block of content) {
    const type = isJsonObject(block) ? block.type : undefined;
    if (type === "thinking") {
      counts.set("raw_reasoning", (counts.get("raw_reasoning") ?? 0) + 1);
    } else if (type !== "toolCall") {
      counts.set(
        "assistant_content",
        (counts.get("assistant_content") ?? 0) + 1,
      );
    }
  }
}

function countRedactedEntry(
  entry: JsonObject,
  counts: Map<string, number>,
): void {
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    counts.set(
      "session_summaries",
      (counts.get("session_summaries") ?? 0) + 1,
    );
  } else if (entry.type === "custom" || entry.type === "custom_message") {
    counts.set(
      "extension_content",
      (counts.get("extension_content") ?? 0) + 1,
    );
  } else if (entry.type === "model_change") {
    counts.set("model_changes", (counts.get("model_changes") ?? 0) + 1);
  } else if (entry.type === "thinking_level_change") {
    counts.set(
      "thinking_level_changes",
      (counts.get("thinking_level_changes") ?? 0) + 1,
    );
  } else if (entry.type === "label") {
    counts.set("labels", (counts.get("labels") ?? 0) + 1);
  } else if (entry.type === "session_info") {
    counts.set("session_info", (counts.get("session_info") ?? 0) + 1);
  }
}

const requireBoundedText = Effect.fn("agentos.benchmark.pi.requireText")(
  function*(label: string, value: string) {
    if (value.trim() === "") {
      return yield* projectionError(
        "invalid_argument",
        `${label} must not be empty`,
      );
    }
    if (value.length > MAX_TEXT_LENGTH) {
      return yield* projectionError(
        "invalid_argument",
        `${label} exceeds the supported length limit`,
      );
    }
  },
);

export const projectPiSession = Effect.fn(
  "agentos.benchmark.pi.projectSession",
)(function*(
  content: string,
  actor: string,
  acceptedWorkReference: string,
) {
  yield* requireBoundedText("actor", actor);
  yield* requireBoundedText("accepted-work reference", acceptedWorkReference);

  const entries = yield* parseJsonLines(content);
  const header = entries[0];
  if (header?.type !== "session") {
    return yield* projectionError(
      "invalid_session",
      "Pi session must begin with a session header",
    );
  }
  const version = header.version ?? 1;
  if (version !== SUPPORTED_PI_SESSION_VERSION) {
    return yield* projectionError(
      "unsupported_version",
      `unsupported Pi session version: ${String(version)}`,
    );
  }

  const actions: PendingAction[] = [];
  const actionsByToolCallId = new Map<string, PendingAction>();
  const redactionCounts = new Map<string, number>([["session_metadata", 1]]);

  for (const entry of yield* activeBranch(entries.slice(1))) {
    if (entry.type !== "message") {
      countRedactedEntry(entry, redactionCounts);
      continue;
    }
    const message = isJsonObject(entry.message) ? entry.message : undefined;
    if (message === undefined) {
      return yield* projectionError(
        "invalid_session",
        "Pi message entry is missing its message object",
      );
    }
    countRedactedContent(message, redactionCounts);

    if (message.role === "bashExecution") {
      const digest = typeof message.command === "string"
        ? yield* argumentDigest({ command: message.command })
        : UNOBSERVED;
      incrementArgumentRedaction(redactionCounts, digest);
      redactionCounts.set(
        "tool_results",
        (redactionCounts.get("tool_results") ?? 0) + 1,
      );
      let resultClass: PiActionEvent["result_class"] = UNOBSERVED;
      if (message.cancelled === true) resultClass = "error";
      else if (typeof message.exitCode === "number") {
        resultClass = message.exitCode === 0 ? "success" : "error";
      }
      const messageTimestampMs = timestampMilliseconds(message.timestamp) ??
        timestampMilliseconds(entry.timestamp);
      actions.push({
        toolCallId: `bash-execution:${actions.length + 1}`,
        callTimestampMs: messageTimestampMs,
        event: {
          timestamp: normalizedTimestamp(message.timestamp, entry.timestamp),
          actor,
          event_type: "bash_execution",
          tool_name: "bash",
          arguments_digest: digest,
          result_class: resultClass,
          duration_ms: UNOBSERVED,
          retry_of: null,
          accepted_work_reference: acceptedWorkReference,
        },
      });
      yield* ensureActionLimit(actions.length);
      continue;
    }

    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const blockValue of blocks) {
        const block = isJsonObject(blockValue) ? blockValue : undefined;
        if (block?.type !== "toolCall") continue;
        if (typeof block.id !== "string" || block.id === "") {
          return yield* projectionError(
            "invalid_action",
            "Pi tool call is missing its id",
          );
        }
        if (typeof block.name !== "string" || block.name === "") {
          return yield* projectionError(
            "invalid_action",
            `Pi tool call ${block.id} is missing its name`,
          );
        }
        if (block.name.length > MAX_TEXT_LENGTH) {
          return yield* projectionError(
            "invalid_action",
            `Pi tool call ${block.id} name exceeds the supported length limit`,
          );
        }
        if (actionsByToolCallId.has(block.id)) {
          return yield* projectionError(
            "invalid_action",
            `duplicate Pi tool call id: ${block.id}`,
          );
        }

        const digest = yield* argumentDigest(block.arguments);
        incrementArgumentRedaction(redactionCounts, digest);
        const callTimestampMs = timestampMilliseconds(message.timestamp) ??
          timestampMilliseconds(entry.timestamp);
        const action: PendingAction = {
          toolCallId: block.id,
          callTimestampMs,
          event: {
            timestamp: normalizedTimestamp(
              message.timestamp,
              entry.timestamp,
            ),
            actor,
            event_type: "tool_call",
            tool_name: block.name,
            arguments_digest: digest,
            result_class: UNOBSERVED,
            duration_ms: UNOBSERVED,
            retry_of: null,
            accepted_work_reference: acceptedWorkReference,
          },
        };
        actions.push(action);
        yield* ensureActionLimit(actions.length);
        actionsByToolCallId.set(block.id, action);
      }
      continue;
    }

    if (
      message.role !== "toolResult" ||
      typeof message.toolCallId !== "string"
    ) continue;
    const action = actionsByToolCallId.get(message.toolCallId);
    if (action === undefined) continue;
    if (
      typeof message.toolName === "string" &&
      message.toolName !== action.event.tool_name
    ) {
      return yield* projectionError(
        "result_mismatch",
        `Pi tool result name does not match call ${message.toolCallId}`,
      );
    }
    if (message.isError === true) action.event.result_class = "error";
    else if (message.isError === false) action.event.result_class = "success";

    const resultTimestampMs = timestampMilliseconds(message.timestamp) ??
      timestampMilliseconds(entry.timestamp);
    if (
      action.callTimestampMs !== undefined &&
      resultTimestampMs !== undefined &&
      resultTimestampMs >= action.callTimestampMs
    ) {
      action.event.duration_ms = resultTimestampMs - action.callTimestampMs;
    }
  }

  annotateRetries(actions);
  const redactionMethods: Record<string, string> = {
    full_prompts: "omitted",
    raw_reasoning: "omitted",
    assistant_content: "omitted",
    extension_content: "omitted",
    labels: "omitted",
    model_changes: "omitted",
    session_info: "omitted",
    session_metadata: "omitted except supported format version",
    session_summaries: "omitted",
    thinking_level_changes: "omitted",
    tool_arguments: "replaced with canonical JSON SHA-256 digest",
    unavailable_arguments: "marked unobserved",
    tool_results: "classified from native Pi result state, then omitted",
  };
  const redactions = [...redactionCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => ({
      kind,
      count,
      method: redactionMethods[kind] ?? "omitted",
    }));

  return {
    schema_version: SCHEMA_VERSION,
    harness: "pi",
    events: actions.map(({ event }) => event),
    redactions,
  } satisfies PiActionTrajectory;
});

function incrementArgumentRedaction(
  counts: Map<string, number>,
  digest: string | typeof UNOBSERVED,
): void {
  const kind = digest === UNOBSERVED
    ? "unavailable_arguments"
    : "tool_arguments";
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}

const ensureActionLimit = Effect.fn("agentos.benchmark.pi.actionLimit")(
  function*(length: number) {
    if (length > MAX_EVENTS) {
      return yield* projectionError(
        "session_limit",
        "Pi session exceeds the supported action limit",
      );
    }
  },
);

function annotateRetries(actions: ReadonlyArray<PendingAction>): void {
  const previousBySignature = new Map<
    string,
    { latestFailure?: number; hasUnobserved: boolean }
  >();
  for (const [index, action] of actions.entries()) {
    const digest = action.event.arguments_digest;
    if (digest === UNOBSERVED) {
      action.event.retry_of = UNOBSERVED;
      continue;
    }
    const signature = [
      action.event.event_type,
      action.event.tool_name,
      digest,
    ].join("\u0000");
    const previous = previousBySignature.get(signature);
    if (previous?.latestFailure !== undefined) {
      action.event.retry_of = previous.latestFailure;
    } else if (previous?.hasUnobserved === true) {
      action.event.retry_of = UNOBSERVED;
    }
    previousBySignature.set(signature, {
      latestFailure: action.event.result_class === "error"
        ? index + 1
        : previous?.latestFailure,
      hasUnobserved: action.event.result_class === UNOBSERVED ||
        previous?.hasUnobserved === true,
    });
  }
}

function optionValue(
  args: ReadonlyArray<string>,
  name: string,
): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export const runPiSessionAdapter = Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const sessionPath = args[0];
  const actor = optionValue(args, "--actor");
  const acceptedWorkReference = optionValue(
    args,
    "--accepted-work-reference",
  );
  if (
    sessionPath === undefined ||
    actor === undefined ||
    acceptedWorkReference === undefined
  ) {
    return yield* projectionError(
      "usage",
      "usage: bun benchmarks/profiles/agentos/pi-session-adapter.ts <session.jsonl> --actor <actor> --accepted-work-reference <reference>",
    );
  }

  const info = yield* fileSystem.stat(sessionPath).pipe(
    Effect.mapError((cause) =>
      projectionError("filesystem", "Could not inspect Pi session", { cause })
    ),
  );
  if (info.size > MAX_SESSION_CHARACTERS) {
    return yield* projectionError(
      "session_limit",
      "Pi session exceeds the supported size limit",
    );
  }
  const content = yield* fileSystem.readFileString(sessionPath).pipe(
    Effect.mapError((cause) =>
      projectionError("filesystem", "Could not read Pi session", { cause })
    ),
  );
  const trajectory = yield* projectPiSession(
    content,
    actor,
    acceptedWorkReference,
  );
  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(PiActionTrajectorySchema),
  )(trajectory).pipe(
    Effect.mapError((cause) =>
      projectionError("encoding", "Could not encode Pi trajectory", {
        cause,
      })
    ),
  );
  yield* Stream.make(`${encoded}\n`).pipe(
    Stream.run(stdio.stdout()),
    Effect.mapError((cause) =>
      projectionError("filesystem", "Could not write Pi trajectory", {
        cause,
      })
    ),
  );
});

const reportFailure = (error: PiSessionProjectionError) =>
  Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(`${error.message}\n`).pipe(
      Stream.run(stdio.stderr()),
      Effect.ignore,
    );
  });

if (import.meta.main) {
  BunRuntime.runMain(
    runPiSessionAdapter.pipe(
      Effect.tapError(reportFailure),
      Effect.provide(BunServices.layer),
    ),
    { disableErrorReporting: true },
  );
}
