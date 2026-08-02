import * as BunServices from "@effect/platform-bun/BunServices";
import { Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  Config,
  Effect,
  Option,
  Path,
  Ref,
  Schema,
} from "effect";

import type { BackgroundTaskBroker } from "../background-tasks/broker.ts";
import type {
  BackgroundCommandRequest,
  TaskSnapshot,
} from "../background-tasks/types.ts";
import {
  invalidateCoordinationReadiness,
  writeCoordinationReadiness,
} from "../readiness-state.ts";
import {
  legacyEnvironmentConfigLayer,
  runPromiseLegacy,
  runSyncLegacy,
} from "../shared/legacy.ts";

const ListenerTaskParameters = Type.Object({
  listener_task_id: Type.String({ minLength: 1 }),
});
const ListenerInputSchema = Schema.Struct({
  listener_task_id: Schema.String.pipe(
    Schema.check(Schema.makeFilter((value) => value.trim().length > 0, {
      expected: "a non-blank listener task ID",
    })),
  ),
});
const supervisionMarker = "[agentos-supervision]";
const listenerReadyOutput = '"state":"listening"';
const targetedListenerCommand = /^pg-listen agentos_mate_[0-9a-f]{32}$/;
const CoordinationConfig = Config.all({
  agentName: Config.option(Config.string("AGENTOS_AGENT_NAME")),
  herdrSession: Config.option(Config.string("HERDR_SESSION")),
  home: Config.option(Config.string("HOME")),
});

export class CoordinationReadinessError extends Schema.TaggedErrorClass<CoordinationReadinessError>()(
  "CoordinationReadinessError",
  {
    cause: Schema.Unknown,
    code: Schema.Literals([
      "invalid_configuration",
      "invalid_listener",
      "invalid_request",
      "listener_conflict",
      "persistence_failure",
    ]),
    message: Schema.String,
  },
) {}

export type CoordinationReadinessOptions = {
  readonly broker: BackgroundTaskBroker;
  readonly agentName?: string;
  readonly herdrSession?: string;
  readonly ownerProcessId?: number;
  readonly stateDirectory?: string;
};

export type CoordinationReadinessRuntimeOptions = {
  readonly agentName: string;
  readonly herdrSession: string;
  readonly ownerProcessId: number;
  readonly stateDirectory: string;
};

type DeferredCoordinationReadinessRuntimeOptions = {
  readonly agentName?: string;
  readonly herdrSession?: string;
  readonly ownerProcessId: number;
  readonly stateDirectory?: string;
};

export type CoordinationReadinessResult = {
  readonly listenerTaskId: string;
  readonly phase: "caught_up" | "listening";
};

export type CoordinationReadinessRuntime = {
  readonly attest: (
    input: unknown,
  ) => Effect.Effect<
    AgentToolResult<CoordinationReadinessResult>,
    CoordinationReadinessError
  >;
  readonly confirmCatchup: (
    input: unknown,
  ) => Effect.Effect<
    AgentToolResult<CoordinationReadinessResult>,
    CoordinationReadinessError
  >;
  readonly shutdown: Effect.Effect<void>;
};

