import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAgentOSSupervisionGuardRegistration,
  defaultAgentOSRuntime,
} from "../behaviors.ts";
import {
  buildAgentOSInstructions,
  registerAgentOSInstructions,
  type AgentOSInstructionSourceV1,
} from "../instructions.ts";
import {
  preflightAgentOSRegistrations,
  registerAgentOSRuntime,
  type AgentOSNameClaimsV1,
  type AgentOSRegistrationV1,
} from "../preflight.ts";
import {
  discoverAgentOSSkillNames,
  registerAgentOSResources,
  resolveAgentOSResources,
  type AgentOSResourcesV1,
} from "../resources.ts";
import {
  buildAgentOSStartupPrompt,
  preflightAgentOSStartup,
  registerAgentOSStartup,
  type AgentOSStartupContributionV1,
} from "../startup.ts";

export type DefaultAgentOSRole = "first_mate" | "second_mate";

export type DefaultRoleSetupV1 = {
  version: 1;
  instructions: readonly AgentOSInstructionSourceV1[];
  names: AgentOSNameClaimsV1;
  resources: AgentOSResourcesV1;
  runtime: readonly AgentOSRegistrationV1[];
  startup: {
    customType: string;
    contributions: readonly AgentOSStartupContributionV1[];
  };
};

export type DefaultAgentOSEntrypointOptions = {
  getRole?: () => string | undefined;
  loadRole?: (
    role: DefaultAgentOSRole,
  ) => Promise<DefaultRoleSetupV1>;
};

export function createDefaultAgentOSEntrypoint(
  options: DefaultAgentOSEntrypointOptions = {},
) {
  const getRole = options.getRole ?? (() => process.env.AGENTOS_AGENT_ROLE);
  const loadRole = options.loadRole ?? loadDefaultRoleSetup;

  return async function registerDefaultAgentOS(pi: ExtensionAPI): Promise<void> {
    const role = selectedRole(getRole());
    const setup = await loadRole(role);
    const startupPrompt = await preflightDefaultRoleSetup(role, setup);
    const claims = roleSetupClaims(role, setup.names);

    registerAgentOSResources(pi, setup.resources);
    registerAgentOSInstructions(pi, setup.instructions);
    await registerAgentOSRuntime(pi, [...setup.runtime, claims]);
    registerAgentOSStartup(pi, {
      customType: setup.startup.customType,
      prompt: startupPrompt,
      requiredSkills: startupSkillNames(setup),
    });
  };
}

