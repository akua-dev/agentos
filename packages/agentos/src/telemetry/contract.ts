export const AGENTOS_AI_TELEMETRY_CONTRACT_VERSION = 1 as const;

export const AGENTOS_AI_RUNTIMES = ["pi", "codex"] as const;
export type AgentOSAIRuntime = (typeof AGENTOS_AI_RUNTIMES)[number];

export const AGENTOS_AI_ROUTES = ["direct", "ai_gateway"] as const;
export type AgentOSAIRoute = (typeof AGENTOS_AI_ROUTES)[number];

export const AGENTOS_AI_REQUEST_KINDS = [
  "main",
  "compaction",
  "memory_extract",
  "memory_consolidate",
  "extension",
] as const;
export type AgentOSAIRequestKind =
  (typeof AGENTOS_AI_REQUEST_KINDS)[number];

export const AGENTOS_AI_COMPACTION_PATHS = [
  "portable_summary",
  "native_server",
] as const;
export type AgentOSAICompactionPath =
  (typeof AGENTOS_AI_COMPACTION_PATHS)[number];

export const AGENTOS_AI_STATUS_CLASSES = [
  "success",
  "client_error",
  "server_error",
  "cancelled",
  "error",
] as const;
export type AgentOSAIStatusClass =
  (typeof AGENTOS_AI_STATUS_CLASSES)[number];

export const AGENTOS_AI_ERROR_CLASSES = [
  "none",
  "authentication",
  "rate_limit",
  "overload",
  "timeout",
  "abort",
  "transport",
  "protocol",
  "decode",
  "unavailable",
  "unknown",
] as const;
export type AgentOSAIErrorClass =
  (typeof AGENTOS_AI_ERROR_CLASSES)[number];

export const AGENTOS_AI_STREAM_OUTCOMES = [
  "not_streamed",
  "completed",
  "client_disconnect",
  "aborted",
  "upstream_error",
] as const;
export type AgentOSAIStreamOutcome =
  (typeof AGENTOS_AI_STREAM_OUTCOMES)[number];

export const AGENTOS_AI_MODEL_FAMILIES = [
  "gpt-5",
  "gpt-4.1",
  "o-series",
  "other",
] as const;
export type AgentOSAIModelFamily =
  (typeof AGENTOS_AI_MODEL_FAMILIES)[number];

export const AGENTOS_AI_PROVIDER_FAMILIES = ["openai", "other"] as const;
export type AgentOSAIProviderFamily =
  (typeof AGENTOS_AI_PROVIDER_FAMILIES)[number];

export const AGENTOS_AI_SESSION_STATES = ["fresh", "resumed"] as const;
export type AgentOSAISessionState =
  (typeof AGENTOS_AI_SESSION_STATES)[number];

export const AGENTOS_AI_STREAM_MODES = ["streaming", "non_streaming"] as const;
export type AgentOSAIStreamMode =
  (typeof AGENTOS_AI_STREAM_MODES)[number];

export const AGENTOS_AI_METRICS = Object.freeze({
  operations: "agentos.ai.operations",
  providerAttempts: "agentos.ai.provider.attempts",
  operationDuration: "agentos.ai.operation.duration",
  providerDuration: "agentos.ai.provider.duration",
  upstreamHeadersDuration: "agentos.ai.upstream.headers.duration",
  firstByteDuration: "agentos.ai.stream.first_byte.duration",
  streamDuration: "agentos.ai.stream.duration",
  activeStreams: "agentos.ai.streams.active",
  streamChunks: "agentos.ai.stream.chunks",
  streamBytes: "agentos.ai.stream.bytes",
  routeAcquisitionDuration: "agentos.ai.route.acquire.duration",
  quotaObservationAge: "agentos.ai.quota.observation.age",
} as const);

export const AGENTOS_AI_DURATION_BUCKETS_SECONDS = Object.freeze([
  0.005,
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
  10,
  30,
  60,
  120,
  300,
] as const);

export const AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS = 86_400 as const;
