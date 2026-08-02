import type { AgentOSRegistrationV1 } from "../src/preflight.ts";
import { Effect } from "effect";
import type {
  DefaultAgentOSRole,
  DefaultRoleSetupV1,
} from "../src/roles/default.ts";

export function roleSetupFixture(
  role: DefaultAgentOSRole,
  supervisionSkillPath: string,
): DefaultRoleSetupV1 {
  const runtime: AgentOSRegistrationV1 = {
    version: 1,
    id: `@example/${role}:runtime`,
    names: { version: 1, commands: [`example-${role}`] },
    register(pi) {
      return Effect.sync(() => pi.on("session_start", () => undefined));
    },
  };
  return {
    version: 1,
    instructions: [
      {
        version: 1,
        id: `@example/${role}:instructions`,
        content: `${role} identity`,
      },
    ],
    names: {
      version: 1,
      skills: ["agentos-supervision"],
      messages: [`@example/${role}:startup`],
    },
    resources: {
      version: 1,
      skillPaths: [supervisionSkillPath],
    },
    runtime: [runtime],
    startup: {
      customType: `@example/${role}:startup`,
      contributions: [
        {
          version: 1,
          id: `@example/${role}:startup`,
          skill: "agentos-supervision",
          instruction: `Reconcile ${role}.`,
        },
      ],
    },
  };
}
