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
          return {
            id: `attempt-${++nextId}`,
            inject() {},
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
