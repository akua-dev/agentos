import {
  loadSkills,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve } from "node:path";

export type AgentOSResourceInputV1 = {
  version: 1;
  baseDirectory: string;
  skillPaths?: readonly string[];
  promptPaths?: readonly string[];
  themePaths?: readonly string[];
};

export type AgentOSResourcesV1 = {
  version: 1;
  skillPaths?: readonly string[];
  promptPaths?: readonly string[];
  themePaths?: readonly string[];
};

export async function discoverAgentOSSkillNames(
  paths: readonly string[],
): Promise<string[]> {
  const result = loadSkills({
    cwd: process.cwd(),
    agentDir: process.cwd(),
    skillPaths: paths.map((path) => resolve(path)),
    includeDefaults: false,
  });
  if (result.diagnostics.length > 0) {
    throw new Error(
      [
        "AgentOS Skill resources are not compatible with Pi:",
        ...result.diagnostics.map(
          (diagnostic) =>
            `${diagnostic.path}: ${diagnostic.message}`,
        ),
      ].join("\n"),
    );
  }
  return result.skills.map(({ name }) => name).sort();
}

export function resolveAgentOSResources(
  input: AgentOSResourceInputV1,
): AgentOSResourcesV1 {
  if (input.version !== 1) {
    throw new Error("unsupported AgentOS resources version");
  }
  const baseDirectory = resolve(input.baseDirectory);
  return {
    version: 1,
    skillPaths: resolveContainedPaths(
      baseDirectory,
      input.skillPaths,
      "skill",
    ),
    promptPaths: resolveContainedPaths(
      baseDirectory,
      input.promptPaths,
      "prompt",
    ),
    themePaths: resolveContainedPaths(
      baseDirectory,
      input.themePaths,
      "theme",
    ),
  };
}

export function registerAgentOSResources(
  pi: ExtensionAPI,
  resources: AgentOSResourcesV1,
): void {
  if (resources.version !== 1) {
    throw new Error("unsupported AgentOS resources version");
  }
  const result = compactResources(resources);
  if (Object.keys(result).length === 0) return;
  pi.on("resources_discover", () => result);
}

function resolveContainedPaths(
  baseDirectory: string,
  paths: readonly string[] | undefined,
  kind: string,
): string[] | undefined {
  if (!paths) return undefined;
  return paths.map((path) => {
    if (typeof path !== "string" || !path) {
      throw new Error(`AgentOS ${kind} path must not be empty`);
    }
    const resolved = resolve(baseDirectory, path);
    const contained = relative(baseDirectory, resolved);
    if (
      contained === ".." ||
      contained.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(contained)
    ) {
      throw new Error(
        `AgentOS ${kind} path "${path}" escapes the distribution resource root`,
      );
    }
    return resolved;
  });
}

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
