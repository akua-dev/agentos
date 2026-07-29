import { afterEach, describe, expect, test } from "bun:test";

import {
  createDefaultAgentOSEntrypoint,
  type DefaultRoleCompositionV1,
} from "../composition/shared.ts";
import type { AgentOSRegistrationV1 } from "@agentos/pi";
import { createFakePi } from "../../pi/tests/fake-pi.ts";

const originalRole = process.env.AGENTOS_AGENT_ROLE;

afterEach(() => {
  if (originalRole === undefined) delete process.env.AGENTOS_AGENT_ROLE;
  else process.env.AGENTOS_AGENT_ROLE = originalRole;
});

function roleComposition(role: "first_mate" | "second_mate"): DefaultRoleCompositionV1 {
  const roleName = role.replace("_", "-");
  const runtime: AgentOSRegistrationV1 = {
    version: 1,
    id: `@example/${role}:runtime`,
    names: { version: 1, commands: [`example-${role}`] },
    register(pi) {
      pi.registerCommand(`example-${role}`, {
        description: role,
        async handler() {},
      });
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
      skills: [`example-${roleName}-startup`],
      messages: [`@example/${role}:startup`],
    },
    resources: { version: 1 },
    runtime: [runtime],
    startup: {
      customType: `@example/${role}:startup`,
      contributions: [
        {
          version: 1,
          id: `@example/${role}:startup`,
          skill: `example-${roleName}-startup`,
          instruction: `Reconcile ${role}.`,
        },
      ],
    },
  };
}

describe("default AgentOS entrypoint", () => {
  test("fails closed on a missing role before loading resources", async () => {
    delete process.env.AGENTOS_AGENT_ROLE;
    const fake = createFakePi();
    let loads = 0;
    const entrypoint = createDefaultAgentOSEntrypoint({
      loadRole: async () => {
        loads += 1;
        return roleComposition("first_mate");
      },
    });

    await expect(entrypoint(fake.pi)).rejects.toThrow(
      "AGENTOS_AGENT_ROLE must be first_mate or second_mate",
    );
    expect(loads).toBe(0);
    expect(fake.registrations).toEqual([]);
  });

  test("fails closed on an unknown role before loading resources", async () => {
    process.env.AGENTOS_AGENT_ROLE = "captain";
    const fake = createFakePi();
    let loads = 0;
    const entrypoint = createDefaultAgentOSEntrypoint({
      loadRole: async () => {
        loads += 1;
        return roleComposition("first_mate");
      },
    });

    await expect(entrypoint(fake.pi)).rejects.toThrow(
      "AGENTOS_AGENT_ROLE must be first_mate or second_mate",
    );
    expect(loads).toBe(0);
    expect(fake.registrations).toEqual([]);
  });

  for (const role of ["first_mate", "second_mate"] as const) {
    test(`selects only the ${role} ordinary composition`, async () => {
      process.env.AGENTOS_AGENT_ROLE = role;
      const fake = createFakePi();
      const loaded: string[] = [];
      const entrypoint = createDefaultAgentOSEntrypoint({
        loadRole: async (selected) => {
          loaded.push(selected);
          return roleComposition(selected);
        },
      });

      await entrypoint(fake.pi);

      expect(loaded).toEqual([role]);
      expect(
        fake.registrations
          .filter(({ kind }) => kind === "command")
          .map(({ name }) => name),
      ).toEqual([`example-${role}`]);
    });
  }
});

export { roleComposition };
