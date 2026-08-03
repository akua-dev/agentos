import type { Api, Model } from "@earendil-works/pi-ai";
import { Effect, Option, Schema } from "effect";

import type {
  AgentOSAIModelFamily,
  AgentOSAIProviderFamily,
  AgentOSAIRoute,
  AgentOSAISessionState,
} from "./contract.ts";
import {
  initializeAgentOSTelemetryFromEnvironment,
  type AgentOSOperation,
  type AgentOSTelemetry,
} from "./runtime.ts";
import type { AgentOSTelemetryRuntime } from "./runtime-context.ts";

export type AgentOSTelemetrySource =
  | AgentOSTelemetry
  | Effect.Effect<AgentOSTelemetry>;

export const startAgentOSAuxiliaryOperation = Effect.fn(
  "agentos.telemetry.startAuxiliaryOperation",
)(function*(
  model: Model<Api>,
  telemetry: AgentOSTelemetrySource | undefined,
  sessionState: AgentOSAISessionState,
  runtime?: AgentOSTelemetryRuntime,
): Effect.fn.Return<AgentOSOperation, never> {
  const source = telemetry ?? runtime?.telemetry;
  const resolved = source === undefined
    ? yield* initializeAgentOSTelemetryFromEnvironment()
    : Effect.isEffect(source)
    ? yield* source
    : source;
  const parentCarrier = runtime === undefined
    ? undefined
    : yield* runtime.parentCarrier;
  return yield* resolved.startOperation({
    runtime: "pi",
    runtimeVersion: "0.81.1",
    route: agentOSRouteForModel(model),
    sessionState,
    modelFamily: agentOSModelFamily(model.id),
    providerFamily: agentOSProviderFamily(model.provider),
  }, parentCarrier);
});

export function agentOSRouteForModel(
  model: Pick<Model<Api>, "baseUrl">,
): AgentOSAIRoute {
  const baseUrl = model.baseUrl?.trim().toLowerCase() ?? "";
  if (!baseUrl) return "direct";
  const url = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.URLFromString)(baseUrl),
  );
  return (url?.hostname ?? baseUrl).includes("gateway")
    ? "ai_gateway"
    : "direct";
}

export function agentOSModelFamily(
  modelId: string | undefined,
): AgentOSAIModelFamily {
  const normalized = modelId?.toLowerCase() ?? "";
  if (normalized.startsWith("gpt-5")) return "gpt-5";
  if (normalized.startsWith("gpt-4.1")) return "gpt-4.1";
  if (/^o[0-9]/.test(normalized)) return "o-series";
  return "other";
}

export function agentOSProviderFamily(
  provider: string | undefined,
): AgentOSAIProviderFamily {
  const normalized = provider?.toLowerCase() ?? "";
  return normalized.includes("openai") || normalized.includes("codex")
    ? "openai"
    : "other";
}

export function safeTokenCount(
  value: number | undefined,
): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function safeAssistantFailure(
  stopReason: string | undefined,
): { readonly name: "AbortError" | "ProviderError" } | undefined {
  if (stopReason === "aborted") return { name: "AbortError" };
  if (stopReason === "error") return { name: "ProviderError" };
  return undefined;
}
