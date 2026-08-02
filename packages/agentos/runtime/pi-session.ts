import {
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schema,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

type PiRuntime = Pick<
  typeof import("@earendil-works/pi-coding-agent"),
  "SessionManager" | "SettingsManager"
>;

export type PiSessionEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type PiSessionContents = {
  readonly contents: string;
  readonly header: Readonly<Record<string, unknown>> & {
    readonly cwd: string;
    readonly type: "session";
  };
  readonly headerStart: number;
  readonly lineBreak: number;
};

export class PiSessionError extends Schema.TaggedErrorClass<PiSessionError>()(
  "PiSessionError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
    operation: Schema.String,
    path: Schema.optional(Schema.String),
  },
) {}

const piPackageName = "@earendil-works/pi-coding-agent";
const supportedPiVersion = "0.81.1";
const maximumSessionBytes = 128 * 1024 * 1024;
const headerPrefixBytes = 64 * 1024;
const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const JsonRecordFromString = Schema.fromJsonString(JsonRecord);

function sessionError(
  operation: string,
  message: string,
  path?: string,
  cause?: unknown,
) {
  return PiSessionError.make({ cause, message, operation, path });
}

export const migratePiSessionCwd = Effect.fn(
  "agentos.piSession.migrateCwd",
)(function*(path: string, cwd: string) {
  const paths = yield* Path.Path;
  if (!paths.isAbsolute(cwd)) {
    return yield* sessionError(
      "migrate",
      "A migrated Pi session working directory must be absolute.",
      path,
    );
  }
  const { contents, header, headerStart, lineBreak } = yield* readPiSession(path);
  yield* writePiSession(path, contents, headerStart, lineBreak, {
    ...header,
    cwd,
  });
});

export const preparePiSessionRelocation = Effect.fn(
  "agentos.piSession.prepareRelocation",
)(function*(
  path: string,
  cwd: string,
  environment: PiSessionEnvironment,
) {
  const paths = yield* Path.Path;
  if (!paths.isAbsolute(cwd)) {
    return yield* sessionError(
      "relocate",
      "A relocated Pi session working directory must be absolute.",
      path,
    );
  }
  const source = paths.resolve(path);
  const { contents, header, headerStart, lineBreak } = yield* readPiSession(source);
  const runtime = yield* loadPiRuntime(environment, cwd);
  const allocation = yield* allocateSession(runtime, cwd, environment);
  const target = paths.resolve(cwd, allocation.sessionFile);
  const targetDirectory = paths.resolve(cwd, allocation.sessionDirectory);
  const targetHeader: PiSessionContents["header"] = {
    ...header,
    cwd,
    parentSession: source,
    type: "session",
  };

  if (paths.resolve(paths.dirname(source)) === targetDirectory && header.cwd === cwd) {
    return source;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(targetDirectory, {
    recursive: true,
    mode: 0o700,
  }).pipe(
    Effect.mapError((cause) =>
      sessionError(
        "relocate",
        `Could not prepare Pi session directory ${targetDirectory}.`,
        targetDirectory,
        cause,
      )
    ),
  );
  yield* writePiSession(
    target,
    contents,
    headerStart,
    lineBreak,
    targetHeader,
    true,
  );
  return target;
});

export const findPreparedPiSessionRelocation = Effect.fn(
  "agentos.piSession.findPreparedRelocation",
)(function*(cwd: string, environment: PiSessionEnvironment) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  if (!paths.isAbsolute(cwd)) {
    return yield* sessionError(
      "find relocation",
      "A relocated Pi session working directory must be absolute.",
      cwd,
    );
  }
  const directory = yield* resolvePiSessionDirectory(cwd, environment);
  const listed = yield* fileSystem.readDirectory(directory).pipe(Effect.result);
  if (Result.isFailure(listed)) {
    if (listed.failure.reason._tag === "NotFound") return undefined;
    return yield* sessionError(
      "read directory",
      `Could not inspect Pi session directory ${directory}.`,
      directory,
      listed.failure,
    );
  }

  for (const name of listed.success
    .filter((candidate) => candidate.endsWith(".jsonl"))
    .sort()
    .reverse()
    .slice(0, 32)) {
    const path = paths.join(directory, name);
    const header = yield* readPiSessionHeaderPrefix(path);
    if (
      header?.cwd === cwd &&
      typeof header.parentSession === "string" &&
      paths.isAbsolute(header.parentSession)
    ) {
      return path;
    }
  }
  return undefined;
});

