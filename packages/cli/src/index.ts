import { AxiError, runAxiCli } from "axi-sdk-js";
import packageMetadata from "../package.json" with { type: "json" };

const description = "Inspect and operate deterministic AgentOS fleet primitives";

const topLevelHelp = `AgentOS fleet primitives

Usage:
  agentos
  agentos update --check
  agentos --help

Commands:
  update --check  Report the immutable release that owns this installation
`;

const updateHelp = `AgentOS release update

Usage:
  agentos update --check

AgentOS never updates itself through a global package manager. Installations are
reconciled from a reviewed immutable AgentOS release.
`;

function releaseUpdate(args: string[]) {
  if (args.length === 1 && args[0] === "--check") {
    return {
      update: {
        managed_by: "AgentOS immutable release",
        current: packageMetadata.version,
        available: "release metadata not configured",
      },
      help: ["Select and approve a reviewed AgentOS release before upgrading"],
    };
  }

  if (args.length === 0) {
    throw new AxiError(
      "AgentOS does not perform an unpinned self-update",
      "RELEASE_REQUIRED",
      ["Run `agentos update --check` to inspect the installed release"],
    );
  }

  throw new AxiError("Unknown update arguments", "VALIDATION_ERROR", [
    "Run `agentos update --help`",
  ]);
}

export async function run(args: string[]): Promise<number> {
  process.exitCode = 0;

  await runAxiCli({
    argv: args,
    commands: { update: releaseUpdate },
    description,
    getCommandHelp: (command) =>
      command === "update" ? updateHelp : undefined,
    home: () => ({
      release: packageMetadata.version,
      implementation: "skeleton",
      help: [
        "Run `agentos --help` to inspect implemented commands",
        "Run `agentos update --check` to inspect release ownership",
      ],
    }),
    topLevelHelp,
    version: packageMetadata.version,
  });

  return process.exitCode ?? 0;
}
