import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import type { BackgroundTaskBroker } from "../background-tasks/broker.ts";
import type {
  BackgroundCommandRequest,
  TaskSnapshot,
} from "../background-tasks/types.ts";
import {
  invalidateCoordinationReadiness,
  writeCoordinationReadiness,
} from "../readiness-state.ts";

const ListenerTaskParameters = Type.Object({
  listener_task_id: Type.String({ minLength: 1 }),
});

const supervisionMarker = "[agentos-supervision]";
const listenerReadyOutput = '"state":"listening"';
const targetedListenerCommand =
  /^pg-listen agentos_mate_[0-9a-f]{32}$/;

type Environment = Readonly<Record<string, string | undefined>>;

export type CoordinationReadinessOptions = {
  broker: BackgroundTaskBroker;
  environment?: Environment;
  processId?: number;
  stateDirectory?: string;
};

export function registerCoordinationReadiness(
  pi: ExtensionAPI,
  options: CoordinationReadinessOptions,
) {
  const environment = options.environment ?? process.env;
  const ownerProcessId = options.processId ?? process.pid;
  const home = environment.HOME?.trim();
  const stateDirectory = options.stateDirectory ??
    (home ? join(home, ".local", "state", "agentos") : undefined);
  let activeListenerTaskId: string | undefined;

  options.broker.onEvent((event) => {
    if (
      event.type !== "task_terminal" ||
      event.task.id !== activeListenerTaskId ||
      stateDirectory === undefined
    ) {
      return;
    }
    activeListenerTaskId = undefined;
    void Effect.runPromise(
      invalidateCoordinationReadiness(stateDirectory, event.task.id),
    ).catch(() => undefined);
  });

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
    async execute(_toolCallId, params) {
      const listenerTaskId = requiredParameter(params, "listener_task_id");
      const readinessStateDirectory = requiredStateDirectory(stateDirectory);
      if (
        activeListenerTaskId !== undefined &&
        activeListenerTaskId !== listenerTaskId
      ) {
        const active = await options.broker.get(activeListenerTaskId);
        if (active.state === "running") {
          throw new Error(
            "A different coordination listener is already attested by this Mate runtime",
          );
        }
        activeListenerTaskId = undefined;
      }

      const task = await verifiedListener(options.broker, listenerTaskId);
      activeListenerTaskId = listenerTaskId;
      try {
        await Effect.runPromise(
          writeCoordinationReadiness({
            agentName: requiredEnvironment(
              environment,
              "AGENTOS_AGENT_NAME",
            ),
            herdrSession: requiredEnvironment(environment, "HERDR_SESSION"),
            listenerProcessId: requiredProcessId(task),
            listenerTaskId,
            ownerProcessId,
            phase: "listening",
            stateDirectory: readinessStateDirectory,
          }),
        );
        const current = await options.broker.get(listenerTaskId);
        if (current.state !== "running") {
          throw new Error(
            "Coordination listener ended before its readiness attestation completed",
          );
        }
      } catch (cause) {
        if (activeListenerTaskId === listenerTaskId) {
          activeListenerTaskId = undefined;
        }
        await Effect.runPromise(
          invalidateCoordinationReadiness(
            readinessStateDirectory,
            listenerTaskId,
          ),
        ).catch(() => undefined);
        throw cause;
      }
      return result(
        { listenerTaskId, phase: "listening" as const },
        `Attested coordination listener "${listenerTaskId}"; durable catch-up is still required.`,
      );
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
    async execute(_toolCallId, params) {
      const listenerTaskId = requiredParameter(params, "listener_task_id");
      const readinessStateDirectory = requiredStateDirectory(stateDirectory);
      if (activeListenerTaskId !== listenerTaskId) {
        throw new Error(
          "The coordination listener is not attested by this Mate runtime",
        );
      }
      const task = await verifiedListener(options.broker, listenerTaskId);
      await Effect.runPromise(
        writeCoordinationReadiness({
          agentName: requiredEnvironment(environment, "AGENTOS_AGENT_NAME"),
          herdrSession: requiredEnvironment(environment, "HERDR_SESSION"),
          listenerProcessId: requiredProcessId(task),
          listenerTaskId,
          ownerProcessId,
          phase: "caught_up",
          stateDirectory: readinessStateDirectory,
        }),
      );
      return result(
        { listenerTaskId, phase: "caught_up" as const },
        `Confirmed durable catch-up for coordination listener "${listenerTaskId}".`,
      );
    },
  });
}

async function verifiedListener(
  broker: BackgroundTaskBroker,
  listenerTaskId: string,
) {
  const [task, request] = await Promise.all([
    broker.get(listenerTaskId),
    Promise.resolve(broker.getRequest(listenerTaskId)),
  ]);
  if (task.state !== "running" || !isCoordinationListener(request)) {
    throw new Error(
      "Background task does not satisfy the coordination listener contract",
    );
  }
  requiredProcessId(task);
  return task;
}

function isCoordinationListener(request: BackgroundCommandRequest) {
  return (
    targetedListenerCommand.test(request.command) &&
    request.description.includes(supervisionMarker) &&
    request.readyOutput === listenerReadyOutput &&
    request.completionDelivery === "steer"
  );
}

function requiredProcessId(task: TaskSnapshot) {
  if (
    task.processId === undefined ||
    !Number.isSafeInteger(task.processId) ||
    task.processId <= 0
  ) {
    throw new Error("Coordination listener process identity is unavailable");
  }
  return task.processId;
}

function requiredEnvironment(environment: Environment, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for coordination readiness`);
  return value;
}

function requiredStateDirectory(value: string | undefined) {
  if (!value) {
    throw new Error("HOME is required for coordination readiness");
  }
  return value;
}

function requiredParameter(params: Record<string, unknown>, name: string) {
  const value = params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function result<T>(details: T, text: string): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

export default registerCoordinationReadiness;
