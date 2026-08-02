import {
  buildAgentOSStartupPromptEffect,
  defineAgentOSPiExtension,
  registerAgentOSInstructionsEffect,
  registerAgentOSRuntimeEffect,
  registerAgentOSStartupEffect,
  type AgentOSStartupContributionV1,
} from "@akua-dev/agentos";
import { Effect } from "effect";

import { replacementRegistration } from "../registration.ts";

export const replacementStartup: AgentOSStartupContributionV1 = {
  version: 1,
  id: "@example/agentos-replacement:startup",
  skill: "example-replacement",
  instruction: "Inspect the replacement distribution through native tools.",
};

export default defineAgentOSPiExtension((pi) =>
  Effect.gen(function*() {
    yield* registerAgentOSInstructionsEffect(pi, [
      {
        version: 1,
        id: "@example/agentos-replacement:instructions",
        content: "Use the reviewed example replacement distribution.",
      },
    ]);
    yield* registerAgentOSRuntimeEffect(pi, [replacementRegistration]);
    yield* registerAgentOSStartupEffect(pi, {
      customType: "@example/agentos-replacement:startup",
      prompt: yield* buildAgentOSStartupPromptEffect([replacementStartup]),
      requiredSkills: [replacementStartup.skill],
    });
  })
);
