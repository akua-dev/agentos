import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";

import {
  createAgentOSSupervisionGuardRegistration,
  defaultAgentOSRuntime,
} from "../behaviors.ts";
import {
  buildAgentOSInstructionsEffect,
  registerAgentOSInstructionsEffect,
  type AgentOSInstructionSourceV1,
} from "../instructions.ts";
import {
  preflightAgentOSRegistrationsEffect,
  registerAgentOSRuntimeEffect,
  type AgentOSNameClaimsV1,
  type AgentOSRegistrationV1,
} from "../preflight.ts";
import {
  discoverAgentOSSkillNamesEffect,
  registerAgentOSResourcesEffect,
  resolveAgentOSResourcesEffect,
  type AgentOSResourcesV1,
} from "../resources.ts";
import {
  buildAgentOSStartupPromptEffect,
  preflightAgentOSStartupEffect,
  registerAgentOSStartupEffect,
  type AgentOSStartupContributionV1,
} from "../startup.ts";
import {
  AgentOSValidationError,
  decodeOrValidationError,
  makeValidationError,
} from "../shared/errors.ts";
import {
  legacyEnvironmentConfigLayer,
  runPromiseLegacy,
} from "../shared/legacy.ts";

export const DefaultAgentOSRoleSchema = Schema.Literals([
  "first_mate",
  "second_mate",
]);
export type DefaultAgentOSRole = typeof DefaultAgentOSRoleSchema.Type;

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
  role?: string;
  loadRoleEffect?: (
    role: DefaultAgentOSRole,
  ) => Effect.Effect<
    DefaultRoleSetupV1,
    AgentOSValidationError | Config.ConfigError,
    FileSystem.FileSystem | Path.Path
  >;
  getRole?: () => string | undefined;
  loadRole?: (
    role: DefaultAgentOSRole,
  ) => Promise<DefaultRoleSetupV1>;
};

const Version1 = Schema.Literal(1);
const DefaultAgentOSRoleConfig = Config.literals(
  ["first_mate", "second_mate"],
  "AGENTOS_AGENT_ROLE",
);
const DistributionRootConfig = Config.string(
  "AGENTOS_DISTRIBUTION_ROOT",
).pipe(Config.option);
const rolePlatformLayer = Layer.merge(
  BunFileSystem.layer,
  BunPath.layer,
);

function roleLiveLayer() {
  return Layer.merge(rolePlatformLayer, legacyEnvironmentConfigLayer());
}

export const selectedDefaultAgentOSRoleEffect = DefaultAgentOSRoleConfig.pipe(
  Effect.mapError(() =>
    makeValidationError(
      "invalid_shape",
      "role_config",
      "AGENTOS_AGENT_ROLE",
      "AGENTOS_AGENT_ROLE must be first_mate or second_mate before AgentOS can register",
    ),
  ),
);

export const registerDefaultAgentOSEntrypointEffect = Effect.fn(
  "agentos.roles.registerDefaultEntrypoint",
)(function*(pi: ExtensionAPI, options: DefaultAgentOSEntrypointOptions = {}) {
  const role = yield* selectedRoleEffect(options.role, options.getRole);
  const setup = yield* loadRoleSetupEffect(
    role,
    options.loadRoleEffect,
    options.loadRole,
  );
  const startupPrompt = yield* preflightDefaultRoleSetupEffect(role, setup);
  const claims = roleSetupClaims(role, setup.names);

  yield* registerAgentOSResourcesEffect(pi, setup.resources);
  yield* registerAgentOSInstructionsEffect(pi, setup.instructions);
  yield* registerAgentOSRuntimeEffect(pi, [...setup.runtime, claims]);
  yield* registerAgentOSStartupEffect(pi, {
    customType: setup.startup.customType,
    prompt: startupPrompt,
    requiredSkills: startupSkillNames(setup),
  });
});

