import type { AgentOSRegistrationV1 } from "@akua-dev/agentos";

export const additiveRegistration: AgentOSRegistrationV1 = {
  version: 1,
  id: "@example/agentos-additive:runtime",
  names: {
    version: 1,
    commands: ["example-ecosystem-status"],
  },
  register(pi) {
    pi.registerCommand("example-ecosystem-status", {
      description: "Inspect the additive example",
      async handler(_arguments, context) {
        context.ui.notify("additive example active", "info");
      },
    });
  },
};
