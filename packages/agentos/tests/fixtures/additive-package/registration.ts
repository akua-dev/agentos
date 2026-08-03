import {
  defineAgentOSPiCommandHandler,
  type AgentOSRegistrationV1,
} from "@akua-dev/agentos";
import { Effect } from "effect";

export const additiveRegistration: AgentOSRegistrationV1 = {
  version: 1,
  id: "@example/agentos-additive:runtime",
  names: {
    version: 1,
    commands: ["example-ecosystem-status"],
  },
  register(pi) {
    return Effect.sync(() => {
      pi.registerCommand("example-ecosystem-status", {
        description: "Inspect the additive example",
        handler: defineAgentOSPiCommandHandler((_arguments, context) =>
          Effect.sync(() => context.ui.notify("additive example active", "info"))),
      });
    });
  },
};
