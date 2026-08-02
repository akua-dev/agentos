import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  buildAgentOSStartupPrompt,
  defineAgentOSPiCommandHandler,
  registerAgentOSInstructions,
  registerAgentOSRuntime,
  registerAgentOSStartup,
  type AgentOSRegistrationV1,
  type AgentOSStartupContributionV1,
  type WorkloadIdentityV1,
} from "@akua-dev/agentos";
import { Effect } from "effect";

export const exampleEgressAudience = AGENTOS_EGRESS_TOKEN_AUDIENCE;
export const exampleWorkloadIdentity: WorkloadIdentityV1 = {
  schemaVersion: 1,
  agentId: "11111111-1111-4111-8111-111111111111",
  role: "second_mate",
  fleet: "agentos",
  domain: "platform",
  assignmentId: null,
  kubernetesNamespace: "agentos-domain-platform",
  kubernetesPod: "agentos-platform-mate-0",
  podUid: "22222222-2222-4222-8222-222222222222",
  serviceAccountName: "agentos-platform-mate",
  serviceAccountUid: "33333333-3333-4333-8333-333333333333",
};

export const contribution: AgentOSStartupContributionV1 = {
  version: 1,
  id: "@example/extension:startup",
  skill: "example-agentos-startup",
  instruction: "Inspect the example customization through native tools.",
};

const replacement: AgentOSRegistrationV1 = {
  version: 1,
  id: "@example/extension:runtime",
  names: { version: 1, commands: ["example-agentos-status"] },
  register(pi) {
    pi.registerCommand("example-agentos-status", {
      description: "Show the example customization status",
      handler: defineAgentOSPiCommandHandler((_args, context) =>
        Effect.sync(() => context.ui.notify("example ready", "info"))),
    });
  },
};

export function registerExampleAgentOS(pi: ExtensionAPI) {
  registerAgentOSInstructions(pi, [
    {
      version: 1,
      id: "@example/extension:instructions",
      content: "Use the example organization's reviewed policy.",
    },
  ]);
  registerAgentOSRuntime(pi, [replacement]);
  registerAgentOSStartup(pi, {
    customType: "@example/extension:startup",
    prompt: buildAgentOSStartupPrompt([contribution]),
    requiredSkills: [contribution.skill],
  });
}