export function createDefaultAgentOSEntrypoint(
  options: DefaultAgentOSEntrypointOptions = {},
) {
  return function registerDefaultAgentOS(pi: ExtensionAPI): Promise<void> {
    return runPromiseLegacy(
      registerDefaultAgentOSEntrypointEffect(pi, options).pipe(
        Effect.provide(roleLiveLayer()),
      ),
    );
  };
}

export const loadPackagedRoleSetupEffect = Effect.fn(
  "agentos.roles.loadPackagedSetup",
)(function*(
  role: DefaultAgentOSRole,
  directory: "firstmate" | "secondmate",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const distributionRoot = yield* selectedDistributionRootEffect;
  const instructionsPath = path.join(
    distributionRoot,
    "resources",
    "roles",
    directory,
    "instructions.md",
  );
  const instructions = yield* fileSystem.readFileString(instructionsPath).pipe(
    Effect.mapError(() =>
      makeValidationError(
        "io_failure",
        "role_setup",
        "instructions",
        `Required role instructions are unavailable: ${instructionsPath}`,
      ),
    ),
  );
  if (!instructions.trim()) {
    return yield* makeValidationError(
      "missing_resource",
      "role_setup",
      "instructions",
      `Required role instructions are empty: ${instructionsPath}`,
    );
  }

  const roleSkillsPath = path.join(
    distributionRoot,
    "resources",
    "roles",
    directory,
    "skills",
  );
  const roleSkillsAvailable = yield* fileSystem.exists(roleSkillsPath).pipe(
    Effect.mapError(() =>
      makeValidationError(
        "io_failure",
        "role_setup",
        "skills",
        "Required role Skill directory could not be inspected",
      ),
    ),
  );
  if (role === "first_mate" && !roleSkillsAvailable) {
    return yield* makeValidationError(
      "missing_resource",
      "role_setup",
      "skills",
      `Required First-Mate Skill directory is unavailable: ${roleSkillsPath}`,
    );
  }
  const skillPaths = roleSkillsAvailable
    ? ["skills", `resources/roles/${directory}/skills`]
    : ["skills"];
  const resources = yield* resolveAgentOSResourcesEffect({
    version: 1,
    baseDirectory: distributionRoot,
    skillPaths,
  });
  const skillNames = yield* discoverAgentOSSkillNamesEffect(
    resources.skillPaths ?? [],
    distributionRoot,
  );
  if (skillNames.length === 0) {
    return yield* makeValidationError(
      "missing_resource",
      "role_setup",
      "skills",
      `No delivered Skills found for default AgentOS role ${role}`,
    );
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
  } satisfies DefaultRoleSetupV1;
});

export function loadPackagedRoleSetup(
  role: DefaultAgentOSRole,
  directory: "firstmate" | "secondmate",
): Promise<DefaultRoleSetupV1> {
  return runPromiseLegacy(
    loadPackagedRoleSetupEffect(role, directory).pipe(
      Effect.provide(roleLiveLayer()),
    ),
  );
}

const selectedDistributionRootEffect = Effect.gen(function*() {
  const configured = yield* DistributionRootConfig;
  const path = yield* Path.Path;
  if (Option.isSome(configured)) {
    const root = configured.value.trim();
    if (!root || !path.isAbsolute(root)) {
      return yield* makeValidationError(
        "invalid_shape",
        "role_config",
        "AGENTOS_DISTRIBUTION_ROOT",
        "AGENTOS_DISTRIBUTION_ROOT must be an absolute path",
      );
    }
    return root;
  }
  return yield* path.fromFileUrl(new URL("../../", import.meta.url)).pipe(
    Effect.mapError(() =>
      makeValidationError(
        "invalid_shape",
        "role_config",
        "AGENTOS_DISTRIBUTION_ROOT",
        "Default AgentOS distribution root could not be resolved",
      ),
    ),
  );
});

