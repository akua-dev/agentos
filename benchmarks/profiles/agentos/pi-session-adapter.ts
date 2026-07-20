import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const SCHEMA_VERSION = "0.1.0";
const SUPPORTED_PI_SESSION_VERSION = 3;
const UNOBSERVED = "unobserved" as const;
const MAX_SESSION_CHARACTERS = 10_000_000;
const MAX_SESSION_ENTRIES = 10_000;
const MAX_EVENTS = 1_000;
const MAX_TEXT_LENGTH = 256;

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
  toolCallId: string;
  event: PiActionEvent;
  callTimestampMs: number | undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function argumentDigest(value: unknown): string | typeof UNOBSERVED {
  if (asObject(value) === undefined) return UNOBSERVED;
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function timestampMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedTimestamp(messageTimestamp: unknown, entryTimestamp: unknown): string | typeof UNOBSERVED {
  const milliseconds = timestampMilliseconds(messageTimestamp) ?? timestampMilliseconds(entryTimestamp);
  return milliseconds === undefined ? UNOBSERVED : new Date(milliseconds).toISOString();
}

function parseJsonLines(content: string): JsonObject[] {
  if (content.length > MAX_SESSION_CHARACTERS) throw new Error("Pi session exceeds the supported size limit");
  const entries: JsonObject[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Pi session line ${index + 1} is not valid JSON`);
    }
    const entry = asObject(value);
    if (entry === undefined) throw new Error(`Pi session line ${index + 1} is not an object`);
    entries.push(entry);
    if (entries.length > MAX_SESSION_ENTRIES) throw new Error("Pi session exceeds the supported entry limit");
  }
  return entries;
}

function activeBranch(entries: JsonObject[]): JsonObject[] {
  if (entries.length === 0) return [];
  const entriesById = new Map<string, JsonObject>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id === "") throw new Error("Pi session entry is missing its id");
    if (entriesById.has(entry.id)) throw new Error(`duplicate Pi session entry id: ${entry.id}`);
    if (entry.parentId !== null && typeof entry.parentId !== "string") {
      throw new Error(`Pi session entry ${entry.id} has an invalid parentId`);
    }
    entriesById.set(entry.id, entry);
  }

  const branch: JsonObject[] = [];
  const visited = new Set<string>();
  let current: JsonObject | undefined = entries.at(-1);
  while (current !== undefined) {
    const id = current.id as string;
    if (visited.has(id)) throw new Error("Pi session branch contains a cycle");
    visited.add(id);
    branch.push(current);
    if (current.parentId === null) break;
    current = entriesById.get(current.parentId as string);
    if (current === undefined) throw new Error(`Pi session entry ${id} references a missing parent`);
  }
  return branch.reverse();
}

function countRedactedContent(message: JsonObject, counts: Map<string, number>): void {
  const role = message.role;
  const content = Array.isArray(message.content) ? message.content : [];
  if (role === "user") counts.set("full_prompts", (counts.get("full_prompts") ?? 0) + 1);
  if (role === "toolResult") counts.set("tool_results", (counts.get("tool_results") ?? 0) + 1);
  if (role !== "assistant") return;
  for (const block of content) {
    const type = asObject(block)?.type;
    if (type === "thinking") counts.set("raw_reasoning", (counts.get("raw_reasoning") ?? 0) + 1);
    else if (type !== "toolCall") counts.set("assistant_content", (counts.get("assistant_content") ?? 0) + 1);
  }
}

function countRedactedEntry(entry: JsonObject, counts: Map<string, number>): void {
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    counts.set("session_summaries", (counts.get("session_summaries") ?? 0) + 1);
  } else if (entry.type === "custom" || entry.type === "custom_message") {
    counts.set("extension_content", (counts.get("extension_content") ?? 0) + 1);
  }
}

function requireBoundedText(label: string, value: string): void {
  if (value.trim() === "") throw new Error(`${label} must not be empty`);
  if (value.length > MAX_TEXT_LENGTH) throw new Error(`${label} exceeds the supported length limit`);
}

export function projectPiSession(
  content: string,
  actor: string,
  acceptedWorkReference: string,
): PiActionTrajectory {
  requireBoundedText("actor", actor);
  requireBoundedText("accepted-work reference", acceptedWorkReference);

  const entries = parseJsonLines(content);
  const header = entries[0];
  if (header?.type !== "session") throw new Error("Pi session must begin with a session header");
  const version = header.version ?? 1;
  if (version !== SUPPORTED_PI_SESSION_VERSION) {
    throw new Error(`unsupported Pi session version: ${String(version)}`);
  }

  const actions: PendingAction[] = [];
  const actionsByToolCallId = new Map<string, PendingAction>();
  const redactionCounts = new Map<string, number>();

  for (const entry of activeBranch(entries.slice(1))) {
    if (entry.type !== "message") {
      countRedactedEntry(entry, redactionCounts);
      continue;
    }
    const message = asObject(entry.message);
    if (message === undefined) throw new Error("Pi message entry is missing its message object");
    countRedactedContent(message, redactionCounts);

    if (message.role === "bashExecution") {
      const digest = typeof message.command === "string"
        ? argumentDigest({ command: message.command })
        : UNOBSERVED;
      if (digest === UNOBSERVED) {
        redactionCounts.set("unavailable_arguments", (redactionCounts.get("unavailable_arguments") ?? 0) + 1);
      } else {
        redactionCounts.set("tool_arguments", (redactionCounts.get("tool_arguments") ?? 0) + 1);
      }
      redactionCounts.set("tool_results", (redactionCounts.get("tool_results") ?? 0) + 1);
      let resultClass: PiActionEvent["result_class"] = UNOBSERVED;
      if (message.cancelled === true) resultClass = "error";
      else if (typeof message.exitCode === "number") resultClass = message.exitCode === 0 ? "success" : "error";
      const messageTimestampMs = timestampMilliseconds(message.timestamp) ?? timestampMilliseconds(entry.timestamp);
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
      if (actions.length > MAX_EVENTS) throw new Error("Pi session exceeds the supported action limit");
      continue;
    }

    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const blockValue of blocks) {
        const block = asObject(blockValue);
        if (block?.type !== "toolCall") continue;
        if (typeof block.id !== "string" || block.id === "") throw new Error("Pi tool call is missing its id");
        if (typeof block.name !== "string" || block.name === "") throw new Error(`Pi tool call ${block.id} is missing its name`);
        if (block.name.length > MAX_TEXT_LENGTH) throw new Error(`Pi tool call ${block.id} name exceeds the supported length limit`);
        if (actionsByToolCallId.has(block.id)) throw new Error(`duplicate Pi tool call id: ${block.id}`);

        const digest = argumentDigest(block.arguments);
        if (digest === UNOBSERVED) {
          redactionCounts.set("unavailable_arguments", (redactionCounts.get("unavailable_arguments") ?? 0) + 1);
        } else {
          redactionCounts.set("tool_arguments", (redactionCounts.get("tool_arguments") ?? 0) + 1);
        }
        const callTimestampMs = timestampMilliseconds(message.timestamp) ?? timestampMilliseconds(entry.timestamp);
        const action: PendingAction = {
          toolCallId: block.id,
          callTimestampMs,
          event: {
            timestamp: normalizedTimestamp(message.timestamp, entry.timestamp),
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
        if (actions.length > MAX_EVENTS) throw new Error("Pi session exceeds the supported action limit");
        actionsByToolCallId.set(block.id, action);
      }
      continue;
    }

    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const action = actionsByToolCallId.get(message.toolCallId);
    if (action === undefined) continue;
    if (typeof message.toolName === "string" && message.toolName !== action.event.tool_name) {
      throw new Error(`Pi tool result name does not match call ${message.toolCallId}`);
    }
    if (message.isError === true) action.event.result_class = "error";
    else if (message.isError === false) action.event.result_class = "success";

    const resultTimestampMs = timestampMilliseconds(message.timestamp) ?? timestampMilliseconds(entry.timestamp);
    if (action.callTimestampMs !== undefined && resultTimestampMs !== undefined && resultTimestampMs >= action.callTimestampMs) {
      action.event.duration_ms = resultTimestampMs - action.callTimestampMs;
    }
  }

  const previousBySignature = new Map<string, { index: number; result: PiActionEvent["result_class"] }>();
  for (const [index, action] of actions.entries()) {
    const digest = action.event.arguments_digest;
    if (digest === UNOBSERVED) {
      action.event.retry_of = UNOBSERVED;
      continue;
    }
    const signature = `${action.event.tool_name}\u0000${digest}`;
    const previous = previousBySignature.get(signature);
    if (previous?.result === "error") action.event.retry_of = previous.index;
    else if (previous?.result === UNOBSERVED) action.event.retry_of = UNOBSERVED;
    previousBySignature.set(signature, { index: index + 1, result: action.event.result_class });
  }

  const redactionMethods: Record<string, string> = {
    full_prompts: "omitted",
    raw_reasoning: "omitted",
    assistant_content: "omitted",
    extension_content: "omitted",
    session_summaries: "omitted",
    tool_arguments: "replaced with canonical JSON SHA-256 digest",
    unavailable_arguments: "marked unobserved",
    tool_results: "classified from native Pi result state, then omitted",
  };

  return {
    schema_version: SCHEMA_VERSION,
    harness: "pi",
    events: actions.map(({ event }) => event),
    redactions: [...redactionCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => ({ kind, count, method: redactionMethods[kind]! })),
  };
}

function usage(): never {
  throw new Error("usage: bun benchmarks/profiles/agentos/pi-session-adapter.ts <session.jsonl> --actor <actor> --accepted-work-reference <reference>");
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    const sessionPath = args[0];
    const actor = optionValue(args, "--actor");
    const acceptedWorkReference = optionValue(args, "--accepted-work-reference");
    if (sessionPath === undefined || actor === undefined || acceptedWorkReference === undefined) usage();
    const content = await readFile(sessionPath, "utf8");
    console.log(JSON.stringify(projectPiSession(content, actor, acceptedWorkReference), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
