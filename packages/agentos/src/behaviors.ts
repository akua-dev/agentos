import type { AgentOSRegistrationV1 } from "./preflight.ts";
import {
  registerAgentosBackgroundTasks,
  type AgentOSBackgroundTasksOptions,
} from "./background-tasks/extension.ts";
import {
  registerMateMemoryExtension,
  type MateMemoryExtensionDependencies,
} from "./mate-memory/extension.ts";
import {
  createOpenAIServerCompactionExtension,
  type OpenAIServerCompactionDependencies,
} from "./openai-server-compaction/extension.ts";
import {
  registerAgentosSupervisionGuard,
  type AgentOSSupervisionGuardOptions,
} from "./supervision-guard/extension.ts";
import {
  registerAgentOSObservability,
  type AgentOSObservabilityDependencies,
} from "./telemetry/pi-extension.ts";

export function createAgentOSObservabilityRegistration(
  dependencies: AgentOSObservabilityDependencies = {},
): AgentOSRegistrationV1 {
  return {
    version: 1,
    id: "@akua-dev/agentos:observability",
    names: { version: 1 },
    register(pi) {
      registerAgentOSObservability(pi, dependencies);
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
      ],
      commands: ["background-commands"],
      messages: ["agentos-background-command-completion"],
      entries: ["agentos-background-command-lifecycle"],
    },
    register(pi) {
      registerAgentosBackgroundTasks(pi, options);
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
      registerMateMemoryExtension(pi, dependencies);
    },
  };
}

export function createAgentOSOpenAIServerCompactionRegistration(
  dependencies?: OpenAIServerCompactionDependencies,
): AgentOSRegistrationV1 {
  const registration = createOpenAIServerCompactionExtension(dependencies);
  return {
    version: 1,
    id: "@akua-dev/agentos:openai-server-compaction",
    names: { version: 1 },
    register: registration,
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
      registerAgentosSupervisionGuard(pi, options);
    },
  };
}

export const defaultAgentOSRuntime: readonly AgentOSRegistrationV1[] =
  Object.freeze([
    createAgentOSObservabilityRegistration(),
    createAgentOSBackgroundTasksRegistration(),
    createAgentOSMateMemoryRegistration(),
    createAgentOSOpenAIServerCompactionRegistration(),
    createAgentOSSupervisionGuardRegistration(),
  ]);
