import { registerAgentOSRuntime } from "@agentos/pi";

import { additiveRegistration } from "../registration.ts";

export default function registerAdditiveAgentOS(
  pi: Parameters<typeof registerAgentOSRuntime>[0],
) {
  return registerAgentOSRuntime(pi, [additiveRegistration]);
}
