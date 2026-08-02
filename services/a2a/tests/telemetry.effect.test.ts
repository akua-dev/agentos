import { assert, describe, it } from "@effect/vitest";
import {
  A2aTransportTelemetry,
  A2aTransportTelemetryEventV1Schema,
} from "@akua-dev/agentos";
import { Effect, Schema } from "effect";

import {
  A2aTransportTelemetryLiveLayer,
  a2aTelemetryAnnotations,
} from "../src/telemetry.ts";

const event = Schema.decodeUnknownSync(A2aTransportTelemetryEventV1Schema, {
  onExcessProperty: "error",
})({
  method: "SendMessage",
  outcome: "accepted",
  retry: false,
  timedOut: false,
  recovery: "postgresql_listener_then_herdr_wake",
  targetAgentId: "22222222-2222-4222-8222-222222222222",
  skillId: "repository.implementation@v1",
  inboxId: "44444444-4444-4444-8444-444444444444",
  taskId: "55555555-5555-4555-8555-555555555555",
  assignmentId: "66666666-6666-4666-8666-666666666666",
});

describe("A2A transport telemetry", () => {
  it.effect("emits only bounded contract metadata and no message content", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(a2aTelemetryAnnotations(event), {
        "agentos.a2a.assignment_id":
          "66666666-6666-4666-8666-666666666666",
        "agentos.a2a.inbox_id": "44444444-4444-4444-8444-444444444444",
        "agentos.a2a.method": "SendMessage",
        "agentos.a2a.outcome": "accepted",
        "agentos.a2a.retry": false,
        "agentos.a2a.recovery": "postgresql_listener_then_herdr_wake",
        "agentos.a2a.skill_id": "repository.implementation@v1",
        "agentos.a2a.target_agent_id":
          "22222222-2222-4222-8222-222222222222",
        "agentos.a2a.task_id": "55555555-5555-4555-8555-555555555555",
        "agentos.a2a.timed_out": false,
      });
      yield* A2aTransportTelemetry.pipe(
        Effect.flatMap((telemetry) => telemetry.emit(event)),
        Effect.provide(A2aTransportTelemetryLiveLayer),
      );
    }));
});
