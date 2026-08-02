import {
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";

type PgPassConnection = {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
};

type PgPassEntry = {
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly user: string;
  readonly password: string;
};

export interface PgPassFileSnapshot {
  readonly contents: string;
  readonly isFile: boolean;
  readonly mode: number;
}

export class PgPassReader extends Context.Service<
  PgPassReader,
  {
    readonly read: (
      path: string,
    ) => Effect.Effect<PgPassFileSnapshot | undefined>;
  }
>()("agentos/database/PgPassReader") {}

export const PgPassReaderLive = Layer.effect(
  PgPassReader,
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    return PgPassReader.of({
      read: (path) =>
        Effect.all({
          contents: fileSystem.readFileString(path),
          info: fileSystem.stat(path),
        }).pipe(
          Effect.map(({ contents, info }) => ({
            contents,
            isFile: info.type === "File",
            mode: info.mode,
          })),
          Effect.orElseSucceed(() => undefined),
        ),
    });
  }),
);

const PgEnvironment = Config.all({
  database: Config.option(Config.string("PGDATABASE")),
  host: Config.option(Config.string("PGHOST")),
  home: Config.option(Config.string("HOME")),
  password: Config.option(Config.redacted("PGPASSWORD")),
  passFile: Config.option(Config.string("PGPASSFILE")),
  port: Config.option(Config.int("PGPORT")),
  user: Config.option(Config.string("PGUSER")),
  login: Config.option(Config.string("USER")),
});

const DatabaseCredentialErrorCodeSchema = Schema.Literals([
  "invalid_database_url",
]);

export class DatabaseCredentialError extends Schema.TaggedErrorClass<DatabaseCredentialError>()(
  "DatabaseCredentialError",
  { code: DatabaseCredentialErrorCodeSchema },
) {}

export const resolvePgPassDatabaseUrl = Effect.fn(
  "agentos.database.resolvePgPassDatabaseUrl",
)(function*(databaseUrl: string) {
  const url = yield* Effect.try({
    try: () => new URL(databaseUrl),
    catch: () => credentialError("invalid_database_url"),
  });
  if (url.password) return databaseUrl;

  const environment = yield* PgEnvironment.pipe(
    Effect.orElseSucceed(() => ({
      database: Option.none<string>(),
      host: Option.none<string>(),
      home: Option.none<string>(),
      password: Option.none(),
      passFile: Option.none<string>(),
      port: Option.none<number>(),
      user: Option.none<string>(),
      login: Option.none<string>(),
    })),
  );
  if (Option.isSome(environment.password)) return databaseUrl;

  const identity = yield* Effect.try({
    try: () => {
      const user = decodeURIComponent(
        url.username ||
          Option.getOrUndefined(environment.user) ||
          Option.getOrUndefined(environment.login) ||
          "",
      );
      const database = decodeURIComponent(
        url.pathname.replace(/^\/+/, "") ||
          Option.getOrUndefined(environment.database) ||
          user,
      );
      return { database, user };
    },
    catch: () => credentialError("invalid_database_url"),
  });
  if (!identity.user || !identity.database) return databaseUrl;

  const password = yield* resolvePgPassPassword({
    host: url.hostname ||
      Option.getOrUndefined(environment.host) ||
      "localhost",
    port: url.port
      ? Number(url.port)
      : Option.getOrUndefined(environment.port) ?? 5432,
    database: identity.database,
    user: identity.user,
  }, {
    home: Option.getOrUndefined(environment.home),
    passFile: Option.getOrUndefined(environment.passFile),
  });
  if (password === undefined) return databaseUrl;

  url.password = password;
  return url.toString();
});

const resolvePgPassPassword = Effect.fn(
  "agentos.database.resolvePgPassPassword",
)(function*(
  connection: PgPassConnection,
  environment: {
    readonly home: string | undefined;
    readonly passFile: string | undefined;
  },
) {
  const reader = yield* PgPassReader;
  const paths = yield* Path.Path;
  const passFile = environment.passFile ??
    (environment.home === undefined
      ? undefined
      : paths.join(environment.home, ".pgpass"));
  if (passFile === undefined) return undefined;

  const file = yield* reader.read(passFile);
  if (file === undefined || !file.isFile) return undefined;
  if (paths.sep !== "\\" && (file.mode & 0o077) !== 0) {
    return undefined;
  }

  for (const line of file.contents.split(/\r?\n/)) {
    const entry = parsePgPassLine(line);
    if (entry !== undefined && matches(connection, entry)) {
      return entry.password;
    }
  }
  return undefined;
});

function parsePgPassLine(line: string): PgPassEntry | undefined {
  if (!line || /^\s*#/.test(line)) return undefined;

  const fields: string[] = [];
  let field = "";
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      field += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === ":" && fields.length < 4) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  if (escaped) field += "\\";
  fields.push(field);
  const host = fields[0];
  const port = fields[1];
  const database = fields[2];
  const user = fields[3];
  const password = fields[4];
  if (
    fields.length !== 5 ||
    host === undefined ||
    port === undefined ||
    database === undefined ||
    user === undefined ||
    password === undefined ||
    fields.some((value) => value.length === 0)
  ) {
    return undefined;
  }
  if (port !== "*" && !Number.isInteger(Number(port))) return undefined;
  return { host, port, database, user, password };
}

function matches(connection: PgPassConnection, entry: PgPassEntry) {
  return (
    matchField(connection.host, entry.host) &&
    (entry.port === "*" || Number(entry.port) === connection.port) &&
    matchField(connection.database, entry.database) &&
    matchField(connection.user, entry.user)
  );
}

function matchField(value: string, pattern: string) {
  return pattern === "*" || pattern === value;
}

function credentialError(code: DatabaseCredentialError["code"]) {
  return new DatabaseCredentialError({ code });
}
