import type {
  AgentOSOperationInput,
  AgentOSOperationOutcome,
  AgentOSProviderAttemptInput,
  AgentOSProviderAttemptOutcome,
  AgentOSTelemetry,
} from "../runtime.ts";

export interface RecordedTelemetryOperation {
  input: AgentOSOperationInput;
  outcome?: AgentOSOperationOutcome;
  attempts: Array<{
    input: AgentOSProviderAttemptInput;
    outcome?: AgentOSProviderAttemptOutcome;
  }>;
}

export function createTelemetryRecorder() {
  const operations: RecordedTelemetryOperation[] = [];
  let nextId = 0;
  const telemetry: AgentOSTelemetry = {
    enabled: true,
    startOperation(input) {
      const record: RecordedTelemetryOperation = {
        input,
        attempts: [],
      };
      operations.push(record);
      return {
        id: `operation-${++nextId}`,
        startProviderAttempt(attemptInput) {
          const attempt = { input: attemptInput } as (
            typeof record.attempts
          )[number];
          record.attempts.push(attempt);
          const attemptId = `attempt-${++nextId}`;
          const suffix = nextId.toString(16);
          return {
            id: attemptId,
            inject(carrier) {
              const traceparent =
                `00-${suffix.padStart(32, "0")}-${suffix.padStart(16, "0")}-01`;
              if (carrier instanceof Headers) {
                carrier.set("traceparent", traceparent);
                carrier.set("x-agentos-request-attempt-id", attemptId);
              } else {
                carrier.traceparent = traceparent;
                carrier["x-agentos-request-attempt-id"] = attemptId;
              }
            },
            end(outcome) {
              attempt.outcome = outcome;
            },
          };
        },
        end(outcome) {
          record.outcome = outcome;
        },
      };
    },
    async shutdown() {},
  };
  return { operations, telemetry };
}
