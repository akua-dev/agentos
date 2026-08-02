import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import {
  Effect,
  FileSystem,
  Path,
  Schema,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

const RpcCommand = Schema.Struct({
  name: Schema.String,
  source: Schema.String,
});
const RpcResponse = Schema.Struct({
  data: Schema.Struct({ commands: Schema.Array(RpcCommand) }),
  id: Schema.Literal("commands"),
  success: Schema.Literal(true),
});

function discoveredCommands(role: "firstmate" | "secondmate") {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    const agentDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: `agentos-pi-${role}-`,
    });
    const pi = paths.resolve("node_modules/.bin/pi");
    const command = ChildProcess.make(pi, [
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--approve",
    ], {
      cwd: paths.resolve(`packages/agentos/resources/roles/${role}`),
      env: {
        AGENTOS_AGENT_NAME: role,
        AGENTOS_AGENT_ROLE:
          role === "firstmate" ? "first_mate" : "second_mate",
        HERDR_SESSION: `agentos-${role}`,
        PI_CODING_AGENT_DIR: agentDirectory,
      },
      extendEnv: true,
      stdin: {
        endOnDone: true,
        stream: Stream.succeed(
          new TextEncoder().encode('{"id":"commands","type":"get_commands"}\n'),
        ),
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const output = yield* spawner.string(command, { includeStderr: true });
    const candidates = output.trim().split("\n").map((line) =>
      Schema.decodeUnknownOption(Schema.fromJsonString(RpcResponse))(line)
    );
    const response = candidates.find((candidate) => candidate._tag === "Some");
    return response === undefined
      ? yield* Effect.die(`Pi returned no commands for ${role}: ${output}`)
      : response.value.data.commands;
  });
}

describe("Pi distribution background task discovery", () => {
  layer(BunServices.layer)((it) => {
    for (const role of ["firstmate", "secondmate"] satisfies ReadonlyArray<
      "firstmate" | "secondmate"
    >) {
      it.effect(`${role} loads the packaged AgentOS background task behavior`, () =>
        Effect.scoped(Effect.gen(function*() {
          const commands = yield* discoveredCommands(role);
          assert.isTrue(commands.some((command) =>
            command.name === "background-commands" &&
            command.source === "extension"
          ));
        })));
    }
  });
});
