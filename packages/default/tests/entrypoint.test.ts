import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

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
      skills: ["agentos-supervision"],
      messages: [`@example/${role}:startup`],
    },
    resources: {
      version: 1,
      skillPaths: [
        resolve(import.meta.dir, "..", "skills", "agentos-supervision", "SKILL.md"),
      ],
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

  test("fails closed when a startup Skill is not delivered", async () => {
    const fake = createFakePi();
    const composition = roleComposition("first_mate");
    const entrypoint = createDefaultAgentOSEntrypoint({
      getRole: () => "first_mate",
      loadRole: async () => ({
        ...composition,
        names: { ...composition.names, skills: ["missing-startup"] },
        resources: { version: 1 },
        startup: {
          ...composition.startup,
          contributions: composition.startup.contributions.map((contribution) => ({
            ...contribution,
            skill: "missing-startup",
          })),
        },
      }),
    });

    await expect(entrypoint(fake.pi)).rejects.toThrow(
      'startup contribution "@example/first_mate:startup" references unavailable Skill "missing-startup"',
    );
    expect(fake.registrations).toEqual([]);
  });

  test("fails closed when startup emits an undeclared message type", async () => {
    const fake = createFakePi();
    const composition = roleComposition("first_mate");
    const entrypoint = createDefaultAgentOSEntrypoint({
      getRole: () => "first_mate",
      loadRole: async () => ({
        ...composition,
        startup: {
          ...composition.startup,
          customType: "@example/first_mate:unclaimed-startup",
        },
      }),
    });

    await expect(entrypoint(fake.pi)).rejects.toThrow(
      'startup custom message type "@example/first_mate:unclaimed-startup" is not declared',
    );
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
