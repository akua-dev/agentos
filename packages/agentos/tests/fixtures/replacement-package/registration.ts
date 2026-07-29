import type { AgentOSRegistrationV1 } from "@akua-dev/agentos";

export const replacementRegistration: AgentOSRegistrationV1 = {
  version: 1,
  id: "@example/agentos-replacement:runtime",
  names: {
    version: 1,
    commands: ["example-ecosystem-status"],
  },
  register(pi) {
    pi.registerCommand("example-ecosystem-status", {
      description: "Inspect the replacement example",
      async handler(_arguments, context) {
        context.ui.notify("replacement example active", "info");
      },
    });
  },
};
