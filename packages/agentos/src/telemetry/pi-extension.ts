import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Duration,
  Effect,
  Option,
  Ref,
  Semaphore,
} from "effect";

import { runAgentOSPiProgram } from "../pi-host-adapter.ts";
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

const TELEMETRY_INITIALIZATION_BUDGET = Duration.millis(250);
const TELEMETRY_HOOK_BUDGET = Duration.millis(10);

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
  readonly error?: {
    readonly name: "AbortError" | "ProviderError" | "TimeoutError";
  };
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
  const telemetry = yield* failOpenTelemetry(
    telemetryEffect,
    inertTelemetry,
    TELEMETRY_INITIALIZATION_BUDGET,
  );
  const runtimeVersion = dependencies.runtimeVersion ?? "0.81.1";
  const operation = yield* Ref.make(Option.none<AgentOSOperation>());
  const activeAttempt = yield* Ref.make(Option.none<ActiveAttempt>());
  const operationResult = yield* Ref.make<OperationResult>({});
  const retryCount = yield* Ref.make(0);
  const stateLock = yield* Semaphore.make(1);

  const finishAttemptUnlocked = Effect.fn("agentos.telemetry.finishPiAttempt")(
    function*(
      message?: AssistantMessage,
      fallbackOutcome: AgentOSAIStreamOutcome = "upstream_error",
    ) {
      const current = Option.getOrUndefined(yield* Ref.get(activeAttempt));
      if (current === undefined) return;
      yield* Ref.set(activeAttempt, Option.none());
      const error = message
        ? safeMessageError(message)
        : safeFallbackError(fallbackOutcome);
      const streamOutcome = message
        ? streamOutcomeForMessage(message)
        : fallbackOutcome;
      yield* failOpenTelemetry(
        current.attempt.end({
          status: current.status,
          error,
          streamOutcome,
          providerRequestId: current.providerRequestId,
          inputTokens: safeCount(message?.usage.input),
          outputTokens: safeCount(message?.usage.output),
        }),
        undefined,
      );
      yield* Ref.set(operationResult, { status: current.status, error });
    },
  );

  const finishOperationUnlocked = Effect.fn("agentos.telemetry.finishPiOperation")(
    function*() {
      yield* finishAttemptUnlocked();
      const current = Option.getOrUndefined(yield* Ref.get(operation));
      yield* Ref.set(operation, Option.none());
      if (current !== undefined) {
        yield* failOpenTelemetry(
          current.end(yield* Ref.get(operationResult)),
          undefined,
        );
      }
      yield* Ref.set(operationResult, {});
      yield* Ref.set(retryCount, 0);
    },
  );

  const ensureOperationUnlocked = (context: ExtensionContext) =>
    Effect.gen(function*() {
      const current = Option.getOrUndefined(yield* Ref.get(operation));
      if (current !== undefined) return current;
      const model = context.model;
      const started = yield* failOpenTelemetry(
        telemetry.startOperation({
          runtime: "pi",
          runtimeVersion,
          route: model ? agentOSRouteForModel(model) : "direct",
          sessionState: yield* sessionState(context),
          modelFamily: agentOSModelFamily(model?.id),
          providerFamily: agentOSProviderFamily(model?.provider),
        }),
        inertOperation,
      );
      yield* Ref.set(operation, Option.some(started));
      yield* Ref.set(operationResult, {});
      yield* Ref.set(retryCount, 0);
      return started;
    });

  yield* Effect.sync(() => {
    pi.on("before_agent_start", (_event, context) =>
      runAgentOSPiProgram(stateLock.withPermit(Effect.gen(function*() {
        if (Option.isSome(yield* Ref.get(operation))) {
          yield* finishOperationUnlocked();
        }
        yield* ensureOperationUnlocked(context);
      })))
    );

    pi.on("before_provider_headers", (event, context) =>
      runAgentOSPiProgram(stateLock.withPermit(Effect.gen(function*() {
        if (Option.isSome(yield* Ref.get(activeAttempt))) {
          yield* finishAttemptUnlocked();
        }
        const currentOperation = yield* ensureOperationUnlocked(context);
        const currentRetryCount = yield* Ref.getAndUpdate(
          retryCount,
          (count) => count + 1,
        );
        const attempt = yield* failOpenTelemetry(
          currentOperation.startProviderAttempt({
            requestKind: "main",
            streamMode: "streaming",
            retryCount: currentRetryCount,
          }),
          inertAttempt,
        );
        yield* Ref.set(activeAttempt, Option.some({ attempt }));
        const headers: Record<string, string> = {};
        yield* failOpenTelemetry(attempt.inject(headers), undefined);
        for (const [name, value] of Object.entries(headers)) {
          event.headers[name] = value;
        }
      })))
    );

    pi.on("after_provider_response", (event) =>
      runAgentOSPiProgram(stateLock.withPermit(Ref.update(activeAttempt, (current) =>
        Option.map(current, ({ attempt }) => ({
          attempt,
          status: event.status,
          providerRequestId: providerRequestId(event.headers),
        }))
      )))
    );

    pi.on("message_end", (event) =>
      event.message.role === "assistant"
        ? runAgentOSPiProgram(
          stateLock.withPermit(finishAttemptUnlocked(event.message)),
        )
        : undefined
    );

    pi.on("agent_settled", () =>
      runAgentOSPiProgram(stateLock.withPermit(finishOperationUnlocked()))
    );
    pi.on("session_shutdown", () =>
      runAgentOSPiProgram(stateLock.withPermit(finishOperationUnlocked()))
    );
  });
});

