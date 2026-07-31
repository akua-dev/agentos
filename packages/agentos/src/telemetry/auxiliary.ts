import type { Model } from "@earendil-works/pi-ai";
import {
  initializeAgentOSTelemetryFromEnvironment,
  type AgentOSOperation,
  type AgentOSTelemetry,
} from "./runtime.ts";
import type {
  AgentOSAIModelFamily,
  AgentOSAIProviderFamily,
  AgentOSAIRoute,
  AgentOSAISessionState,
} from "./contract.ts";

export type AgentOSTelemetrySource =
  | AgentOSTelemetry
  | Promise<AgentOSTelemetry>;

export async function startAgentOSAuxiliaryOperation(
  model: Model<any>,
  telemetry: AgentOSTelemetrySource | undefined,
  sessionState: AgentOSAISessionState,
): Promise<AgentOSOperation> {
  const resolved = await (
    telemetry ?? initializeAgentOSTelemetryFromEnvironment()
  );
  return resolved.startOperation({
    runtime: "pi",
    runtimeVersion: "0.81.1",
    route: agentOSRouteForModel(model),
    sessionState,
    modelFamily: agentOSModelFamily(model.id),
    providerFamily: agentOSProviderFamily(model.provider),
  });
}

export function agentOSRouteForModel(
  model: Pick<Model<any>, "baseUrl">,
): AgentOSAIRoute {
  const baseUrl = model.baseUrl?.trim().toLowerCase() ?? "";
  if (!baseUrl) return "direct";
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname.includes("gateway") ? "ai_gateway" : "direct";
  } catch {
    return baseUrl.includes("gateway") ? "ai_gateway" : "direct";
  }
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
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

export function safeAssistantFailure(
  stopReason: string | undefined,
): { name: "AbortError" | "ProviderError" } | undefined {
  if (stopReason === "aborted") return { name: "AbortError" };
  if (stopReason === "error") return { name: "ProviderError" };
  return undefined;
}
