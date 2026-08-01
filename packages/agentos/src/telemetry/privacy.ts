import {
  AGENTOS_AI_COMPACTION_PATHS,
  AGENTOS_AI_ERROR_CLASSES,
  AGENTOS_AI_MODEL_FAMILIES,
  AGENTOS_AI_PROVIDER_FAMILIES,
  AGENTOS_AI_REQUEST_KINDS,
  AGENTOS_AI_ROUTES,
  AGENTOS_AI_RUNTIMES,
  AGENTOS_AI_SESSION_STATES,
  AGENTOS_AI_STATUS_CLASSES,
  AGENTOS_AI_STREAM_MODES,
  AGENTOS_AI_STREAM_OUTCOMES,
  type AgentOSAIErrorClass,
  type AgentOSAIStatusClass,
} from "./contract.ts";

export type AgentOSTelemetrySignal = "span" | "metric" | "log";
export type AgentOSTelemetryAttributeValue = string | number | boolean;
export type AgentOSTelemetryAttributes = Record<
  string,
  AgentOSTelemetryAttributeValue
>;

type ValueRule =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "number"; minimum?: number; maximum?: number }
  | { kind: "boolean" }
  | { kind: "opaque"; pattern: RegExp; maximumLength: number };

interface AttributeRule {
  signals: readonly AgentOSTelemetrySignal[];
  value: ValueRule;
}

const allSignals = ["span", "metric", "log"] as const;
const correlatedSignals = ["span", "log"] as const;

const rules: Readonly<Record<string, AttributeRule>> = Object.freeze({
  "agentos.telemetry.contract.version": {
    signals: allSignals,
    value: { kind: "number", minimum: 1, maximum: 1 },
  },
  "agentos.ai.runtime": {
    signals: allSignals,
    value: { kind: "enum", values: AGENTOS_AI_RUNTIMES },
  },
  "agentos.ai.runtime.version": {
    signals: allSignals,
    value: {
      kind: "opaque",
      pattern: /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/,
      maximumLength: 32,
    },
  },
  "agentos.ai.route": {
    signals: allSignals,
    value: { kind: "enum", values: AGENTOS_AI_ROUTES },
  },
  "agentos.ai.provider.family": {
    signals: allSignals,
    value: { kind: "enum", values: AGENTOS_AI_PROVIDER_FAMILIES },
  },
  "agentos.ai.request.kind": {
    signals: allSignals,
    value: { kind: "enum", values: AGENTOS_AI_REQUEST_KINDS },
  },
  "agentos.ai.compaction.path": {
    signals: allSignals,
    value: { kind: "enum", values: AGENTOS_AI_COMPACTION_PATHS },
  },
  "agentos.ai.status_class": {
    signals: allSignals,
    value: { kind: "enum", values: AGENTOS_AI_STATUS_CLASSES },
  },
  "agentos.ai.error.class": {
    signals: allSignals,
    value: { kind: "enum", values: AGENTOS_AI_ERROR_CLASSES },
  },
  "agentos.ai.stream.mode": {
    signals: allSignals,
    value: { kind: "enum", values: AGENTOS_AI_STREAM_MODES },
  },
  "agentos.ai.stream.outcome": {
    signals: allSignals,
    value: { kind: "enum", values: AGENTOS_AI_STREAM_OUTCOMES },
  },
  "agentos.ai.session.state": {
    signals: allSignals,
    value: { kind: "enum", values: AGENTOS_AI_SESSION_STATES },
  },
  "agentos.ai.model.family": {
    signals: allSignals,
    value: { kind: "enum", values: AGENTOS_AI_MODEL_FAMILIES },
  },
  "agentos.ai.route.slot": {
    signals: correlatedSignals,
    value: {
      kind: "opaque",
      pattern: /^slot-[0-9A-Za-z_-]+$/,
      maximumLength: 32,
    },
  },
  "agentos.ai.operation.id": {
    signals: correlatedSignals,
    value: {
      kind: "opaque",
      pattern: /^[0-9A-Za-z_-]+$/,
      maximumLength: 128,
    },
  },
  "agentos.ai.request.attempt_id": {
    signals: correlatedSignals,
    value: {
      kind: "opaque",
      pattern: /^[0-9A-Za-z_-]+$/,
      maximumLength: 128,
    },
  },
  "agentos.ai.provider.request_id": {
    signals: correlatedSignals,
    value: {
      kind: "opaque",
      pattern: /^[0-9A-Za-z_.:-]+$/,
      maximumLength: 128,
    },
  },
  "http.response.status_code": {
    signals: correlatedSignals,
    value: { kind: "number", minimum: 100, maximum: 599 },
  },
  "agentos.ai.retry.count": {
    signals: allSignals,
    value: { kind: "number", minimum: 0, maximum: 32 },
  },
  "agentos.ai.stream.chunks": {
    signals: correlatedSignals,
    value: { kind: "number", minimum: 0 },
  },
  "agentos.ai.stream.bytes": {
    signals: correlatedSignals,
    value: { kind: "number", minimum: 0 },
  },
  "agentos.ai.usage.input_tokens": {
    signals: correlatedSignals,
    value: { kind: "number", minimum: 0 },
  },
  "agentos.ai.usage.output_tokens": {
    signals: correlatedSignals,
    value: { kind: "number", minimum: 0 },
  },
  "agentos.ai.quota.stale": {
    signals: allSignals,
    value: { kind: "boolean" },
  },
  "agentos.identity.agent_id": {
    signals: correlatedSignals,
    value: {
      kind: "opaque",
      pattern:
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      maximumLength: 36,
    },
  },
  "agentos.identity.assignment_id": {
    signals: correlatedSignals,
    value: {
      kind: "opaque",
      pattern:
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      maximumLength: 36,
    },
  },
  "agentos.authz.decision_ref": {
    signals: correlatedSignals,
    value: {
      kind: "opaque",
      pattern: /^decision_[0-9a-f]{32}$/,
      maximumLength: 41,
    },
  },
  "agentos.authz.profile_id": {
    signals: correlatedSignals,
    value: {
      kind: "opaque",
      pattern: /^[a-z][a-z0-9-]{0,62}$/,
      maximumLength: 63,
    },
  },
  "agentos.authz.profile_version": {
    signals: correlatedSignals,
    value: { kind: "number", minimum: 1 },
  },
  "agentos.authz.rate_class": {
    signals: correlatedSignals,
    value: { kind: "enum", values: ["low", "standard", "high"] },
  },
});

