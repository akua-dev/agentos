import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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
  const names = new Set<string>();
  for (const path of paths) {
    const resolved = resolve(path);
    let stats;
    try {
      stats = await stat(resolved);
    } catch {
      throw new Error(`AgentOS skill resource path is unavailable: ${resolved}`);
    }
    const files = stats.isDirectory()
      ? await discoverSkillFiles(resolved)
      : resolved.endsWith(".md")
        ? [resolved]
        : [];
    for (const file of files) {
      names.add(await readSkillName(file));
    }
  }
  return [...names].sort();
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

async function discoverSkillFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const skillFile = entries.find(
    (entry) => entry.isFile() && entry.name === "SKILL.md",
  );
  if (skillFile) return [join(directory, skillFile.name)];

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await discoverSkillFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

async function readSkillName(path: string): Promise<string> {
  const content = await readFile(path, "utf8");
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const frontmatter = match?.[1];
  if (frontmatter === undefined) return basename(dirname(path));
  const metadata = parse(frontmatter);
  return typeof metadata?.name === "string" && metadata.name.trim()
    ? metadata.name
    : basename(dirname(path));
}
