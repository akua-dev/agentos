import {
  defineAgentOSPiExtension,
  registerAgentOSRuntimeEffect,
} from "@akua-dev/agentos";

import { additiveRegistration } from "../registration.ts";

export default defineAgentOSPiExtension((pi) =>
  registerAgentOSRuntimeEffect(pi, [additiveRegistration])
);