const loadPiRuntime = Effect.fn("agentos.piSession.loadRuntime")(
  function*(environment: PiSessionEnvironment, cwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const localResolution = yield* Effect.try({
      try: () => import.meta.resolve(piPackageName),
      catch: (cause) => sessionError("resolve runtime", "Local Pi package is unavailable.", undefined, cause),
    }).pipe(Effect.option);

    let entrypoint: string;
    if (Option.isSome(localResolution)) {
      const url = Option.getOrUndefined(
        Schema.decodeUnknownOption(Schema.URLFromString)(localResolution.value),
      );
      if (url === undefined) {
        return yield* sessionError("resolve runtime", "Resolved Pi package URL is invalid.");
      }
      entrypoint = yield* paths.fromFileUrl(url).pipe(
        Effect.mapError((cause) =>
          sessionError("resolve runtime", "Resolved Pi package URL is not a file URL.", undefined, cause)
        ),
      );
    } else {
      const releaseRoot = environment.AGENTOS_RELEASE_ROOT?.trim() || cwd;
      const executable = yield* locatePiExecutable(environment, releaseRoot);
      entrypoint = yield* findPiPackageEntrypoint(
        yield* fileSystem.realPath(executable).pipe(
          Effect.mapError((cause) => sessionError("resolve runtime", "Could not resolve the Pi executable.", executable, cause)),
        ),
      );
    }

    const packageEntrypoint = yield* findPiPackageEntrypoint(
      yield* fileSystem.realPath(entrypoint).pipe(
        Effect.mapError((cause) => sessionError("resolve runtime", "Could not resolve the Pi runtime.", entrypoint, cause)),
      ),
    );
    const packageUrl = yield* paths.toFileUrl(packageEntrypoint).pipe(
      Effect.mapError((cause) => sessionError("load runtime", "Could not create the Pi runtime URL.", packageEntrypoint, cause)),
    );
    const runtime: unknown = yield* Effect.tryPromise({
      try: () => import(packageUrl.href),
      catch: (cause) => sessionError("load runtime", "Could not load the installed Pi runtime.", packageEntrypoint, cause),
    });
    if (!isPiRuntime(runtime)) {
      return yield* sessionError(
        "load runtime",
        `${piPackageName}@${supportedPiVersion} does not expose its session runtime.`,
        packageEntrypoint,
      );
    }
    return runtime;
  },
);

const locatePiExecutable = Effect.fn("agentos.piSession.locateExecutable")(
  function*(environment: PiSessionEnvironment, cwd: string) {
    return yield* Effect.scoped(Effect.gen(function*() {
      const child = yield* ChildProcess.make("mise", ["which", "pi"], {
        cwd,
        env: { ...environment },
        extendEnv: false,
        stderr: "pipe",
        stdout: "pipe",
      }).pipe(
        Effect.mapError((cause) => sessionError("locate runtime", "Could not run Mise to locate Pi.", undefined, cause)),
      );
      const [exitCode, stdout] = yield* Effect.all([
        child.exitCode.pipe(Effect.map(Number)),
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      ], { concurrency: "unbounded" }).pipe(
        Effect.mapError((cause) => sessionError("locate runtime", "Could not read Mise output.", undefined, cause)),
      );
      const executable = stdout.trim();
      const paths = yield* Path.Path;
      if (exitCode !== 0 || !paths.isAbsolute(executable)) {
        return yield* sessionError(
          "locate runtime",
          "Could not locate the installed Pi package through Mise.",
        );
      }
      return executable;
    }));
  },
);

const resolvePiSessionDirectory = Effect.fn(
  "agentos.piSession.resolveDirectory",
)(function*(cwd: string, environment: PiSessionEnvironment) {
  const paths = yield* Path.Path;
  const runtime = yield* loadPiRuntime(environment, cwd);
  const allocation = yield* allocateSession(runtime, cwd, environment);
  return paths.resolve(cwd, allocation.sessionDirectory);
});

const allocateSession = Effect.fn("agentos.piSession.allocate")(
  function*(runtime: PiRuntime, cwd: string, environment: PiSessionEnvironment) {
    return yield* Effect.try({
      try: () => {
        const settings = runtime.SettingsManager.create(
          cwd,
          environment.PI_CODING_AGENT_DIR || undefined,
        );
        const configuredDirectory =
          environment.PI_CODING_AGENT_SESSION_DIR || settings.getSessionDir();
        const manager = runtime.SessionManager.create(cwd, configuredDirectory);
        const sessionFile = manager.getSessionFile();
        if (!sessionFile) return undefined;
        return {
          sessionDirectory: manager.getSessionDir(),
          sessionFile,
        };
      },
      catch: (cause) => sessionError("allocate session", "Pi could not allocate a persisted session path.", cwd, cause),
    }).pipe(
      Effect.flatMap((allocation) =>
        allocation === undefined
          ? Effect.fail(sessionError("allocate session", "Pi did not allocate a persisted session path.", cwd))
          : Effect.succeed(allocation)
      ),
    );
  },
);

