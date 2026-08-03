import * as BunServices from "@effect/platform-bun/BunServices";
import { PGlite } from "@electric-sql/pglite";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";

const migrationsUrl = new URL("../migrations/", import.meta.url);

export class PGliteTestDatabaseError extends Schema.TaggedErrorClass<PGliteTestDatabaseError>()(
  "PGliteTestDatabaseError",
  {
    operation: Schema.Literals([
      "create",
      "close",
      "exec",
      "query",
      "listen",
      "unlisten",
      "migrate",
      "fixture",
    ]),
    detail: Schema.String,
  },
) {}

function failure(
  operation: typeof PGliteTestDatabaseError.fields.operation.Type,
  cause: unknown,
) {
  return PGliteTestDatabaseError.make({
    operation,
    detail: typeof cause === "string"
      ? cause
      : cause instanceof Error
      ? cause.message
      : "unknown database failure",
  });
}

export interface PGliteTestDatabaseService {
  readonly exec: (
    statement: string,
  ) => Effect.Effect<void, PGliteTestDatabaseError>;
  readonly query: <Row extends object>(
    statement: string,
    parameters?: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<Row>, PGliteTestDatabaseError>;
  readonly migrate: (
    filename: string,
  ) => Effect.Effect<void, PGliteTestDatabaseError>;
  readonly listen: (
    channel: string,
  ) => Effect.Effect<
    Stream.Stream<string>,
    PGliteTestDatabaseError,
    Scope.Scope
  >;
}

export class PGliteTestDatabase extends Context.Service<
  PGliteTestDatabase,
  PGliteTestDatabaseService
>()("agentos/test/PGliteTestDatabase") {}

export interface PGliteTestLayerOptions {
  readonly migrations:
    | "all"
    | ReadonlyArray<string | URL>
    | { readonly through: number };
  readonly setup?: (
    database: PGliteTestDatabaseService,
  ) => Effect.Effect<void, PGliteTestDatabaseError>;
  readonly releaseProbe?: Effect.Effect<void>;
}

const readMigrationFiles = Effect.fn("test.pglite.readMigrationFiles")(
  function*(through?: number) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const directory = yield* paths.fromFileUrl(migrationsUrl).pipe(
    Effect.mapError((cause) => failure("migrate", cause)),
  );
  const entries = yield* fileSystem.readDirectory(directory).pipe(
    Effect.mapError((cause) => failure("migrate", cause)),
  );

  const files = entries.filter((entry) => /^\d+_.+\.sql$/.test(entry)).sort();
  return yield* Effect.forEach(
    through === undefined
      ? files
      : files.filter((entry) => Number.parseInt(entry, 10) <= through),
    (entry) => fileSystem.readFileString(paths.join(directory, entry)).pipe(
      Effect.mapError((cause) => failure("migrate", cause)),
    ),
  );
});

const resolveMigrations = Effect.fn("test.pglite.resolveMigrations")(
  function*(selection: PGliteTestLayerOptions["migrations"]) {
    if (selection === "all") return yield* readMigrationFiles();
    if ("through" in selection) {
      return yield* readMigrationFiles(selection.through);
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    return yield* Effect.forEach(selection, (migration) =>
      typeof migration === "string"
        ? Effect.succeed(migration)
        : paths.fromFileUrl(migration).pipe(
          Effect.mapError((cause) => failure("migrate", cause)),
          Effect.flatMap((path) => fileSystem.readFileString(path)),
          Effect.mapError((cause) => failure("migrate", cause)),
        ));
  },
);

export function makePGliteTestLayer(
  options: PGliteTestLayerOptions,
): Layer.Layer<PGliteTestDatabase, PGliteTestDatabaseError> {
  return Layer.effect(PGliteTestDatabase, Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const migrationsDirectory = yield* paths.fromFileUrl(migrationsUrl).pipe(
      Effect.mapError((cause) => failure("migrate", cause)),
    );
    const database = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => PGlite.create(),
        catch: (cause) => failure("create", cause),
      }),
      (database) => Effect.tryPromise({
        try: () => database.close(),
        catch: (cause) => failure("close", cause),
      }).pipe(
        Effect.ensuring(options.releaseProbe ?? Effect.void),
        Effect.orDie,
      ),
    );

    const exec = Effect.fn("test.pglite.exec")((statement: string) =>
      Effect.tryPromise({
        try: () => database.exec(statement),
        catch: (cause) => failure("exec", cause),
      }).pipe(Effect.asVoid));

    const query = <Row extends object>(
      statement: string,
      parameters?: ReadonlyArray<unknown>,
    ) =>
      Effect.tryPromise({
        try: () => database.query<Row>(
          statement,
          parameters === undefined ? undefined : Array.from(parameters),
        ),
        catch: (cause) => failure("query", cause),
      }).pipe(Effect.map((result) => result.rows));

    const migrate = Effect.fn("test.pglite.migrate")(function*(
      filename: string,
    ) {
      if (!/^\d+_.+\.sql$/.test(filename)) {
        return yield* failure("migrate", "invalid migration filename");
      }
      const migration = yield* fileSystem.readFileString(
        paths.join(migrationsDirectory, filename),
      ).pipe(Effect.mapError((cause) => failure("migrate", cause)));
      yield* exec(migration);
    });

    const listen = Effect.fn("test.pglite.listen")(function*(channel: string) {
      const queue = yield* Queue.unbounded<string>();
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => database.listen(channel, (payload) => {
            Queue.offerUnsafe(queue, payload);
          }),
          catch: (cause) => failure("listen", cause),
        }),
        (unlisten) => Effect.tryPromise({
          try: () => unlisten(),
          catch: (cause) => failure("unlisten", cause),
        }).pipe(Effect.ignore),
      );
      return Stream.fromQueue(queue);
    });

    const service = PGliteTestDatabase.of({ exec, listen, migrate, query });
    const migrations = yield* resolveMigrations(options.migrations);
    yield* Effect.forEach(migrations, exec, { discard: true });
    if (options.setup !== undefined) yield* options.setup(service);
    return service;
  })).pipe(Layer.provide(BunServices.layer));
}

export const firstRow = Effect.fn("test.pglite.firstRow")(function*<Row>(
  rows: ReadonlyArray<Row>,
  detail: string,
) {
  const row = rows[0];
  if (row === undefined) return yield* failure("fixture", detail);
  return row;
});

export const withDatabaseLogin = Effect.fn("test.pglite.withDatabaseLogin")(
  function*<A, E, R>(
    database: PGliteTestDatabaseService,
    role: string,
    operation: Effect.Effect<A, E, R>,
  ) {
    if (!/^[a-z][a-z0-9_]*$/.test(role)) {
      return yield* failure("fixture", "invalid test login role");
    }
    return yield* Effect.acquireUseRelease(
      database.exec(`SET SESSION AUTHORIZATION ${role}`),
      () => operation,
      () => database.exec("SET SESSION AUTHORIZATION postgres").pipe(
        Effect.orDie,
      ),
    );
  },
);

export const asLogin = Effect.fn("test.pglite.asLogin")(function*<A, E, R>(
  role: string,
  operation: Effect.Effect<A, E, R>,
) {
  const database = yield* PGliteTestDatabase;
  return yield* withDatabaseLogin(database, role, operation);
});
