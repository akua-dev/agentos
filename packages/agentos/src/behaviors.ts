import type { AgentOSRegistrationV1 } from "./preflight.ts";
import { Effect } from "effect";
import {
  registerAgentosBackgroundTasksEffect,
  type AgentOSBackgroundTasksOptions,
} from "./background-tasks/extension.ts";
import {
  registerMateMemoryExtensionLiveEffect,
  type MateMemoryExtensionDependencies,
} from "./mate-memory/extension.ts";
import {
  registerOpenAIServerCompactionEffect,
  type OpenAIServerCompactionDependencies,
} from "./openai-server-compaction/extension.ts";
import {
  registerAgentosSupervisionGuardEffect,
  type AgentOSSupervisionGuardOptions,
} from "./supervision-guard/extension.ts";
import { registerCoordinationReadinessEffect } from "./coordination-readiness/extension.ts";
import {
  registerAgentOSObservabilityEffect,
  type AgentOSObservabilityDependencies,
} from "./telemetry/pi-extension.ts";
import {
  registerPiWorkloadIdentityEffect,
  type PiWorkloadIdentityOptions,
} from "./access/pi-workload-identity.ts";

export function createAgentOSWorkloadIdentityRegistration(
  options: PiWorkloadIdentityOptions = {},
): AgentOSRegistrationV1 {
  return {
    version: 1,
    id: "@akua-dev/agentos:workload-identity",
    names: { version: 1 },
    register(pi) {
      return registerPiWorkloadIdentityEffect(pi, options);
    },
  };
}

export function createAgentOSObservabilityRegistration(
  dependencies: AgentOSObservabilityDependencies = {},
): AgentOSRegistrationV1 {
  return {
    version: 1,
    id: "@akua-dev/agentos:observability",
    names: { version: 1 },
    register(pi) {
      return registerAgentOSObservabilityEffect(pi, dependencies);
    },
  };
}

export function createAgentOSBackgroundTasksRegistration(
  options: AgentOSBackgroundTasksOptions = {},
): AgentOSRegistrationV1 {
  return {
    version: 1,
    id: "@akua-dev/agentos:background-tasks",
    names: {
      version: 1,
      tools: [
        "run_background_command",
        "get_background_command_output",
        "list_background_commands",
        "kill_background_command",
        "attest_coordination_listener",
        "confirm_coordination_catchup",
      ],
      commands: ["background-commands"],
      messages: ["agentos-background-command-completion"],
      entries: ["agentos-background-command-lifecycle"],
    },
    register(pi) {
      return Effect.gen(function*() {
        const broker = yield* registerAgentosBackgroundTasksEffect(pi, options);
        yield* registerCoordinationReadinessEffect(pi, { broker });
      });
    },
  };
}

export function createAgentOSMateMemoryRegistration(
  dependencies: MateMemoryExtensionDependencies = {},
): AgentOSRegistrationV1 {
  return {
    version: 1,
    id: "@akua-dev/agentos:mate-memory",
    names: {
      version: 1,
      tools: ["set_mate_memory_state", "memory_delete_topic"],
      commands: ["memory"],
      messages: ["agentos-mate-memory-context"],
      entries: [
        "agentos-mate-memory-state",
        "agentos-mate-memory-maintenance",
      ],
    },
    register(pi) {
      return registerMateMemoryExtensionLiveEffect(pi, dependencies).pipe(
        Effect.asVoid,
      );
    },
  };
}

export function createAgentOSOpenAIServerCompactionRegistration(
  dependencies?: OpenAIServerCompactionDependencies,
): AgentOSRegistrationV1 {
  return {
    version: 1,
    id: "@akua-dev/agentos:openai-server-compaction",
    names: { version: 1 },
    register: (pi) => registerOpenAIServerCompactionEffect(pi, dependencies),
  };
}

export function createAgentOSSupervisionGuardRegistration(
  options: AgentOSSupervisionGuardOptions = {},
): AgentOSRegistrationV1 {
  return {
    version: 1,
    id: "@akua-dev/agentos:supervision-guard",
    names: {
      version: 1,
      messages: [
        "agentos-supervision-guard",
        "agentos-supervision-recovery",
      ],
    },
    register(pi) {
      return registerAgentosSupervisionGuardEffect(pi, options);
    },
  };
}

export const defaultAgentOSRuntime: readonly AgentOSRegistrationV1[] =
  Object.freeze([
    createAgentOSWorkloadIdentityRegistration(),
    createAgentOSObservabilityRegistration(),
    createAgentOSBackgroundTasksRegistration(),
    createAgentOSMateMemoryRegistration(),
    createAgentOSOpenAIServerCompactionRegistration(),
    createAgentOSSupervisionGuardRegistration(),
  ]);
