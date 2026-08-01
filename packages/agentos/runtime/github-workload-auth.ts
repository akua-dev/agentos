import {
  Context,
  Effect,
  FileSystem,
  Path,
  Schema,
} from "effect";
import { ChildProcess } from "effect/unstable/process";

const TokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_BYTES = 16 * 1_024;
const MAX_CREDENTIAL_INPUT_BYTES = 16 * 1_024;

const GitHubWorkloadClientErrorCode = Schema.Literals([
  "invalid_configuration",
  "invalid_credential_request",
  "invalid_projected_token",
  "native_client_unavailable",
]);

export class GitHubWorkloadClientError extends Schema.TaggedErrorClass<
  GitHubWorkloadClientError
>()("GitHubWorkloadClientError", {
  code: GitHubWorkloadClientErrorCode,
}) {}

export interface GitHubWorkloadClientConfiguration {
  readonly caFile: string;
  readonly ghAxiBinary?: string;
  readonly ghBinary?: string;
  readonly home: string;
  readonly host: string;
  readonly tokenFile: string;
}

export class GitHubWorkloadClientIo extends Context.Service<
  GitHubWorkloadClientIo,
  {
    readonly readInput: Effect.Effect<string, GitHubWorkloadClientError>;
    readonly writeOutput: (
      value: string,
    ) => Effect.Effect<void, GitHubWorkloadClientError>;
  }
>()("agentos/runtime/GitHubWorkloadClientIo") {}

export const readGitHubWorkloadToken = Effect.fn(
  "agentos.githubWorkloadAuth.readToken",
)(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const metadata = yield* fileSystem.stat(path).pipe(
    Effect.mapError(() => clientError("invalid_projected_token")),
  );
  if (
    metadata.type !== "File" || metadata.size <= FileSystem.Size(0) ||
    metadata.size > FileSystem.Size(MAX_TOKEN_BYTES) ||
    (metadata.mode & 0o022) !== 0
  ) {
    return yield* clientError("invalid_projected_token");
  }
  const source = yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(() => clientError("invalid_projected_token")),
  );
  const token = source.trim();
  if (!TokenPattern.test(token) || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
    return yield* clientError("invalid_projected_token");
  }
  return token;
});

export const runGitHubWorkloadClient = Effect.fn(
  "agentos.githubWorkloadAuth.run",
)(function*(
  args: ReadonlyArray<string>,
  configuration: GitHubWorkloadClientConfiguration,
) {
  yield* validateConfiguration(configuration);
  const command = args[0];
  if (command === "credential") {
    return yield* runCredentialHelper(
      args.slice(1),
      configuration,
    );
  }
  if (command === "exec") {
    return yield* runNativeClient(args.slice(1), configuration);
  }
  return yield* clientError("invalid_configuration");
});

const runCredentialHelper = Effect.fn(
  "agentos.githubWorkloadAuth.credential",
)(function*(
  args: ReadonlyArray<string>,
  configuration: GitHubWorkloadClientConfiguration,
) {
  const operation = args[0];
  if (
    args.length !== 1 ||
    !["get", "store", "erase"].includes(operation ?? "")
  ) {
    return yield* clientError("invalid_credential_request");
  }
  const io = yield* GitHubWorkloadClientIo;
  const source = yield* io.readInput;
  if (Buffer.byteLength(source) > MAX_CREDENTIAL_INPUT_BYTES) {
    return yield* clientError("invalid_credential_request");
  }
  if (operation !== "get") return 0;
  const request = yield* parseCredentialRequest(source);
  if (request.protocol !== "https" || request.host !== configuration.host) {
    return 0;
  }
  const token = yield* readGitHubWorkloadToken(configuration.tokenFile);
  yield* io.writeOutput(`username=x-access-token\npassword=${token}\n\n`);
  return 0;
});

const runNativeClient = Effect.fn(
  "agentos.githubWorkloadAuth.nativeClient",
)(function*(
  args: ReadonlyArray<string>,
  configuration: GitHubWorkloadClientConfiguration,
) {
  const tool = args[0];
  if (tool !== "gh" && tool !== "gh-axi") {
    return yield* clientError("invalid_configuration");
  }
  if (args[1] === "auth") {
    return yield* clientError("invalid_configuration");
  }
  const paths = yield* Path.Path;
  const token = yield* readGitHubWorkloadToken(configuration.tokenFile);
  const executable = tool === "gh"
    ? configuration.ghBinary ?? paths.join(
      configuration.home,
      ".local",
      "share",
      "mise",
      "shims",
      "gh",
    )
    : configuration.ghAxiBinary ?? paths.join(
      configuration.home,
      ".local",
      "share",
      "mise",
      "shims",
      "gh-axi",
    );
  const ghBinary = configuration.ghBinary ?? paths.join(
    configuration.home,
    ".local",
    "share",
    "mise",
    "shims",
    "gh",
  );
  const command = ChildProcess.make(executable, args.slice(1), {
    env: {
      GH_CONFIG_DIR: paths.join(
        configuration.home,
        ".local",
        "state",
        "agentos",
        "github-cli",
      ),
      GH_ENTERPRISE_TOKEN: token,
      GH_HOST: configuration.host,
      GH_PATH: ghBinary,
      GH_TOKEN: undefined,
      GITHUB_ENTERPRISE_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      SSL_CERT_FILE: configuration.caFile,
    },
    extendEnv: true,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return yield* Effect.scoped(
    Effect.gen(function*() {
      const handle = yield* command;
      return Number(yield* handle.exitCode);
    }),
  ).pipe(
    Effect.mapError(() => clientError("native_client_unavailable")),
  );
});

function parseCredentialRequest(source: string) {
  return Effect.gen(function*() {
    const result: Record<string, string> = {};
    for (const line of source.split(/\r?\n/)) {
      if (line === "") break;
      const separator = line.indexOf("=");
      if (separator <= 0) {
        return yield* clientError("invalid_credential_request");
      }
      const key = line.slice(0, separator);
      if (result[key] !== undefined) {
        return yield* clientError("invalid_credential_request");
      }
      result[key] = line.slice(separator + 1);
    }
    return result;
  });
}

function validateConfiguration(
  configuration: GitHubWorkloadClientConfiguration,
) {
  const validHost =
    /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(configuration.host) &&
    configuration.host.length <= 253;
  const validPaths = [
    configuration.caFile,
    configuration.home,
    configuration.tokenFile,
  ].every((value) => value.length > 0);
  return validHost && validPaths
    ? Effect.void
    : Effect.fail(clientError("invalid_configuration"));
}

function clientError(code: GitHubWorkloadClientError["code"]) {
  return GitHubWorkloadClientError.make({ code });
}