const selectedRoleEffect = Effect.fn("agentos.roles.select")(function*(
  role: string | undefined,
  getRole: (() => string | undefined) | undefined,
) {
  const value = role ?? (getRole === undefined
    ? yield* selectedDefaultAgentOSRoleEffect
    : yield* Effect.try({
      try: getRole,
      catch: () =>
        makeValidationError(
          "invalid_shape",
          "role_config",
          "AGENTOS_AGENT_ROLE",
          "AGENTOS_AGENT_ROLE could not be read",
        ),
    }));
  return yield* decodeOrValidationError(
    DefaultAgentOSRoleSchema,
    value,
    makeValidationError(
      "invalid_shape",
      "role_config",
      "AGENTOS_AGENT_ROLE",
      "AGENTOS_AGENT_ROLE must be first_mate or second_mate before AgentOS can register",
    ),
  );
});

const loadRoleSetupEffect = Effect.fn("agentos.roles.loadSelected")(function*(
  role: DefaultAgentOSRole,
  loadRoleEffect: DefaultAgentOSEntrypointOptions["loadRoleEffect"],
  loadRole: DefaultAgentOSEntrypointOptions["loadRole"],
) {
  if (loadRoleEffect !== undefined) return yield* loadRoleEffect(role);
  if (loadRole !== undefined) {
    return yield* Effect.tryPromise({
      try: () => loadRole(role),
      catch: () =>
        makeValidationError(
          "io_failure",
          "role_setup",
          "loadRole",
          `Default AgentOS role setup could not be loaded for ${role}`,
        ),
    });
  }
  return yield* loadPackagedRoleSetupEffect(
    role,
    role === "first_mate" ? "firstmate" : "secondmate",
  );
});

const preflightDefaultRoleSetupEffect = Effect.fn(
  "agentos.roles.preflightSetup",
)(function*(role: DefaultAgentOSRole, setup: DefaultRoleSetupV1) {
  yield* decodeOrValidationError(
    Version1,
    setup.version,
    makeValidationError(
      "unsupported_version",
      "role_setup",
      "version",
      `Unsupported default AgentOS role setup for ${role}`,
    ),
  );
  yield* buildAgentOSInstructionsEffect(setup.instructions);
  const startupPrompt = yield* buildAgentOSStartupPromptEffect(
    setup.startup.contributions,
  );
  yield* preflightAgentOSRegistrationsEffect([
    ...setup.runtime,
    roleSetupClaims(role, setup.names),
  ]);
  yield* preflightAgentOSStartupEffect({
    customType: setup.startup.customType,
    prompt: startupPrompt,
    requiredSkills: startupSkillNames(setup),
  });
  const declaredSkills = new Set(setup.names.skills ?? []);
  const deliveredSkills = new Set(
    yield* discoverAgentOSSkillNamesEffect(
      setup.resources.skillPaths ?? [],
      ".",
    ),
  );
  for (const contribution of setup.startup.contributions) {
    if (!declaredSkills.has(contribution.skill)) {
      return yield* makeValidationError(
        "missing_resource",
        "role_setup",
        "startup.contributions.skill",
        `startup contribution "${contribution.id}" references undeclared Skill "${contribution.skill}"`,
      );
    }
    if (!deliveredSkills.has(contribution.skill)) {
      return yield* makeValidationError(
        "missing_resource",
        "role_setup",
        "startup.contributions.skill",
        `startup contribution "${contribution.id}" references unavailable Skill "${contribution.skill}"`,
      );
    }
  }
  for (const skill of declaredSkills) {
    if (!deliveredSkills.has(skill)) {
      return yield* makeValidationError(
        "missing_resource",
        "role_setup",
        "names.skills",
        `AgentOS skill claim "${skill}" is not delivered`,
      );
    }
  }
  if (!(setup.names.messages ?? []).includes(setup.startup.customType)) {
    return yield* makeValidationError(
      "invalid_shape",
      "role_setup",
      "startup.customType",
      `startup custom message type "${setup.startup.customType}" is not declared`,
    );
  }
  return startupPrompt;
});

function startupSkillNames(setup: DefaultRoleSetupV1): string[] {
  return [...new Set(setup.startup.contributions.map(({ skill }) => skill))];
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
