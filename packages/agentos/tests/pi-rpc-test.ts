import { Config, Effect, FileSystem, Path, Schema } from "effect";

import { runTestProcess } from "./test-process.ts";

const PiPackageSetting = Schema.Union([
  Schema.String,
  Schema.Struct({
    source: Schema.String,
    autoload: Schema.optional(Schema.Boolean),
    extensions: Schema.optional(Schema.Array(Schema.String)),
    skills: Schema.optional(Schema.Array(Schema.String)),
  }),
]);
export type PiPackageSetting = typeof PiPackageSetting.Type;

const PiSettings = Schema.Struct({
  packages: Schema.Array(PiPackageSetting),
});
const PiRpcRequest = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
});
const PiRpcResponse = Schema.Struct({
  id: Schema.String,
  success: Schema.Boolean,
  data: Schema.Struct({
    commands: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
});
const PiRpcEnvelope = Schema.Struct({
  id: Schema.optional(Schema.String),
  success: Schema.optional(Schema.Boolean),
  data: Schema.optional(Schema.Unknown),
});

export class PiRpcTestError extends Schema.TaggedErrorClass<PiRpcTestError>()(
  "PiRpcTestError",
  {
    operation: Schema.Literals(["process", "response"]),
    detail: Schema.String,
    exitCode: Schema.optional(Schema.Number),
  },
) {}

function rpcError(
  operation: typeof PiRpcTestError.fields.operation.Type,
  detail: string,
  exitCode?: number,
) {
  return PiRpcTestError.make({ operation, detail, exitCode });
}

export interface PiCommandNamesOptions {
  readonly agentDirectory: string;
  readonly cwd: string;
  readonly packages?: ReadonlyArray<PiPackageSetting>;
  readonly role: "first_mate" | "second_mate";
}

export const piCommandNames = Effect.fn("test.piRpc.commandNames")(function*(
  options: PiCommandNamesOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  if (options.packages !== undefined) {
    const settingsDirectory = paths.join(options.cwd, ".pi");
    yield* fileSystem.makeDirectory(settingsDirectory, { recursive: true });
    const settings = yield* Schema.encodeEffect(
      Schema.fromJsonString(PiSettings),
    )({ packages: options.packages });
    yield* fileSystem.writeFileString(
      paths.join(settingsDirectory, "settings.json"),
      `${settings}\n`,
    );
  }
  const executablePath = yield* Config.string("PATH");
  const request = yield* Schema.encodeEffect(
    Schema.fromJsonString(PiRpcRequest),
  )({ id: "commands", type: "get_commands" });
  const result = yield* runTestProcess(
    "pi",
    [
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-context-files",
      "--approve",
    ],
    {
      cwd: options.cwd,
      env: {
        AGENTOS_AGENT_ROLE: options.role,
        HOME: options.agentDirectory,
        PATH: executablePath,
        PI_CODING_AGENT_DIR: options.agentDirectory,
      },
      stdin: `${request}\n`,
    },
  );
  if (result.exitCode !== 0) {
    return yield* rpcError(
      "process",
      "Pi RPC exited unsuccessfully; stdout and stderr are redacted",
      result.exitCode,
    );
  }
  const responses = yield* Effect.forEach(
    result.stdout.trim().split("\n").filter((line) => line.length > 0),
    (line) => Schema.decodeUnknownEffect(Schema.fromJsonString(PiRpcEnvelope))(line),
  ).pipe(
    Effect.mapError(() => rpcError("response", "Pi RPC returned invalid JSON")),
  );
  const rawResponse = responses.find(({ id }) => id === "commands");
  if (rawResponse === undefined) {
    return yield* rpcError("response", "Pi RPC returned no command catalog");
  }
  const response = yield* Schema.decodeUnknownEffect(PiRpcResponse)(rawResponse).pipe(
    Effect.mapError(() => rpcError("response", "Pi RPC command catalog was invalid")),
  );
  if (!response.success) {
    return yield* rpcError("response", "Pi RPC command catalog was unsuccessful");
  }
  return response.data.commands.map(({ name }) => name);
});
