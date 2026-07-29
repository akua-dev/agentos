import { parse, stringify } from "yaml";

export const topicTypes = [
  "user",
  "feedback",
  "project",
  "reference",
] as const;

export type TopicType = (typeof topicTypes)[number];

export interface TopicMetadata {
  node_type: "memory";
  type: TopicType;
  scope: string;
  source_principal: string;
  observed_at: string;
  modified: string;
  pinned: boolean;
}

export interface ParsedTopic {
  metadata: TopicMetadata;
  body: string;
}

const metadataKeys = [
  "node_type",
  "type",
  "scope",
  "source_principal",
  "observed_at",
  "modified",
  "pinned",
] as const;

export function parseTopicFile(content: string): ParsedTopic {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) throw new Error("topic must start with YAML frontmatter");

  const raw = parse(match[1]!) as unknown;
  if (!isRecord(raw)) throw new Error("topic metadata must be a YAML object");
  const unknown = Object.keys(raw).filter(
    (key) => !metadataKeys.includes(key as (typeof metadataKeys)[number]),
  );
  if (unknown.length > 0) {
    throw new Error(`topic metadata has unknown fields: ${unknown.join(", ")}`);
  }
  if (raw.node_type !== "memory") {
    throw new Error('topic node_type must be "memory"');
  }
  if (
    typeof raw.type !== "string" ||
    !topicTypes.includes(raw.type as TopicType)
  ) {
    throw new Error(`topic type must be one of ${topicTypes.join(", ")}`);
  }
  const scope = boundedText(raw.scope, "scope");
  const sourcePrincipal = boundedText(
    raw.source_principal,
    "source_principal",
  );
  const observedAt = isoTimestamp(raw.observed_at, "observed_at");
  const modified = isoTimestamp(raw.modified, "modified");
  if (typeof raw.pinned !== "boolean") {
    throw new Error("topic pinned must be a boolean");
  }

  return {
    metadata: {
      node_type: "memory",
      type: raw.type as TopicType,
      scope,
      source_principal: sourcePrincipal,
      observed_at: observedAt,
      modified,
      pinned: raw.pinned,
    },
    body: match[2]!.replace(/\s+$/, ""),
  };
}

export function serializeTopicFile(topic: ParsedTopic): string {
  const validated = validateTopic(topic);
  const frontmatter = stringify(validated.metadata, {
    lineWidth: 0,
    sortMapEntries: false,
  }).trimEnd();
  return `---\n${frontmatter}\n---\n${validated.body.trimEnd()}\n`;
}

export function validateTopic(topic: ParsedTopic): ParsedTopic {
  return parseTopicFile(
    `---\n${stringify(topic.metadata, { lineWidth: 0 }).trimEnd()}\n---\n${topic.body.trimEnd()}\n`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`topic ${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > 256 || /[\r\n]/.test(normalized)) {
    throw new Error(`topic ${field} must be one line and at most 256 characters`);
  }
  return normalized;
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`topic ${field} must be an ISO timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`topic ${field} must be a normalized ISO timestamp`);
  }
  return value;
}
