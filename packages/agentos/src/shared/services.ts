import {
  Clock,
  Context,
  Effect,
  Layer,
  Metric,
  Random,
  Ref,
  Schema,
} from "effect";

const DiagnosticOutcome = Schema.Literals([
  "success",
  "failure",
  "degraded",
]);
const DiagnosticAttributeValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
]);

export const AgentOSDiagnostic = Schema.Struct({
  id: Schema.String,
  timestampMillis: Schema.Number,
  component: Schema.String,
  operation: Schema.String,
  outcome: DiagnosticOutcome,
  attributes: Schema.Record(Schema.String, DiagnosticAttributeValue),
});

export type AgentOSDiagnostic = typeof AgentOSDiagnostic.Type;
export type AgentOSDiagnosticAttributeValue =
  typeof DiagnosticAttributeValue.Type;

export interface AgentOSDiagnosticInput {
  readonly component: string;
  readonly operation: string;
  readonly outcome: typeof DiagnosticOutcome.Type;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export class AgentOSIdentifierUnavailable extends Schema.TaggedErrorClass<AgentOSIdentifierUnavailable>()(
  "AgentOSIdentifierUnavailable",
  { reason: Schema.Literal("test_sequence_exhausted") },
) {}

export class AgentOSIdentifier extends Context.Service<
  AgentOSIdentifier,
  {
    readonly next: Effect.Effect<string, AgentOSIdentifierUnavailable>;
  }
>()("agentos/Identifier") {
  static readonly layer = Layer.succeed(AgentOSIdentifier)({
    next: Effect.forEach(
      Array.from({ length: 32 }),
      () => Random.nextIntBetween(0, 15),
    ).pipe(
      Effect.map(
        (digits) => `evt_${digits.map((digit) => digit.toString(16)).join("")}`,
      ),
    ),
  });

  static readonly test = (identifiers: ReadonlyArray<string>) =>
    Layer.effect(
      AgentOSIdentifier,
      Effect.gen(function*() {
        const index = yield* Ref.make(0);
        return AgentOSIdentifier.of({
          next: Ref.getAndUpdate(index, (value) => value + 1).pipe(
            Effect.flatMap((value) => {
              const identifier = identifiers[value];
              return identifier === undefined
                ? AgentOSIdentifierUnavailable.make({
                    reason: "test_sequence_exhausted",
                  })
                : Effect.succeed(identifier);
            }),
          ),
        });
      }),
    );
}

export class AgentOSDiagnostics extends Context.Service<
  AgentOSDiagnostics,
  {
    readonly emit: (
      input: AgentOSDiagnosticInput,
    ) => Effect.Effect<void, AgentOSIdentifierUnavailable>;
  }
>()("agentos/Diagnostics") {
  static readonly layer = Layer.effect(
    AgentOSDiagnostics,
    Effect.gen(function*() {
      const identifiers = yield* AgentOSIdentifier;
      return AgentOSDiagnostics.of({
        emit: Effect.fn("AgentOSDiagnostics.emit")(function*(input) {
          const event = yield* makeDiagnostic(identifiers, input);
          const annotations = diagnosticAnnotations(event);
          yield* Effect.annotateCurrentSpan(annotations);
          yield* Effect.logInfo("agentos.diagnostic", annotations);
          const counter = Metric.counter("agentos.shared.diagnostic.events").pipe(
            Metric.withAttributes({ outcome: event.outcome }),
            Metric.withConstantInput(1),
          );
          yield* Effect.track(Effect.void, counter);
        }),
      });
    }),
  );

  static readonly live = AgentOSDiagnostics.layer.pipe(
    Layer.provide(AgentOSIdentifier.layer),
  );

  static readonly test = (
    captured: Ref.Ref<ReadonlyArray<AgentOSDiagnostic>>,
    identifiers: ReadonlyArray<string>,
  ) =>
    Layer.effect(
      AgentOSDiagnostics,
      Effect.gen(function*() {
        const identifierIndex = yield* Ref.make(0);
        const identifierService = AgentOSIdentifier.of({
          next: Ref.getAndUpdate(identifierIndex, (value) => value + 1).pipe(
            Effect.flatMap((value) => {
              const identifier = identifiers[value];
              return identifier === undefined
                ? AgentOSIdentifierUnavailable.make({
                    reason: "test_sequence_exhausted",
                  })
                : Effect.succeed(identifier);
            }),
          ),
        });
        return AgentOSDiagnostics.of({
          emit: Effect.fn("AgentOSDiagnostics.test.emit")(function*(input) {
            const event = yield* makeDiagnostic(identifierService, input);
            yield* Ref.update(captured, (events) => [...events, event]);
          }),
        });
      }),
    );
}

const makeDiagnostic = Effect.fn("AgentOSDiagnostics.make")(function*(
  identifiers: AgentOSIdentifier["Service"],
  input: AgentOSDiagnosticInput,
) {
  const id = yield* identifiers.next;
  const timestampMillis = yield* Clock.currentTimeMillis;
  return {
    id,
    timestampMillis,
    component: safeToken(input.component),
    operation: safeToken(input.operation),
    outcome: input.outcome,
    attributes: safeDiagnosticAttributes(input.attributes ?? {}),
  } satisfies AgentOSDiagnostic;
});

const allowedAttributeRules: Readonly<
  Record<
    string,
    { readonly maximumLength: number; readonly pattern: RegExp }
  >
> = Object.freeze({
  "agentos.agent.id": {
    maximumLength: 128,
    pattern: /^[0-9A-Za-z_.:-]+$/,
  },
  "agentos.assignment.id": {
    maximumLength: 128,
    pattern: /^[0-9A-Za-z_.:-]+$/,
  },
  "agentos.namespace": {
    maximumLength: 63,
    pattern: /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/,
  },
  "agentos.phase": {
    maximumLength: 64,
    pattern: /^[a-z0-9_.-]+$/,
  },
  "agentos.reason": {
    maximumLength: 64,
    pattern: /^[a-z0-9_.-]+$/,
  },
  "agentos.request.id": {
    maximumLength: 128,
    pattern: /^[0-9A-Za-z_.:-]+$/,
  },
  "agentos.task.id": {
    maximumLength: 128,
    pattern: /^[0-9A-Za-z_.:-]+$/,
  },
});

export function safeDiagnosticAttributes(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, AgentOSDiagnosticAttributeValue>> {
  const safe: Record<string, AgentOSDiagnosticAttributeValue> = {};
  for (const key of Object.keys(input).sort()) {
    const rule = allowedAttributeRules[key];
    const value = input[key];
    if (
      rule !== undefined &&
      typeof value === "string" &&
      value.length <= rule.maximumLength &&
      rule.pattern.test(value)
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

function safeToken(value: string): string {
  return /^[a-z0-9_.-]{1,64}$/.test(value) ? value : "unknown";
}

function diagnosticAnnotations(
  event: AgentOSDiagnostic,
): Readonly<Record<string, AgentOSDiagnosticAttributeValue>> {
  return {
    "agentos.diagnostic.id": event.id,
    "agentos.diagnostic.timestamp_ms": event.timestampMillis,
    "agentos.component": event.component,
    "agentos.operation": event.operation,
    "agentos.outcome": event.outcome,
    ...event.attributes,
  };
}