export function registerCoordinationReadiness(
  pi: ExtensionAPI,
  options: CoordinationReadinessOptions,
) {
  return runSyncLegacy(
    Effect.gen(function*() {
      const configured = yield* CoordinationConfig;
      const paths = yield* Path.Path;
      const home = Option.getOrUndefined(configured.home);
      const stateDirectory = options.stateDirectory ??
        (home === undefined
          ? undefined
          : paths.join(home, ".local", "state", "agentos"));
      const ownerProcessId = options.ownerProcessId ??
        (yield* Effect.sync(() => process.pid));
      const runtime = yield* makeDeferredCoordinationReadiness(options.broker, {
        agentName: options.agentName ?? Option.getOrUndefined(configured.agentName),
        herdrSession: options.herdrSession ??
          Option.getOrUndefined(configured.herdrSession),
        ownerProcessId,
        stateDirectory,
      });
      registerPiCoordinationReadiness(pi, runtime);
      return runtime;
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.provide(legacyEnvironmentConfigLayer()),
    ),
  );
}

export const makeCoordinationReadiness = Effect.fn(
  "agentos.coordinationReadiness.make",
)(function*(
  broker: BackgroundTaskBroker,
  options: CoordinationReadinessRuntimeOptions,
) {
  return yield* makeDeferredCoordinationReadiness(broker, options);
});

const makeDeferredCoordinationReadiness = Effect.fn(
  "agentos.coordinationReadiness.makeDeferred",
)(function*(
  broker: BackgroundTaskBroker,
  options: DeferredCoordinationReadinessRuntimeOptions,
) {
  const activeListenerTaskId = yield* Ref.make(Option.none<string>());
  const unsubscribe = yield* broker.onEvent((event) =>
    Effect.gen(function*() {
      if (event.type !== "task_terminal") return;
      const active = yield* Ref.get(activeListenerTaskId);
      if (Option.isNone(active) || active.value !== event.task.id) return;
      yield* Ref.set(activeListenerTaskId, Option.none());
      if (options.stateDirectory === undefined) return;
      yield* invalidateCoordinationReadiness(
        options.stateDirectory,
        event.task.id,
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to invalidate coordination readiness", {
            cause,
            listenerTaskId: event.task.id,
          })
        ),
      );
    }));

  const attest = (input: unknown) =>
    Effect.gen(function*() {
      const configured = yield* requiredRuntimeConfiguration(options);
      const listenerTaskId = yield* parseListenerTaskId(input);
      const active = yield* Ref.get(activeListenerTaskId);
      if (Option.isSome(active) && active.value !== listenerTaskId) {
        const current = yield* broker.get(active.value).pipe(
          Effect.mapError((cause) =>
            coordinationFailure(
              "invalid_listener",
              `Could not inspect attested coordination listener ${active.value}`,
              cause,
            )
          ),
        );
        if (current.state === "running") {
          return yield* Effect.fail(coordinationFailure(
            "listener_conflict",
            "A different coordination listener is already attested by this Mate runtime",
          ));
        }
        yield* Ref.set(activeListenerTaskId, Option.none());
      }

      const task = yield* verifiedListener(broker, listenerTaskId);
      yield* Ref.set(activeListenerTaskId, Option.some(listenerTaskId));
      const persisted = yield* Effect.result(
        writeCoordinationReadiness({
          agentName: configured.agentName,
          herdrSession: configured.herdrSession,
          listenerProcessId: yield* requiredProcessId(task),
          listenerTaskId,
          ownerProcessId: configured.ownerProcessId,
          phase: "listening",
          stateDirectory: configured.stateDirectory,
        }).pipe(
          Effect.mapError((cause) =>
            coordinationFailure(
              "persistence_failure",
              "Could not persist coordination listener attestation",
              cause,
            )
          ),
          Effect.andThen(verifiedListener(broker, listenerTaskId)),
        ),
      );
      if (persisted._tag === "Failure") {
        yield* Ref.set(activeListenerTaskId, Option.none());
        yield* invalidateCoordinationReadiness(
          configured.stateDirectory,
          listenerTaskId,
        ).pipe(Effect.ignore);
        return yield* Effect.fail(persisted.failure);
      }
      const details: CoordinationReadinessResult = {
        listenerTaskId,
        phase: "listening",
      };
      return result(
        details,
        `Attested coordination listener "${listenerTaskId}"; durable catch-up is still required.`,
      );
    });

  const confirmCatchup = (input: unknown) =>
    Effect.gen(function*() {
      const configured = yield* requiredRuntimeConfiguration(options);
      const listenerTaskId = yield* parseListenerTaskId(input);
      const active = yield* Ref.get(activeListenerTaskId);
      if (Option.isNone(active) || active.value !== listenerTaskId) {
        return yield* Effect.fail(coordinationFailure(
          "invalid_listener",
          "The coordination listener is not attested by this Mate runtime",
        ));
      }
      const task = yield* verifiedListener(broker, listenerTaskId);
      yield* writeCoordinationReadiness({
        agentName: configured.agentName,
        herdrSession: configured.herdrSession,
        listenerProcessId: yield* requiredProcessId(task),
        listenerTaskId,
        ownerProcessId: configured.ownerProcessId,
        phase: "caught_up",
        stateDirectory: configured.stateDirectory,
      }).pipe(
        Effect.mapError((cause) =>
          coordinationFailure(
            "persistence_failure",
            "Could not persist coordination catch-up",
            cause,
          )
        ),
      );
      const details: CoordinationReadinessResult = {
        listenerTaskId,
        phase: "caught_up",
      };
      return result(
        details,
        `Confirmed durable catch-up for coordination listener "${listenerTaskId}".`,
      );
    });

  return {
    attest,
    confirmCatchup,
    shutdown: unsubscribe,
  } satisfies CoordinationReadinessRuntime;
});

