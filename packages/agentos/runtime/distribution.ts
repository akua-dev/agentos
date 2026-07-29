import { isAbsolute, join } from "node:path";

export type PersistentMateRole = "first_mate" | "second_mate";

export type PersistentMateDistribution = {
  distributionRoot: string;
  role: PersistentMateRole;
  roleDirectory: string;
};

const roleDirectories: Record<PersistentMateRole, string> = {
  first_mate: "firstmate",
  second_mate: "secondmate",
};

export function isPersistentMateRole(
  role: string,
): role is PersistentMateRole {
  return role in roleDirectories;
}

export function resolvePersistentMateDistribution(
  environment: NodeJS.ProcessEnv,
): PersistentMateDistribution {
  const role = requiredEnvironment(environment, "AGENTOS_AGENT_ROLE");
  if (!isPersistentMateRole(role)) {
    throw new Error(
      `AGENTOS_AGENT_ROLE must select first_mate or second_mate, received ${role}`,
    );
  }

  const distributionRoot = requiredAbsoluteDirectory(
    environment,
    "AGENTOS_DISTRIBUTION_ROOT",
  );
  const agentCwd = requiredAbsoluteDirectory(
    environment,
    "AGENTOS_AGENT_CWD",
  );
  const roleDirectory = join(
    distributionRoot,
    "resources",
    "roles",
    roleDirectories[role],
  );
  if (agentCwd !== roleDirectory) {
    throw new Error(`AGENTOS_AGENT_CWD must equal ${roleDirectory}`);
  }

  return { distributionRoot, role, roleDirectory };
}

function requiredAbsoluteDirectory(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = withoutTrailingSlash(requiredEnvironment(environment, name));
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} must be explicitly configured`);
  return value;
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}
