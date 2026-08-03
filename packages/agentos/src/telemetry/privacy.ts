import { Option } from "effect";

import {
  AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS,
  AGENTOS_TELEMETRY_EVENT_DEFINITIONS,
  AGENTOS_TELEMETRY_METRIC_DEFINITIONS,
  AgentOSTelemetryAttributeDefinitionV1Schema,
  type AgentOSAIErrorClass,
  type AgentOSAIStatusClass,
  type AgentOSTelemetryContractSignal,
} from "./contract.ts";

export type AgentOSTelemetrySignal = AgentOSTelemetryContractSignal;
export type AgentOSTelemetryAttributeValue = string | number | boolean;
export type AgentOSTelemetryAttributes = Record<
  string,
  AgentOSTelemetryAttributeValue
>;

type ValueRule =
  (typeof AgentOSTelemetryAttributeDefinitionV1Schema.Type)["value"];
type OpaqueFormat = Extract<
  ValueRule,
  { readonly kind: "opaque" }
>["format"];

export function safeTelemetryAttributes(
  input: Readonly<Record<string, unknown>>,
  signal: AgentOSTelemetrySignal,
): AgentOSTelemetryAttributes {
  const safe: AgentOSTelemetryAttributes = {};
  for (const key of Object.keys(input).sort()) {
    const definition = AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS[key];
    if (!definition?.signals.includes(signal)) continue;
    const value = safeValue(input[key], definition.value);
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

export function safeMetricAttributes(
  metricName: string,
  input: Readonly<Record<string, unknown>>,
): AgentOSTelemetryAttributes {
  const metric = AGENTOS_TELEMETRY_METRIC_DEFINITIONS[metricName];
  if (metric === undefined) return {};
  const safe: AgentOSTelemetryAttributes = {};
  for (const key of [...metric.labels].sort()) {
    const definition = AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS[key];
    if (!definition?.signals.includes("metric")) continue;
    const value = safeValue(input[key], definition.value);
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

export function safeEventAttributes(
  eventName: string,
  input: Readonly<Record<string, unknown>>,
): AgentOSTelemetryAttributes {
  const event = AGENTOS_TELEMETRY_EVENT_DEFINITIONS[eventName];
  if (event === undefined) return {};
  const safe: AgentOSTelemetryAttributes = {};
  for (const key of [...event.attributes].sort()) {
    const definition = AGENTOS_TELEMETRY_ATTRIBUTE_DEFINITIONS[key];
    if (!definition?.signals.includes(event.signal)) continue;
    const value = safeValue(input[key], definition.value);
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
          (rule.minimum === null || input >= rule.minimum) &&
          (rule.maximum === null || input <= rule.maximum)
        ? input
        : undefined;
    case "boolean":
      return typeof input === "boolean" ? input : undefined;
    case "opaque":
      return typeof input === "string" &&
          input.length <= rule.maximumLength &&
          opaquePattern(rule.format).test(input)
        ? input
        : undefined;
  }
}

function opaquePattern(format: OpaqueFormat): RegExp {
  switch (format) {
    case "decision_ref":
      return /^decision_[0-9a-f]{32}$/;
    case "digest":
      return /^[0-9a-f]{64}$/;
    case "identifier":
      return /^[0-9A-Za-z_.:@/-]+$/;
    case "profile_id":
      return /^[a-z][a-z0-9-]{0,62}$/;
    case "provider_request":
      return /^[0-9A-Za-z_.:-]+$/;
    case "resource_name":
      return /^[0-9A-Za-z][0-9A-Za-z._:/@+-]*$/;
    case "route_slot":
      return /^slot-[0-9A-Za-z_-]+$/;
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    case "version":
      return /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
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
  const value = Option.getOrUndefined(
    Option.liftThrowable((target: object, name: string) =>
      Reflect.get(target, name)
    )(error, field),
  );
  return typeof value === "string" && value.length <= 64 ? value : "";
}
