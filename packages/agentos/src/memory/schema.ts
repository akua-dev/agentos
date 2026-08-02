import { Effect, Schema } from "effect";
import { parse, stringify } from "yaml";

export type TopicType = "user" | "feedback" | "project" | "reference";

export const topicTypes: ReadonlyArray<TopicType> = [
  "user",
  "feedback",
  "project",
  "reference",
];

export interface TopicMetadata {
  readonly node_type: "memory";
  readonly type: TopicType;
  readonly scope: string;
  readonly source_principal: string;
  readonly observed_at: string;
  readonly modified: string;
  readonly pinned: boolean;
}

export interface ParsedTopic {
  readonly metadata: TopicMetadata;
  readonly body: string;
}

const TopicSchemaErrorCode = Schema.Literals([
  "invalid_body",
  "invalid_frontmatter",
  "invalid_metadata",
  "yaml_failed",
]);

export class TopicSchemaError extends Schema.TaggedErrorClass<TopicSchemaError>()(
  "TopicSchemaError",
  {
    cause: Schema.Unknown,
    code: TopicSchemaErrorCode,
    message: Schema.String,
  },
) {}

const metadataKeys: ReadonlyArray<string> = [
  "node_type",
  "type",
  "scope",
  "source_principal",
  "observed_at",
  "modified",
  "pinned",
];

function schemaError(
  code: TopicSchemaError["code"],
  message: string,
  cause: unknown = message,
) {
  return TopicSchemaError.make({ cause, code, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTopicType(value: unknown): value is TopicType {
  return value === "user" ||
    value === "feedback" ||
    value === "project" ||
    value === "reference";
}

function boundedText(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return Effect.fail(
      schemaError(
        "invalid_metadata",
        `topic ${field} must be a non-empty string`,
      ),
    );
  }
  const normalized = value.trim();
  if (normalized.length > 256 || /[\r\n]/.test(normalized)) {
    return Effect.fail(
      schemaError(
        "invalid_metadata",
        `topic ${field} must be one line and at most 256 characters`,
      ),
    );
  }
  return Effect.succeed(normalized);
}

function isoTimestamp(value: unknown, field: string) {
  if (typeof value !== "string") {
    return Effect.fail(
      schemaError(
        "invalid_metadata",
        `topic ${field} must be an ISO timestamp`,
      ),
    );
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    return Effect.fail(
      schemaError(
        "invalid_metadata",
        `topic ${field} must be a normalized ISO timestamp`,
      ),
    );
  }
  return Effect.succeed(value);
}

function validateMetadata(value: unknown) {
  return Effect.gen(function*() {
    if (!isRecord(value)) {
      return yield* schemaError(
        "invalid_metadata",
        "topic metadata must be a YAML object",
      );
    }
    const unknown = Object.keys(value).filter((key) => !metadataKeys.includes(key));
    if (unknown.length > 0) {
      return yield* schemaError(
        "invalid_metadata",
        `topic metadata has unknown fields: ${unknown.join(", ")}`,
      );
    }
    if (value.node_type !== "memory") {
      return yield* schemaError(
        "invalid_metadata",
        'topic node_type must be "memory"',
      );
    }
    if (!isTopicType(value.type)) {
      return yield* schemaError(
        "invalid_metadata",
        `topic type must be one of ${topicTypes.join(", ")}`,
      );
    }
    const scope = yield* boundedText(value.scope, "scope");
    const sourcePrincipal = yield* boundedText(
      value.source_principal,
      "source_principal",
    );
    const observedAt = yield* isoTimestamp(value.observed_at, "observed_at");
    const modified = yield* isoTimestamp(value.modified, "modified");
    if (typeof value.pinned !== "boolean") {
      return yield* schemaError(
        "invalid_metadata",
        "topic pinned must be a boolean",
      );
    }
    return {
      node_type: "memory",
      type: value.type,
      scope,
      source_principal: sourcePrincipal,
      observed_at: observedAt,
      modified,
      pinned: value.pinned,
    } satisfies TopicMetadata;
  });
}

export function parseTopicFile(
  content: string,
): Effect.Effect<ParsedTopic, TopicSchemaError> {
  return Effect.gen(function*() {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
    const frontmatter = match?.[1];
    const body = match?.[2];
    if (frontmatter === undefined || body === undefined) {
      return yield* schemaError(
        "invalid_frontmatter",
        "topic must start with YAML frontmatter",
      );
    }
    const raw = yield* Effect.try({
      try: () => parse(frontmatter),
      catch: (cause) =>
        schemaError("yaml_failed", "topic YAML frontmatter is invalid", cause),
    });
    const metadata = yield* validateMetadata(raw);
    return { metadata, body: body.replace(/\s+$/, "") };
  });
}

export function serializeTopicFile(
  topic: ParsedTopic,
): Effect.Effect<string, TopicSchemaError> {
  return Effect.gen(function*() {
    const validated = yield* validateTopic(topic);
    const frontmatter = yield* Effect.try({
      try: () => stringify(validated.metadata, {
        lineWidth: 0,
        sortMapEntries: false,
      }).trimEnd(),
      catch: (cause) =>
        schemaError("yaml_failed", "topic metadata could not be serialized", cause),
    });
    return `---\n${frontmatter}\n---\n${validated.body.trimEnd()}\n`;
  });
}

export function validateTopic(
  topic: ParsedTopic,
): Effect.Effect<ParsedTopic, TopicSchemaError> {
  return validateMetadata(topic.metadata).pipe(
    Effect.map((metadata) => ({ metadata, body: topic.body.trimEnd() })),
  );
}