export function safeTelemetryAttributes(
  input: Readonly<Record<string, unknown>>,
  signal: AgentOSTelemetrySignal,
): AgentOSTelemetryAttributes {
  const safe: AgentOSTelemetryAttributes = {};
  for (const key of Object.keys(input).sort()) {
    const rule = rules[key];
    if (!rule?.signals.includes(signal)) continue;
    const value = safeValue(input[key], rule.value);
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

export function classifyAIStatus(
  status: number | undefined,
  error?: unknown,
): AgentOSAIStatusClass {
  if (isAbort(error)) return "cancelled";
  if (status !== undefined) {
    if (status >= 400 && status < 500) return "client_error";
    if (status >= 500 && status < 600) return "server_error";
    if (status >= 200 && status < 400) {
      return error === undefined ? "success" : "error";
    }
  }
  return error === undefined ? "success" : "error";
}

export function classifyAIError(
  error?: unknown,
  status?: number,
): AgentOSAIErrorClass {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  if (status === 502 || status === 503 || status === 529) return "overload";
  if (status !== undefined && status >= 500) return "unavailable";
  if (error === undefined || error === null) return "none";

  const name = safeErrorField(error, "name");
  const code = safeErrorField(error, "code");
  if (name === "AbortError" || code === "ABORT_ERR") return "abort";
  if (
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return "timeout";
  }
  if (
    code === "Z_DATA_ERROR" ||
    code === "Z_BUF_ERROR" ||
    code === "ERR_ENCODING_INVALID_ENCODED_DATA"
  ) {
    return "decode";
  }
  if (
    code.startsWith("HPE_") ||
    code === "ERR_INVALID_CHAR" ||
    code === "UND_ERR_RES_CONTENT_LENGTH_MISMATCH"
  ) {
    return "protocol";
  }
  if (
    name === "TypeError" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH" ||
    code === "UND_ERR_SOCKET"
  ) {
    return "transport";
  }
  return "unknown";
}

function safeValue(
  input: unknown,
  rule: ValueRule,
): AgentOSTelemetryAttributeValue | undefined {
  switch (rule.kind) {
    case "enum":
      return typeof input === "string" && rule.values.includes(input)
        ? input
        : undefined;
    case "number":
      return typeof input === "number" &&
        Number.isFinite(input) &&
        (rule.minimum === undefined || input >= rule.minimum) &&
        (rule.maximum === undefined || input <= rule.maximum)
        ? input
        : undefined;
    case "boolean":
      return typeof input === "boolean" ? input : undefined;
    case "opaque":
      return typeof input === "string" &&
        input.length <= rule.maximumLength &&
        rule.pattern.test(input)
        ? input
        : undefined;
  }
}

function isAbort(error: unknown): boolean {
  return (
    safeErrorField(error, "name") === "AbortError" ||
    safeErrorField(error, "code") === "ABORT_ERR"
  );
}

function safeErrorField(
  error: unknown,
  field: "name" | "code",
): string {
  if (typeof error !== "object" || error === null) return "";
  try {
    const value = Reflect.get(error, field);
    return typeof value === "string" && value.length <= 64 ? value : "";
  } catch {
    return "";
  }
}
