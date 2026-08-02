import {
  A2aTransportTelemetry,
  A2aTransportTelemetryEventV1Schema,
} from "@akua-dev/agentos";
import { Effect, Layer, Metric } from "effect";

type A2aTransportTelemetryEvent =
  typeof A2aTransportTelemetryEventV1Schema.Type;

export function a2aTelemetryAnnotations(event: A2aTransportTelemetryEvent) {
  return {
    "agentos.a2a.method": event.method,
    "agentos.a2a.outcome": event.outcome,
    "agentos.a2a.retry": event.retry,
    "agentos.a2a.recovery": event.recovery,
    "agentos.a2a.timed_out": event.timedOut,
    ...(event.targetAgentId === null
      ? {}
      : { "agentos.a2a.target_agent_id": event.targetAgentId }),
    ...(event.skillId === null
      ? {}
      : { "agentos.a2a.skill_id": event.skillId }),
    ...(event.inboxId === null
      ? {}
      : { "agentos.a2a.inbox_id": event.inboxId }),
    ...(event.taskId === null
      ? {}
      : { "agentos.a2a.task_id": event.taskId }),
    ...(event.assignmentId === null
      ? {}
      : { "agentos.a2a.assignment_id": event.assignmentId }),
  };
}

export const A2aTransportTelemetryLiveLayer = Layer.succeed(
  A2aTransportTelemetry,
  A2aTransportTelemetry.of({
    emit: Effect.fn("agentos.a2a.telemetry.emit")(function*(event) {
      const annotations = a2aTelemetryAnnotations(event);
      yield* Effect.annotateCurrentSpan(annotations);
      yield* Effect.logInfo("agentos.a2a.transport", annotations);
      const counter = Metric.counter("agentos.a2a.transport.events").pipe(
        Metric.withAttributes({
          method: event.method,
          outcome: event.outcome,
          recovery: event.recovery,
          retry: String(event.retry),
          timed_out: String(event.timedOut),
        }),
        Metric.withConstantInput(1),
      );
      yield* Effect.track(Effect.void, counter);
    }),
  }),
);
