import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  composeAgentOSStartupPrompt,
  registerAgentOSInstructions,
  registerAgentOSRuntime,
  registerAgentOSStartup,
  type AgentOSRegistrationV1,
  type AgentOSStartupContributionV1,
} from "@agentos/pi";

export const contribution: AgentOSStartupContributionV1 = {
  version: 1,
  id: "@example/composer:startup",
  skill: "example-agentos-startup",
  instruction: "Inspect the example customization through native tools.",
};

const replacement: AgentOSRegistrationV1 = {
  version: 1,
  id: "@example/composer:runtime",
  names: { version: 1, commands: ["example-agentos-status"] },
  register(pi) {
    pi.registerCommand("example-agentos-status", {
      description: "Show the example customization status",
      async handler(_args, context) {
        context.ui.notify("example ready", "info");
      },
    });
  },
};

export function registerExampleAgentOS(pi: ExtensionAPI) {
  registerAgentOSInstructions(pi, [
    {
      version: 1,
      id: "@example/composer:instructions",
      content: "Use the example organization's reviewed policy.",
    },
  ]);
  registerAgentOSRuntime(pi, [replacement]);
  registerAgentOSStartup(pi, {
    customType: "@example/composer:startup",
    prompt: composeAgentOSStartupPrompt([contribution]),
  });
}
