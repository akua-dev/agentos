import type {
  AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  initializeAgentOSTelemetryFromEnvironment,
  type AgentOSOperation,
  type AgentOSProviderAttempt,
  type AgentOSTelemetry,
} from "./runtime.ts";
import type {
  AgentOSAISessionState,
  AgentOSAIStreamOutcome,
} from "./contract.ts";
import {
  agentOSModelFamily,
  agentOSProviderFamily,
  agentOSRouteForModel,
} from "./auxiliary.ts";

export interface AgentOSObservabilityDependencies {
  telemetry?: AgentOSTelemetry | Promise<AgentOSTelemetry>;
  runtimeVersion?: string;
}

interface ActiveAttempt {
  attempt: AgentOSProviderAttempt;
  providerRequestId?: string;
  status?: number;
}

interface OperationResult {
  error?: { name: "AbortError" | "ProviderError" };
  status?: number;
}

export function registerAgentOSObservability(
  pi: ExtensionAPI,
  dependencies: AgentOSObservabilityDependencies = {},
) {
  const telemetry = Promise.resolve(
    dependencies.telemetry ??
      initializeAgentOSTelemetryFromEnvironment(),
  );
  const runtimeVersion = dependencies.runtimeVersion ?? "0.81.1";
  let operation: AgentOSOperation | undefined;
  let activeAttempt: ActiveAttempt | undefined;
  let operationResult: OperationResult = {};

  const ensureOperation = async (
    context: ExtensionContext,
  ): Promise<AgentOSOperation> => {
    if (operation) return operation;
    const model = context.model;
    operation = (await telemetry).startOperation({
      runtime: "pi",
      runtimeVersion,
      route: model ? agentOSRouteForModel(model) : "direct",
      sessionState: sessionState(context),
      modelFamily: agentOSModelFamily(model?.id),
      providerFamily: agentOSProviderFamily(model?.provider),
    });
    operationResult = {};
    return operation;
  };

  const finishAttempt = (
    message?: AssistantMessage,
    fallbackOutcome: AgentOSAIStreamOutcome = "upstream_error",
  ) => {
    if (!activeAttempt) return;
    const error = message ? safeMessageError(message) : undefined;
    const streamOutcome = message
      ? streamOutcomeForMessage(message)
      : fallbackOutcome;
    const status = activeAttempt.status;
    activeAttempt.attempt.end({
      status,
      error,
      streamOutcome,
      providerRequestId: activeAttempt.providerRequestId,
      inputTokens: safeCount(message?.usage.input),
      outputTokens: safeCount(message?.usage.output),
      chunks: undefined,
      bytes: undefined,
    });
    activeAttempt = undefined;
    operationResult = { status, error };
  };

  const finishOperation = () => {
    finishAttempt(undefined);
    operation?.end(operationResult);
    operation = undefined;
    operationResult = {};
  };

  pi.on("before_agent_start", async (_event, context) => {
    if (operation) finishOperation();
    await ensureOperation(context);
  });

  pi.on("before_provider_headers", async (event, context) => {
    if (activeAttempt) finishAttempt(undefined);
    const currentOperation = await ensureOperation(context);
    const attempt = currentOperation.startProviderAttempt({
      requestKind: "main",
      streamMode: "streaming",
    });
    activeAttempt = { attempt };
    const headers: Record<string, string> = {};
    attempt.inject(headers);
    for (const [name, value] of Object.entries(headers)) {
      event.headers[name] = value;
    }
  });

  pi.on("after_provider_response", (event) => {
    if (!activeAttempt) return;
    activeAttempt.status = event.status;
    activeAttempt.providerRequestId = providerRequestId(event.headers);
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    finishAttempt(event.message);
  });

  pi.on("agent_settled", () => {
    finishOperation();
  });

  pi.on("session_shutdown", () => {
    finishOperation();
  });
}

function sessionState(context: ExtensionContext): AgentOSAISessionState {
  try {
    return context.sessionManager.getEntries().length > 0
      ? "resumed"
      : "fresh";
  } catch {
    return "fresh";
  }
}

function providerRequestId(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  for (const name of ["x-request-id", "x-oai-request-id"]) {
    const value = normalized.get(name)?.trim();
    if (
      value &&
      value.length <= 128 &&
      /^[0-9A-Za-z_.:-]+$/.test(value)
    ) {
      return value;
    }
  }
  return undefined;
}

function safeMessageError(
  message: AssistantMessage,
): OperationResult["error"] {
  if (message.stopReason === "aborted") return { name: "AbortError" };
  if (message.stopReason === "error") return { name: "ProviderError" };
  return undefined;
}

function streamOutcomeForMessage(
  message: AssistantMessage,
): AgentOSAIStreamOutcome {
  if (message.stopReason === "aborted") return "aborted";
  if (message.stopReason === "error") return "upstream_error";
  return "completed";
}

function safeCount(value: number | undefined): number | undefined {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

export default registerAgentOSObservability;
