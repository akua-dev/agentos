import {
  loadSkills,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Effect, Path, Schema } from "effect";

import {
  AgentOSResourceInputV1Schema,
  AgentOSResourcesV1Schema,
  type AgentOSResourceInputV1,
  type AgentOSResourcesV1,
} from "./shared/contracts.ts";
import {
  decodeOrValidationError,
  makeValidationError,
} from "./shared/errors.ts";

export type {
  AgentOSResourceInputV1,
  AgentOSResourcesV1,
} from "./shared/contracts.ts";

const Version1 = Schema.Literal(1);

export const discoverAgentOSSkillNamesEffect = Effect.fn(
  "agentos.resources.discoverSkillNames",
)(function*(paths: readonly string[], workingDirectory: string) {
  const pathService = yield* Path.Path;
  const result = yield* Effect.try({
    try: () =>
      loadSkills({
        cwd: workingDirectory,
        agentDir: workingDirectory,
        skillPaths: paths.map((path) => pathService.resolve(path)),
        includeDefaults: false,
      }),
    catch: () =>
      makeValidationError(
        "invalid_shape",
        "resources",
        "skillPaths",
        "AgentOS Skill resources could not be loaded",
      ),
  });
  if (result.diagnostics.length > 0) {
    return yield* makeValidationError(
      "invalid_shape",
      "resources",
      "skillPaths",
      safeSkillDiagnosticMessage(result.diagnostics),
    );
  }
  return result.skills.map(({ name }) => name).sort();
});

export const resolveAgentOSResourcesEffect = Effect.fn(
  "agentos.resources.resolve",
)(function*(input: AgentOSResourceInputV1) {
  const pathService = yield* Path.Path;
  yield* decodeOrValidationError(
    AgentOSResourceInputV1Schema,
    input,
    makeValidationError(
      "invalid_shape",
      "resources",
      "input",
      "Invalid AgentOS resources input",
    ),
  );
  const baseDirectory = pathService.resolve(input.baseDirectory);
  return {
    version: 1,
    skillPaths: yield* resolveContainedPathsEffect(
      pathService,
      baseDirectory,
      input.skillPaths,
      "skill",
      "skillPaths",
    ),
    promptPaths: yield* resolveContainedPathsEffect(
      pathService,
      baseDirectory,
      input.promptPaths,
      "prompt",
      "promptPaths",
    ),
    themePaths: yield* resolveContainedPathsEffect(
      pathService,
      baseDirectory,
      input.themePaths,
      "theme",
      "themePaths",
    ),
  } satisfies AgentOSResourcesV1;
});

export const registerAgentOSResourcesEffect = Effect.fn(
  "agentos.resources.register",
)(function*(pi: ExtensionAPI, resources: AgentOSResourcesV1) {
  const decoded = yield* decodeOrValidationError(
    AgentOSResourcesV1Schema,
    resources,
    makeValidationError(
      "unsupported_version",
      "resources",
      "version",
      "unsupported AgentOS resources version",
    ),
  );
  const result = compactResources(decoded);
  if (Object.keys(result).length === 0) return;
  yield* Effect.sync(() => {
    pi.on("resources_discover", () => result);
  });
});

const resolveContainedPathsEffect = Effect.fn(
  "agentos.resources.resolveContainedPaths",
)(function*(
  pathService: Path.Path,
  baseDirectory: string,
  paths: readonly string[] | undefined,
  kind: string,
  field: string,
) {
  if (!paths) return undefined;
  const resolvedPaths: string[] = [];
  for (const path of paths) {
    const decodedPath = yield* decodeOrValidationError(
      Schema.NonEmptyString,
      path,
      makeValidationError(
        "invalid_shape",
        "resources",
        field,
        `AgentOS ${kind} path must not be empty`,
      ),
    );
    const resolved = pathService.resolve(baseDirectory, decodedPath);
    const contained = pathService.relative(baseDirectory, resolved);
    if (
      contained === ".." ||
      contained.startsWith(`..${pathService.sep}`) ||
      pathService.isAbsolute(contained)
    ) {
      return yield* makeValidationError(
        "invalid_shape",
        "resources",
        field,
        `AgentOS ${kind} path escapes the distribution resource root`,
      );
    }
    resolvedPaths.push(resolved);
  }
  return resolvedPaths;
});

function compactResources(resources: AgentOSResourcesV1) {
  return {
    ...(resources.skillPaths?.length
      ? { skillPaths: [...resources.skillPaths] }
      : {}),
    ...(resources.promptPaths?.length
      ? { promptPaths: [...resources.promptPaths] }
      : {}),
    ...(resources.themePaths?.length
      ? { themePaths: [...resources.themePaths] }
      : {}),
  };
}

function safeSkillDiagnosticMessage(
  diagnostics: ReadonlyArray<{ readonly message: string }>,
): string {
  const messages = diagnostics.map(({ message }) => message);
  if (messages.some((message) => message.includes("description is required"))) {
    return "AgentOS Skill resources are not compatible with Pi: description is required";
  }
  for (const message of messages) {
    const collision = message.match(/name "([a-z0-9]+(?:-[a-z0-9]+)*)" collision/);
    const skillName = collision?.[1];
    if (skillName !== undefined) {
      return `AgentOS Skill resources are not compatible with Pi: name "${skillName}" collision`;
    }
  }
  return "AgentOS Skill resources are not compatible with Pi: resource validation failed";
}