export function registerAgentOSObservability(
  pi: ExtensionAPI,
  dependencies: AgentOSObservabilityDependencies = {},
) {
  return runAgentOSPiProgram(
    registerAgentOSObservabilityEffect(pi, dependencies),
  );
}

function sessionState(context: ExtensionContext) {
  return Effect.try({
    try: () => context.sessionManager.getEntries().some((entry) =>
      retainedConversationEntryTypes.has(entry.type)
    ),
    catch: () => undefined,
  }).pipe(
    Effect.match({
      onFailure: (): AgentOSAISessionState => "fresh",
      onSuccess: (hasRetainedConversation): AgentOSAISessionState =>
        hasRetainedConversation ? "resumed" : "fresh",
    }),
  );
}

const retainedConversationEntryTypes = new Set([
  "message",
  "compaction",
  "branch_summary",
  "custom_message",
]);

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
  if (message.stopReason === "error") {
    return isRecognizedTimeout(message.errorMessage)
      ? { name: "TimeoutError" }
      : { name: "ProviderError" };
  }
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

function isRecognizedTimeout(message: string | undefined): boolean {
  return message !== undefined &&
    /(?:\btimeout\b|\btimed out\b|\bdeadline exceeded\b)/i.test(message);
}

function failOpenTelemetry<A>(
  program: Effect.Effect<A, unknown>,
  fallback: A,
  budget = TELEMETRY_HOOK_BUDGET,
) {
  return program.pipe(
    Effect.timeoutOption(budget),
    Effect.map(Option.getOrElse(() => fallback)),
    Effect.catchCause(() => Effect.succeed(fallback)),
  );
}

const inertAttempt: AgentOSProviderAttempt = Object.freeze({
  id: "",
  inject: () => Effect.void,
  end: () => Effect.void,
});

const inertOperation: AgentOSOperation = Object.freeze({
  id: "",
  startProviderAttempt: () => Effect.succeed(inertAttempt),
  end: () => Effect.void,
});

const inertTelemetry: AgentOSTelemetry = Object.freeze({
  enabled: false,
  startOperation: () => Effect.succeed(inertOperation),
  shutdown: Effect.void,
});

export default registerAgentOSObservability;
