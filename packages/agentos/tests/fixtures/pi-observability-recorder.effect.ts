import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Config, Effect, FileSystem, Ref, Schema } from "effect";

import { defineAgentOSPiExtension, runAgentOSPiProgram } from "../../src/pi-host-adapter.ts";
import { registerAgentOSObservabilityEffect } from "../../src/telemetry/pi-extension.ts";
import type {
  AgentOSOperationInput,
  AgentOSOperationOutcome,
  AgentOSProviderAttemptInput,
  AgentOSProviderAttemptOutcome,
  AgentOSTelemetry,
} from "../../src/telemetry/runtime.ts";

interface AttemptEvidence {
  readonly id: string;
  readonly input: AgentOSProviderAttemptInput;
  readonly outcome?: AgentOSProviderAttemptOutcome;
}

interface OperationEvidence {
  readonly id: string;
  readonly input: AgentOSOperationInput;
  readonly attempts: ReadonlyArray<AttemptEvidence>;
  readonly outcome?: AgentOSOperationOutcome;
}

const registerRecorder = Effect.fn("test.piObservability.registerRecorder")(
  function*(pi: ExtensionAPI) {
    const outputPath = yield* Config.string("AGENTOS_TEST_TELEMETRY_FILE");
    const nextId = yield* Ref.make(0);
    const evidence = yield* Ref.make<ReadonlyArray<OperationEvidence>>([]);

    const allocateId = (prefix: string) => Ref.modify(nextId, (current): [string, number] => {
      const next = current + 1;
      return [`${prefix}-${next}`, next];
    });

    const telemetry: AgentOSTelemetry = {
      enabled: true,
      startOperation: (input) => Effect.gen(function*() {
        const id = yield* allocateId("operation");
        yield* Ref.update(evidence, (current) => [
          ...current,
          { id, input, attempts: [] },
        ]);
        return {
          id,
          inject: () => Effect.void,
          startProviderAttempt: (attemptInput) => Effect.gen(function*() {
            const attemptId = yield* allocateId("attempt");
            yield* Ref.update(evidence, (current) => current.map((operation) =>
              operation.id === id
                ? {
                  ...operation,
                  attempts: [
                    ...operation.attempts,
                    { id: attemptId, input: attemptInput },
                  ],
                }
                : operation
            ));
            return {
              id: attemptId,
              inject: (headers) => Effect.sync(() => {
                if (headers instanceof Headers) {
                  headers.set(
                    "traceparent",
                    "00-11111111111111111111111111111111-2222222222222222-01",
                  );
                  headers.set("x-agentos-request-attempt-id", attemptId);
                } else {
                  headers.traceparent =
                    "00-11111111111111111111111111111111-2222222222222222-01";
                  headers["x-agentos-request-attempt-id"] = attemptId;
                }
              }),
              end: (outcome = {}) => Ref.update(evidence, (current) =>
                current.map((operation) => operation.id === id
                  ? {
                    ...operation,
                    attempts: operation.attempts.map((attempt) =>
                      attempt.id === attemptId
                        ? { ...attempt, outcome }
                        : attempt
                    ),
                  }
                  : operation)
              ),
            };
          }),
          end: (outcome = {}) => Ref.update(evidence, (current) =>
            current.map((operation) => operation.id === id
              ? { ...operation, outcome }
              : operation)
          ),
        };
      }),
      shutdown: Effect.void,
    };

    yield* registerAgentOSObservabilityEffect(pi, { telemetry });
    yield* Effect.sync(() => {
      pi.on("session_shutdown", () => runAgentOSPiProgram(
        writeEvidence(outputPath, evidence).pipe(
          Effect.provide(BunFileSystem.layer),
        ),
      ));
    });
  },
);

const writeEvidence = Effect.fn("test.piObservability.writeEvidence")(
  function*(
    outputPath: string,
    evidence: Ref.Ref<ReadonlyArray<OperationEvidence>>,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const encoded = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Unknown),
    )(yield* Ref.get(evidence));
    yield* fileSystem.writeFileString(outputPath, `${encoded}\n`);
  },
);

export default defineAgentOSPiExtension((pi) =>
  registerRecorder(pi).pipe(Effect.provide(BunFileSystem.layer))
);
