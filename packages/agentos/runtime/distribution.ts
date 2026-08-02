import { Effect, Path, Schema } from "effect";

export type DistributionEnvironment = Readonly<
  Record<string, string | undefined>
>;
export type PersistentMateRole = "first_mate" | "second_mate";

export type PersistentMateDistribution = {
  readonly distributionRoot: string;
  readonly role: PersistentMateRole;
  readonly roleDirectory: string;
};

export class PersistentMateDistributionError extends Schema.TaggedErrorClass<PersistentMateDistributionError>()(
  "PersistentMateDistributionError",
  {
    message: Schema.String,
    variable: Schema.String,
  },
) {}

const roleDirectories: Readonly<Record<PersistentMateRole, string>> = {
  first_mate: "firstmate",
  second_mate: "secondmate",
};

export function isPersistentMateRole(
  role: string,
): role is PersistentMateRole {
  return role === "first_mate" || role === "second_mate";
}

export const resolvePersistentMateDistribution = Effect.fn(
  "agentos.distribution.resolve",
)(function*(environment: DistributionEnvironment) {
  const paths = yield* Path.Path;
  const role = yield* requiredEnvironment(environment, "AGENTOS_AGENT_ROLE");
  if (!isPersistentMateRole(role)) {
    return yield* PersistentMateDistributionError.make({
      message: `AGENTOS_AGENT_ROLE must select first_mate or second_mate, received ${role}`,
      variable: "AGENTOS_AGENT_ROLE",
    });
  }

  const distributionRoot = yield* requiredAbsoluteDirectory(
    paths,
    environment,
    "AGENTOS_DISTRIBUTION_ROOT",
  );
  const agentCwd = yield* requiredAbsoluteDirectory(
    paths,
    environment,
    "AGENTOS_AGENT_CWD",
  );
  const roleDirectory = paths.join(
    distributionRoot,
    "resources",
    "roles",
    roleDirectories[role],
  );
  if (agentCwd !== roleDirectory) {
    return yield* PersistentMateDistributionError.make({
      message: `AGENTOS_AGENT_CWD must equal ${roleDirectory}`,
      variable: "AGENTOS_AGENT_CWD",
    });
  }

  return { distributionRoot, role, roleDirectory } satisfies PersistentMateDistribution;
});

function requiredAbsoluteDirectory(
  paths: Path.Path,
  environment: DistributionEnvironment,
  name: string,
) {
  return Effect.gen(function*() {
    const value = withoutTrailingSlash(
      yield* requiredEnvironment(environment, name),
    );
    if (!paths.isAbsolute(value)) {
      return yield* PersistentMateDistributionError.make({
        message: `${name} must be an absolute path`,
        variable: name,
      });
    }
    return value;
  });
}

function requiredEnvironment(
  environment: DistributionEnvironment,
  name: string,
) {
  const value = environment[name]?.trim();
  return value
    ? Effect.succeed(value)
    : Effect.fail(
      PersistentMateDistributionError.make({
        message: `${name} must be explicitly configured`,
        variable: name,
      }),
    );
}

function withoutTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}