const findPiPackageEntrypoint = Effect.fn(
  "agentos.piSession.findEntrypoint",
)(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  let directory = paths.dirname(path);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = paths.join(directory, "package.json");
    const source = yield* fileSystem.readFileString(manifestPath).pipe(Effect.result);
    if (Result.isSuccess(source)) {
      const manifest = yield* Schema.decodeUnknownEffect(JsonRecordFromString)(source.success).pipe(
        Effect.mapError((cause) => sessionError("read manifest", `Invalid package manifest ${manifestPath}.`, manifestPath, cause)),
      );
      if (manifest.name === piPackageName) {
        if (manifest.version !== supportedPiVersion) {
          return yield* sessionError(
            "resolve runtime",
            `Expected ${piPackageName}@${supportedPiVersion}, received ${String(manifest.version)}.`,
            manifestPath,
          );
        }
        return paths.join(directory, "dist", "index.js");
      }
    } else if (source.failure.reason._tag !== "NotFound") {
      return yield* sessionError("read manifest", `Could not read ${manifestPath}.`, manifestPath, source.failure);
    }
    const parent = paths.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return yield* sessionError(
    "resolve runtime",
    `Could not resolve ${piPackageName}@${supportedPiVersion} from ${path}.`,
    path,
  );
});

const writePiSession = Effect.fn("agentos.piSession.write")(
  function*(
    path: string,
    contents: string,
    headerStart: number,
    lineBreak: number,
    header: PiSessionContents["header"],
    create = false,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const next = `${path}.agentos-next`;
    const remainder = lineBreak === -1 ? "\n" : contents.slice(lineBreak);
    const encoded = yield* Schema.encodeEffect(JsonRecordFromString)(header).pipe(
      Effect.mapError((cause) => sessionError("encode session", `Could not encode the Pi session header for ${path}.`, path, cause)),
    );
    yield* Effect.gen(function*() {
      yield* fileSystem.writeFileString(
        next,
        `${contents.slice(0, headerStart)}${encoded}${remainder}`,
        { flag: create ? "wx" : "w", mode: 0o600 },
      );
      yield* fileSystem.rename(next, path);
    }).pipe(
      Effect.mapError((cause) => sessionError("write session", `Could not write Pi session ${path}.`, path, cause)),
      Effect.ensuring(fileSystem.remove(next, { force: true }).pipe(Effect.ignore)),
    );
  },
);

export const readPiSession = Effect.fn("agentos.piSession.read")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const info = yield* fileSystem.stat(path).pipe(
      Effect.mapError((cause) => sessionError("read session", `Could not inspect Pi session ${path}.`, path, cause)),
    );
    if (info.size > BigInt(maximumSessionBytes)) {
      return yield* sessionError("read session", `Pi session ${path} exceeds ${maximumSessionBytes} bytes.`, path);
    }
    const contents = yield* fileSystem.readFileString(path).pipe(
      Effect.mapError((cause) => sessionError("read session", `Could not read Pi session ${path}.`, path, cause)),
    );
    const parsed = parsePiSessionContents(contents);
    return parsed ?? (yield* sessionError("read session", `${path} has no valid Pi session header.`, path));
  },
);

const readPiSessionHeaderPrefix = Effect.fn(
  "agentos.piSession.readHeaderPrefix",
)(function*(path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.stream(path, { bytesToRead: headerPrefixBytes }).pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.mapError((cause) => sessionError("read session", `Could not read Pi session prefix ${path}.`, path, cause)),
  );
  return parsePiSessionContents(contents)?.header;
});

function parsePiSessionContents(contents: string): PiSessionContents | undefined {
  let headerStart = 0;
  while (headerStart <= contents.length) {
    const lineBreak = contents.indexOf("\n", headerStart);
    const line = lineBreak === -1
      ? contents.slice(headerStart)
      : contents.slice(headerStart, lineBreak);
    const candidate = parsePiSessionHeaderCandidate(line);
    if (candidate.kind === "header") {
      return { contents, header: candidate.header, headerStart, lineBreak };
    }
    if (candidate.kind === "invalid" || lineBreak === -1) break;
    headerStart = lineBreak + 1;
  }
  return undefined;
}

type PiSessionHeaderCandidate =
  | { readonly kind: "header"; readonly header: PiSessionContents["header"] }
  | { readonly kind: "invalid" }
  | { readonly kind: "skip" };

function parsePiSessionHeaderCandidate(line: string): PiSessionHeaderCandidate {
  if (!line.trim()) return { kind: "skip" };
  const parsed = Schema.decodeUnknownOption(JsonRecordFromString)(line);
  if (Option.isNone(parsed)) return { kind: "skip" };
  const entry = parsed.value;
  if (
    entry.type !== "session" ||
    typeof entry.id !== "string" ||
    typeof entry.cwd !== "string"
  ) {
    return { kind: "invalid" };
  }
  return { header: { ...entry, cwd: entry.cwd, type: "session" }, kind: "header" };
}

function isPiRuntime(value: unknown): value is PiRuntime {
  return typeof value === "object" &&
    value !== null &&
    "SessionManager" in value &&
    typeof value.SessionManager === "function" &&
    "SettingsManager" in value &&
    typeof value.SettingsManager === "function";
}
