import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Effect,
  Option,
  Ref,
  Semaphore,
} from "effect";

import { runPromiseLegacy, runSyncLegacy } from "../shared/legacy.ts";
import {
  agentOSModelFamily,
  agentOSProviderFamily,
  agentOSRouteForModel,
  type AgentOSTelemetrySource,
} from "./auxiliary.ts";
import type {
  AgentOSAISessionState,
  AgentOSAIStreamOutcome,
} from "./contract.ts";
import {
  initializeAgentOSTelemetryFromEnvironment,
  type AgentOSOperation,
  type AgentOSProviderAttempt,
  type AgentOSTelemetry,
} from "./runtime.ts";

export interface AgentOSObservabilityDependencies {
  readonly telemetry?: AgentOSTelemetrySource;
  readonly runtimeVersion?: string;
}

interface ActiveAttempt {
  readonly attempt: AgentOSProviderAttempt;
  readonly providerRequestId?: string;
  readonly status?: number;
}

interface OperationResult {
  readonly error?: { readonly name: "AbortError" | "ProviderError" };
  readonly status?: number;
}

export const registerAgentOSObservabilityEffect = Effect.fn(
  "agentos.telemetry.registerPiExtension",
)(function*(
  pi: ExtensionAPI,
  dependencies: AgentOSObservabilityDependencies = {},
) {
  const telemetrySource = dependencies.telemetry ??
    initializeAgentOSTelemetryFromEnvironment();
  const telemetryEffect: Effect.Effect<AgentOSTelemetry> =
    Effect.isEffect(telemetrySource)
      ? telemetrySource
      : Effect.succeed(telemetrySource);
  const telemetry = yield* Effect.cached(telemetryEffect);
  const runtimeVersion = dependencies.runtimeVersion ?? "0.81.1";
  const operation = yield* Ref.make(Option.none<AgentOSOperation>());
  const activeAttempt = yield* Ref.make(Option.none<ActiveAttempt>());
  const operationResult = yield* Ref.make<OperationResult>({});
  const operationLock = yield* Semaphore.make(1);

  const finishAttempt = Effect.fn("agentos.telemetry.finishPiAttempt")(
    function*(
      message?: AssistantMessage,
      fallbackOutcome: AgentOSAIStreamOutcome = "upstream_error",
    ) {
      const current = Option.getOrUndefined(yield* Ref.get(activeAttempt));
      if (current === undefined) return;
      const error = message
        ? safeMessageError(message)
        : safeFallbackError(fallbackOutcome);
      const streamOutcome = message
        ? streamOutcomeForMessage(message)
        : fallbackOutcome;
      yield* current.attempt.end({
        status: current.status,
        error,
        streamOutcome,
        providerRequestId: current.providerRequestId,
        inputTokens: safeCount(message?.usage.input),
        outputTokens: safeCount(message?.usage.output),
      });
      yield* Ref.set(activeAttempt, Option.none());
      yield* Ref.set(operationResult, { status: current.status, error });
    },
  );

  const finishOperation = Effect.fn("agentos.telemetry.finishPiOperation")(
    function*() {
      yield* finishAttempt();
      const current = Option.getOrUndefined(yield* Ref.get(operation));
      if (current !== undefined) yield* current.end(yield* Ref.get(operationResult));
      yield* Ref.set(operation, Option.none());
      yield* Ref.set(operationResult, {});
    },
  );

  const ensureOperation = (context: ExtensionContext) =>
    operationLock.withPermit(Effect.gen(function*() {
      const current = Option.getOrUndefined(yield* Ref.get(operation));
      if (current !== undefined) return current;
      const model = context.model;
      const resolvedTelemetry = yield* telemetry;
      const started = yield* resolvedTelemetry.startOperation({
        runtime: "pi",
        runtimeVersion,
        route: model ? agentOSRouteForModel(model) : "direct",
        sessionState: yield* sessionState(context),
        modelFamily: agentOSModelFamily(model?.id),
        providerFamily: agentOSProviderFamily(model?.provider),
      });
      yield* Ref.set(operation, Option.some(started));
      yield* Ref.set(operationResult, {});
      return started;
    }));

  yield* Effect.sync(() => {
    pi.on("before_agent_start", (_event, context) =>
      runPromiseLegacy(Effect.gen(function*() {
        if (Option.isSome(yield* Ref.get(operation))) yield* finishOperation();
        yield* ensureOperation(context);
      }))
    );

    pi.on("before_provider_headers", (event, context) =>
      runPromiseLegacy(Effect.gen(function*() {
        if (Option.isSome(yield* Ref.get(activeAttempt))) yield* finishAttempt();
        const currentOperation = yield* ensureOperation(context);
        const attempt = yield* currentOperation.startProviderAttempt({
          requestKind: "main",
          streamMode: "streaming",
        });
        yield* Ref.set(activeAttempt, Option.some({ attempt }));
        const headers: Record<string, string> = {};
        yield* attempt.inject(headers);
        for (const [name, value] of Object.entries(headers)) {
          event.headers[name] = value;
        }
      }))
    );

    pi.on("after_provider_response", (event) =>
      runPromiseLegacy(Ref.update(activeAttempt, (current) =>
        Option.map(current, ({ attempt }) => ({
          attempt,
          status: event.status,
          providerRequestId: providerRequestId(event.headers),
        }))
      ))
    );

    pi.on("message_end", (event) =>
      event.message.role === "assistant"
        ? runPromiseLegacy(finishAttempt(event.message))
        : undefined
    );

    pi.on("agent_settled", () => runPromiseLegacy(finishOperation()));
    pi.on("session_shutdown", () => runPromiseLegacy(finishOperation()));
  });
});

export function registerAgentOSObservability(
  pi: ExtensionAPI,
  dependencies: AgentOSObservabilityDependencies = {},
) {
  return runSyncLegacy(registerAgentOSObservabilityEffect(pi, dependencies));
}

function sessionState(context: ExtensionContext) {
  return Effect.try({
    try: () => context.sessionManager.getEntries().length,
    catch: () => undefined,
  }).pipe(
    Effect.match({
      onFailure: (): AgentOSAISessionState => "fresh",
      onSuccess: (entries): AgentOSAISessionState =>
        entries > 0 ? "resumed" : "fresh",
    }),
  );
}

function providerRequestId(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  for (const name of ["x-request-id", "x-oai-request-id"]) {
    const value = normalized.get(name)?.trim();
    if (value && value.length <= 128 && /^[0-9A-Za-z_.:-]+$/.test(value)) {
      return value;
    }
  }
  return undefined;
}

function safeMessageError(message: AssistantMessage): OperationResult["error"] {
  if (message.stopReason === "aborted") return { name: "AbortError" };
  if (message.stopReason === "error") return { name: "ProviderError" };
  return undefined;
}

function streamOutcomeForMessage(message: AssistantMessage): AgentOSAIStreamOutcome {
  if (message.stopReason === "aborted") return "aborted";
  if (message.stopReason === "error") return "upstream_error";
  return "completed";
}

function safeFallbackError(outcome: AgentOSAIStreamOutcome): OperationResult["error"] {
  if (outcome === "aborted") return { name: "AbortError" };
  if (outcome === "upstream_error") return { name: "ProviderError" };
  return undefined;
}

function safeCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export default registerAgentOSObservability;
