import { Effect, Option, Ref } from "effect";

import {
  initializeAgentOSTelemetryFromEnvironment,
  type AgentOSOperation,
  type AgentOSTelemetry,
  type AgentOSTraceCarrier,
} from "./runtime.ts";

export type AgentOSTelemetryRuntimeSource =
  | AgentOSTelemetry
  | Effect.Effect<AgentOSTelemetry>;

export interface AgentOSTelemetryRuntime {
  readonly telemetry: Effect.Effect<AgentOSTelemetry>;
  readonly parentCarrier: Effect.Effect<AgentOSTraceCarrier | undefined>;
  readonly publish: (operation: AgentOSOperation) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

export const makeAgentOSTelemetryRuntime = Effect.fn(
  "agentos.telemetry.makeRuntimeContext",
)(function*(source?: AgentOSTelemetryRuntimeSource) {
  const resolve = source === undefined
    ? initializeAgentOSTelemetryFromEnvironment()
    : Effect.isEffect(source)
    ? source
    : Effect.succeed(source);
  const telemetry = yield* Effect.cached(resolve);
  const current = yield* Ref.make(
    Option.none<Readonly<Record<string, string>>>(),
  );
  const parentCarrier = Ref.get(current).pipe(
    Effect.map(Option.match({
      onNone: () => undefined,
      onSome: (carrier): AgentOSTraceCarrier => ({ ...carrier }),
    })),
  );
  const publish = (operation: AgentOSOperation) =>
    Effect.gen(function*() {
      const carrier: Record<string, string> = {};
      yield* operation.inject(carrier);
      const traceparent = carrier.traceparent?.trim();
      if (
        traceparent === undefined ||
        !/^00-[0-9a-f]{32}-[0-9a-f]{16}-(?:00|01)$/.test(traceparent)
      ) {
        yield* Ref.set(current, Option.none());
        return;
      }
      const tracestate = carrier.tracestate?.trim();
      yield* Ref.set(current, Option.some({
        traceparent,
        ...(tracestate === undefined || tracestate.length === 0 ||
            tracestate.length > 512
          ? {}
          : { tracestate }),
      }));
    }).pipe(Effect.catchCause(() => Ref.set(current, Option.none())));
  return {
    telemetry,
    parentCarrier,
    publish,
    clear: Ref.set(current, Option.none()),
  } satisfies AgentOSTelemetryRuntime;
});