function registerPiCoordinationReadiness(
  pi: ExtensionAPI,
  runtime: CoordinationReadinessRuntime,
) {
  pi.registerTool({
    name: "attest_coordination_listener",
    label: "Attest coordination listener",
    description:
      "Bind the current Mate runtime's semantic readiness to one already-running, targeted pg-listen background task whose LISTEN readiness was observed.",
    promptGuidelines: [
      "Call only after run_background_command returned a running targeted pg-listen task with the required literal readiness output.",
      "This attests listener registration only; call confirm_coordination_catchup after current_mate_bearings and its referenced durable rows have been reconciled.",
    ],
    parameters: ListenerTaskParameters,
    execute(_toolCallId, params) {
      return runPromiseLegacy(runtime.attest(params));
    },
  });
  pi.registerTool({
    name: "confirm_coordination_catchup",
    label: "Confirm coordination catch-up",
    description:
      "Confirm that the current Mate reconciled current_mate_bearings and its required durable rows after its attested listener registered.",
    promptGuidelines: [
      "Call only after the ready-then-catch-up sequence completed against PostgreSQL authority.",
      "If the listener ended during catch-up, re-arm and attest a replacement before confirming.",
    ],
    parameters: ListenerTaskParameters,
    execute(_toolCallId, params) {
      return runPromiseLegacy(runtime.confirmCatchup(params));
    },
  });
  pi.on("session_shutdown", () => runPromiseLegacy(runtime.shutdown));
}

const verifiedListener = Effect.fn(
  "agentos.coordinationReadiness.verifyListener",
)(function*(broker: BackgroundTaskBroker, listenerTaskId: string) {
  const [task, request] = yield* Effect.all([
    broker.get(listenerTaskId),
    broker.getRequest(listenerTaskId),
  ]).pipe(
    Effect.mapError((cause) =>
      coordinationFailure(
        "invalid_listener",
        "Could not inspect the coordination listener",
        cause,
      )
    ),
  );
  if (task.state !== "running" || !isCoordinationListener(request)) {
    return yield* Effect.fail(coordinationFailure(
      "invalid_listener",
      "Background task does not satisfy the coordination listener contract",
    ));
  }
  yield* requiredProcessId(task);
  return task;
});

function isCoordinationListener(request: BackgroundCommandRequest) {
  return targetedListenerCommand.test(request.command) &&
    request.description.includes(supervisionMarker) &&
    request.readyOutput === listenerReadyOutput &&
    request.completionDelivery === "steer";
}

function requiredProcessId(task: TaskSnapshot) {
  return task.processId === undefined ||
      !Number.isSafeInteger(task.processId) ||
      task.processId <= 0
    ? Effect.fail(coordinationFailure(
        "invalid_listener",
        "Coordination listener process identity is unavailable",
      ))
    : Effect.succeed(task.processId);
}

function requiredConfiguration(name: string, value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0
    ? Effect.fail(coordinationFailure(
        "invalid_configuration",
        `${name} is required for coordination readiness`,
      ))
    : Effect.succeed(trimmed);
}

function requiredRuntimeConfiguration(
  options: DeferredCoordinationReadinessRuntimeOptions,
) {
  return Effect.gen(function*() {
    const agentName = yield* requiredConfiguration(
      "AGENTOS_AGENT_NAME",
      options.agentName,
    );
    const herdrSession = yield* requiredConfiguration(
      "HERDR_SESSION",
      options.herdrSession,
    );
    const stateDirectory = yield* requiredConfiguration(
      "HOME",
      options.stateDirectory,
    );
    if (
      !Number.isSafeInteger(options.ownerProcessId) ||
      options.ownerProcessId <= 0
    ) {
      return yield* Effect.fail(coordinationFailure(
        "invalid_configuration",
        "The AgentOS owner process identity is unavailable",
      ));
    }
    return {
      agentName,
      herdrSession,
      ownerProcessId: options.ownerProcessId,
      stateDirectory,
    } satisfies CoordinationReadinessRuntimeOptions;
  });
}

function parseListenerTaskId(input: unknown) {
  return Schema.decodeUnknownEffect(ListenerInputSchema, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.map(({ listener_task_id }) => listener_task_id),
    Effect.mapError((cause) =>
      coordinationFailure(
        "invalid_request",
        `Invalid coordination readiness input: ${String(cause)}`,
        cause,
      )
    ),
  );
}

function coordinationFailure(
  code: CoordinationReadinessError["code"],
  message: string,
  cause: unknown = message,
) {
  return CoordinationReadinessError.make({ cause, code, message });
}

function result<T>(details: T, text: string): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

export default registerCoordinationReadiness;
