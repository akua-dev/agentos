import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  composeAgentOSInstructions,
  composeAgentOSStartupPrompt,
  createAgentOSSupervisionGuardRegistration,
  defaultAgentOSRuntime,
  preflightAgentOSComposition,
  registerAgentOSInstructions,
  registerAgentOSResources,
  registerAgentOSRuntime,
  registerAgentOSStartup,
  resolveAgentOSResources,
  type AgentOSInstructionSourceV1,
  type AgentOSNameClaimsV1,
  type AgentOSRegistrationV1,
  type AgentOSResourcesV1,
  type AgentOSStartupContributionV1,
} from "@agentos/pi";

export type DefaultAgentOSRole = "first_mate" | "second_mate";

export type DefaultRoleCompositionV1 = {
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
  ) => Promise<DefaultRoleCompositionV1>;
};

export const defaultSharedSkillNames = Object.freeze([
  "agentos-ai-gateway",
  "agentos-artifact-fs",
  "agentos-auth",
  "agentos-composition",
  "agentos-customization",
  "agentos-database",
  "agentos-decisions",
  "agentos-delegation",
  "agentos-diagnostics",
  "agentos-harnesses",
  "agentos-image-builds",
  "agentos-memory",
  "agentos-projects",
  "agentos-registry",
  "agentos-runtime",
  "agentos-supervision",
]);

export function createDefaultAgentOSEntrypoint(
  options: DefaultAgentOSEntrypointOptions = {},
) {
  const getRole = options.getRole ?? (() => process.env.AGENTOS_AGENT_ROLE);
  const loadRole = options.loadRole ?? loadDefaultRoleComposition;

  return async function registerDefaultAgentOS(pi: ExtensionAPI): Promise<void> {
    const role = selectedRole(getRole());
    const composition = await loadRole(role);
    const startupPrompt = preflightDefaultRoleComposition(role, composition);
    const claims = compositionClaims(role, composition.names);

    registerAgentOSResources(pi, composition.resources);
    registerAgentOSInstructions(pi, composition.instructions);
    await registerAgentOSRuntime(pi, [...composition.runtime, claims]);
    registerAgentOSStartup(pi, {
      customType: composition.startup.customType,
      prompt: startupPrompt,
    });
  };
}

export async function loadPackagedRoleComposition(
  role: DefaultAgentOSRole,
  directory: "firstmate" | "secondmate",
  roleSkillNames: readonly string[],
): Promise<DefaultRoleCompositionV1> {
  const roleRoot = fileURLToPath(
    new URL(`../resources/roles/${directory}/`, import.meta.url),
  );
  const instructionsPath = fileURLToPath(
    new URL(`../resources/roles/${directory}/instructions.md`, import.meta.url),
  );
  const instructions = await readFile(instructionsPath, "utf8");
  if (!instructions.trim()) {
    throw new Error(`Required role instructions are empty: ${instructionsPath}`);
  }
  const roleSkillPaths = roleSkillNames.length > 0 ? ["skills"] : [];
  for (const path of roleSkillPaths) {
    await access(
      fileURLToPath(
        new URL(`../resources/roles/${directory}/${path}/`, import.meta.url),
      ),
    );
  }

  const runtime = [
    ...defaultAgentOSRuntime.filter(
      ({ id }) => id !== "@agentos/pi:supervision-guard",
    ),
    createAgentOSSupervisionGuardRegistration({ startupRecovery: false }),
  ];
  const startupCustomType = `@agentos/default:${role}:startup`;
  return {
    version: 1,
    instructions: [
      {
        version: 1,
        id: `@agentos/default:${role}:identity`,
        content: instructions,
      },
    ],
    names: {
      version: 1,
      skills: [...defaultSharedSkillNames, ...roleSkillNames],
      messages: [startupCustomType],
    },
    resources: resolveAgentOSResources({
      version: 1,
      baseDirectory: roleRoot,
      skillPaths: roleSkillPaths,
    }),
    runtime,
    startup: {
      customType: startupCustomType,
      contributions: [
        {
          version: 1,
          id: `@agentos/default:${role}:supervision`,
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

function preflightDefaultRoleComposition(
  role: DefaultAgentOSRole,
  composition: DefaultRoleCompositionV1,
): string {
  if (composition.version !== 1 || composition.resources.version !== 1) {
    throw new Error(`Unsupported default AgentOS composition for ${role}`);
  }
  composeAgentOSInstructions(composition.instructions);
  const startupPrompt = composeAgentOSStartupPrompt(
    composition.startup.contributions,
  );
  preflightAgentOSComposition([
    ...composition.runtime,
    compositionClaims(role, composition.names),
  ]);
  return startupPrompt;
}

function compositionClaims(
  role: DefaultAgentOSRole,
  names: AgentOSNameClaimsV1,
): AgentOSRegistrationV1 {
  return {
    version: 1,
    id: `@agentos/default:${role}:resources`,
    names,
    register() {},
  };
}

async function loadDefaultRoleComposition(
  role: DefaultAgentOSRole,
): Promise<DefaultRoleCompositionV1> {
  switch (role) {
    case "first_mate":
      return (await import("./firstmate.ts")).loadFirstMateComposition();
    case "second_mate":
      return (await import("./secondmate.ts")).loadSecondMateComposition();
  }
}