export async function loadPackagedRoleSetup(
  role: DefaultAgentOSRole,
  directory: "firstmate" | "secondmate",
): Promise<DefaultRoleSetupV1> {
  const distributionRoot = fileURLToPath(
    new URL("../../", import.meta.url),
  );
  const instructionsPath = fileURLToPath(
    new URL(
      `../../resources/roles/${directory}/instructions.md`,
      import.meta.url,
    ),
  );
  const instructions = await readFile(instructionsPath, "utf8");
  if (!instructions.trim()) {
    throw new Error(`Required role instructions are empty: ${instructionsPath}`);
  }
  const roleSkillsPath = fileURLToPath(
    new URL(`../../resources/roles/${directory}/skills/`, import.meta.url),
  );
  const skillPaths = ["skills"];
  if (role === "first_mate") {
    try {
      await access(roleSkillsPath);
    } catch {
      throw new Error(
        `Required First-Mate Skill directory is unavailable: ${roleSkillsPath}`,
      );
    }
    skillPaths.push(`resources/roles/${directory}/skills`);
  } else {
    try {
      await access(roleSkillsPath);
      skillPaths.push(`resources/roles/${directory}/skills`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const resources = resolveAgentOSResources({
    version: 1,
    baseDirectory: distributionRoot,
    skillPaths,
  });
  const skillNames = await discoverAgentOSSkillNames(resources.skillPaths ?? []);
  if (skillNames.length === 0) {
    throw new Error(`No delivered Skills found for default AgentOS role ${role}`);
  }

  const runtime = [
    ...defaultAgentOSRuntime.filter(
      ({ id }) => id !== "@akua-dev/agentos:supervision-guard",
    ),
    createAgentOSSupervisionGuardRegistration({ startupRecovery: false }),
  ];
  const startupCustomType = `@akua-dev/agentos:${role}:startup`;
  return {
    version: 1,
    instructions: [
      {
        version: 1,
        id: `@akua-dev/agentos:${role}:identity`,
        content: instructions,
      },
    ],
    names: {
      version: 1,
      skills: skillNames,
      messages: [startupCustomType],
    },
    resources,
    runtime,
    startup: {
      customType: startupCustomType,
      contributions: [
        {
          version: 1,
          id: `@akua-dev/agentos:${role}:supervision`,
          skill: "agentos-supervision",
          instruction:
            "Reconcile this Mate's durable work, recovery hints, direct reports and required native continuity waits before accepting new work.",
        },
      ],
    },
  };
}

function selectedRole(value: string | undefined): DefaultAgentOSRole {
  if (value === "first_mate" || value === "second_mate") return value;
  throw new Error(
    "AGENTOS_AGENT_ROLE must be first_mate or second_mate before AgentOS can register",
  );
}

async function preflightDefaultRoleSetup(
  role: DefaultAgentOSRole,
  setup: DefaultRoleSetupV1,
): Promise<string> {
  if (setup.version !== 1 || setup.resources.version !== 1) {
    throw new Error(`Unsupported default AgentOS role setup for ${role}`);
  }
  buildAgentOSInstructions(setup.instructions);
  const startupPrompt = buildAgentOSStartupPrompt(
    setup.startup.contributions,
  );
  preflightAgentOSRegistrations([
    ...setup.runtime,
    roleSetupClaims(role, setup.names),
  ]);
  preflightAgentOSStartup({
    customType: setup.startup.customType,
    prompt: startupPrompt,
    requiredSkills: startupSkillNames(setup),
  });
  const declaredSkills = new Set(setup.names.skills ?? []);
  const deliveredSkills = new Set(
    await discoverAgentOSSkillNames(setup.resources.skillPaths ?? []),
  );
  for (const contribution of setup.startup.contributions) {
    if (!declaredSkills.has(contribution.skill)) {
      throw new Error(
        `startup contribution "${contribution.id}" references undeclared Skill "${contribution.skill}"`,
      );
    }
    if (!deliveredSkills.has(contribution.skill)) {
      throw new Error(
        `startup contribution "${contribution.id}" references unavailable Skill "${contribution.skill}"`,
      );
    }
  }
  for (const skill of declaredSkills) {
    if (!deliveredSkills.has(skill)) {
      throw new Error(`AgentOS skill claim "${skill}" is not delivered`);
    }
  }
  if (
    !(setup.names.messages ?? []).includes(
      setup.startup.customType,
    )
  ) {
    throw new Error(
      `startup custom message type "${setup.startup.customType}" is not declared`,
    );
  }
  return startupPrompt;
}

function startupSkillNames(
  setup: DefaultRoleSetupV1,
): string[] {
  return [
    ...new Set(
      setup.startup.contributions.map(({ skill }) => skill),
    ),
  ];
}

function roleSetupClaims(
  role: DefaultAgentOSRole,
  names: AgentOSNameClaimsV1,
): AgentOSRegistrationV1 {
  return {
    version: 1,
    id: `@akua-dev/agentos:${role}:resources`,
    names,
    register() {},
  };
}

async function loadDefaultRoleSetup(
  role: DefaultAgentOSRole,
): Promise<DefaultRoleSetupV1> {
  switch (role) {
    case "first_mate":
      return (await import("./firstmate.ts")).loadFirstMateSetup();
    case "second_mate":
      return (await import("./secondmate.ts")).loadSecondMateSetup();
  }
}
