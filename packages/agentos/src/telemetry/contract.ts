const values = <const Values extends ReadonlyArray<string | number>>(
  ...entries: Values
) => entries;

const constant = <const Value extends Readonly<Record<string, string>>>(
  value: Value,
) => Object.freeze(value);

export const AGENTOS_AI_TELEMETRY_CONTRACT_VERSION = 1;

export const AGENTOS_AI_RUNTIMES = values("pi", "codex");
export type AgentOSAIRuntime = (typeof AGENTOS_AI_RUNTIMES)[number];

export const AGENTOS_AI_ROUTES = values("direct", "ai_gateway");
export type AgentOSAIRoute = (typeof AGENTOS_AI_ROUTES)[number];

export const AGENTOS_AI_REQUEST_KINDS = values(
  "main",
  "compaction",
  "memory_extract",
  "memory_consolidate",
  "extension",
);
export type AgentOSAIRequestKind = (typeof AGENTOS_AI_REQUEST_KINDS)[number];

export const AGENTOS_AI_COMPACTION_PATHS = values(
  "portable_summary",
  "native_server",
);
export type AgentOSAICompactionPath = (typeof AGENTOS_AI_COMPACTION_PATHS)[number];

export const AGENTOS_AI_STATUS_CLASSES = values(
  "success",
  "client_error",
  "server_error",
  "cancelled",
  "error",
);
export type AgentOSAIStatusClass = (typeof AGENTOS_AI_STATUS_CLASSES)[number];

export const AGENTOS_AI_ERROR_CLASSES = values(
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
);
export type AgentOSAIErrorClass = (typeof AGENTOS_AI_ERROR_CLASSES)[number];

export const AGENTOS_AI_STREAM_OUTCOMES = values(
  "not_streamed",
  "completed",
  "client_disconnect",
  "aborted",
  "upstream_error",
);
export type AgentOSAIStreamOutcome = (typeof AGENTOS_AI_STREAM_OUTCOMES)[number];

export const AGENTOS_AI_MODEL_FAMILIES = values(
  "gpt-5",
  "gpt-4.1",
  "o-series",
  "other",
);
export type AgentOSAIModelFamily = (typeof AGENTOS_AI_MODEL_FAMILIES)[number];

export const AGENTOS_AI_PROVIDER_FAMILIES = values("openai", "other");
export type AgentOSAIProviderFamily = (typeof AGENTOS_AI_PROVIDER_FAMILIES)[number];

export const AGENTOS_AI_SESSION_STATES = values("fresh", "resumed");
export type AgentOSAISessionState = (typeof AGENTOS_AI_SESSION_STATES)[number];

export const AGENTOS_AI_STREAM_MODES = values("streaming", "non_streaming");
export type AgentOSAIStreamMode = (typeof AGENTOS_AI_STREAM_MODES)[number];

export const AGENTOS_AI_METRICS = constant({
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
});

export const AGENTOS_AI_DURATION_BUCKETS_SECONDS = Object.freeze(values(
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
));

export const AGENTOS_AI_MAX_QUOTA_OBSERVATION_AGE_SECONDS = 86_400;
