import {
  composeAgentOSStartupPrompt,
  registerAgentOSInstructions,
  registerAgentOSRuntime,
  registerAgentOSStartup,
  type AgentOSStartupContributionV1,
} from "@agentos/pi";

import { replacementRegistration } from "../registration.ts";

export const replacementStartup: AgentOSStartupContributionV1 = {
  version: 1,
  id: "@example/agentos-replacement:startup",
  skill: "example-replacement",
  instruction: "Inspect the replacement distribution through native tools.",
};

export default function registerReplacementAgentOS(
  pi: Parameters<typeof registerAgentOSRuntime>[0],
) {
  registerAgentOSInstructions(pi, [
    {
      version: 1,
      id: "@example/agentos-replacement:instructions",
      content: "Use the reviewed example replacement distribution.",
    },
  ]);
  registerAgentOSRuntime(pi, [replacementRegistration]);
  registerAgentOSStartup(pi, {
    customType: "@example/agentos-replacement:startup",
    prompt: composeAgentOSStartupPrompt([replacementStartup]),
    requiredSkills: [replacementStartup.skill],
  });
}
