#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Client } from "pg";
import type { ClientConfig, Notification } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import {
  Cause,
  Config,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Redacted,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect";

export type PostgresNotification = {
  readonly channel: string;
  readonly payload: string;
};

export type PostgresListenerEvent =
  | { readonly state: "listening"; readonly channel: string }
  | ({ readonly state: "notification" } & PostgresNotification);

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

const help = `pg-listen

Wait for one PostgreSQL notification and exit.

Usage:
  pg-listen <channel>

Connects through standard PostgreSQL environment/configuration, executes only
LISTEN on the selected channel, prints a readiness JSON line to standard error
after LISTEN is registered, and prints the first notification as one JSON line
to standard output without interpreting its payload.
`;

const PgListenErrorCodeSchema = Schema.Literals([
  "configuration",
  "connection",
  "connection_ended",
  "encoding",
  "output",
]);

export class PgListenError extends Schema.TaggedErrorClass<PgListenError>()(
  "PgListenError",
  {
    code: PgListenErrorCodeSchema,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorExitCode] = this.code === "configuration"
    ? 2
    : 1;
}

const pgListenError = (
  code: PgListenError["code"],
  message: string,
  cause?: unknown,
) => new PgListenError({ code, message, ...(cause === undefined ? {} : { cause }) });

const ReadySchema = Schema.Struct({
  state: Schema.Literal("listening"),
  channel: Schema.String,
});
const NotificationSchema = Schema.Struct({
  channel: Schema.String,
  payload: Schema.String,
});
const ReadyFromString = Schema.fromJsonString(ReadySchema);
const NotificationFromString = Schema.fromJsonString(NotificationSchema);

export class PostgresNotificationSource extends Context.Service<
  PostgresNotificationSource,
  {
    readonly events: (
      channel: string,
    ) => Stream.Stream<PostgresListenerEvent, PgListenError>;
  }
>()("agentos/pg-listen/PostgresNotificationSource") {}

const PgEnvironment = Config.all({
  databaseUrl: Config.option(Config.string("DATABASE_URL")),
  database: Config.option(Config.string("PGDATABASE")),
  host: Config.option(Config.string("PGHOST")),
  home: Config.option(Config.string("HOME")),
  login: Config.option(Config.string("USER")),
  passFile: Config.option(Config.string("PGPASSFILE")),
  password: Config.option(Config.redacted("PGPASSWORD")),
  port: Config.option(Config.int("PGPORT")),
  user: Config.option(Config.string("PGUSER")),
});

export const loadPostgresClientConfig = Effect.gen(function*() {
  const environment = yield* PgEnvironment.pipe(
    Effect.mapError((cause) =>
      pgListenError(
        "configuration",
        "Could not load PostgreSQL configuration",
        cause,
      )
    ),
  );
  const databaseUrl = Option.getOrUndefined(environment.databaseUrl);
  const parsed = databaseUrl === undefined
    ? {}
    : yield* Effect.try({
      try: () => parseIntoClientConfig(databaseUrl),
      catch: (cause) =>
        pgListenError(
          "configuration",
          "DATABASE_URL is not a valid PostgreSQL connection URL",
          cause,
        ),
    });
  const user = parsed.user ??
    Option.getOrUndefined(environment.user) ??
    Option.getOrUndefined(environment.login);
  const database = parsed.database ??
    Option.getOrUndefined(environment.database) ??
    user;
  const host = parsed.host ?? Option.getOrUndefined(environment.host) ?? "localhost";
  const port = parsed.port ?? Option.getOrUndefined(environment.port) ?? 5432;
  const configuredPassword = typeof parsed.password === "string" &&
      parsed.password.length > 0
    ? parsed.password
    : Option.map(environment.password, Redacted.value).pipe(
      Option.getOrUndefined,
    );
  const password = configuredPassword ?? (
    user === undefined || database === undefined
      ? undefined
      : yield* resolvePgPassPassword(
        { host, port, database, user },
        {
          home: Option.getOrUndefined(environment.home),
          passFile: Option.getOrUndefined(environment.passFile),
        },
      )
  );

  return {
    ...parsed,
    application_name: "pg-listen",
    database,
    host,
    password,
    port,
    user,
  } satisfies ClientConfig;
}).pipe(Effect.withSpan("agentos.pgListen.loadPostgresClientConfig"));

const resolvePgPassPassword = Effect.fn(
  "agentos.pgListen.resolvePgPassPassword",
)(function*(
  connection: PgPassConnection,
  environment: {
    readonly home: string | undefined;
    readonly passFile: string | undefined;
  },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const passFile = environment.passFile ??
    (environment.home === undefined
      ? undefined
      : paths.join(environment.home, ".pgpass"));
  if (passFile === undefined) return undefined;

  const snapshot = yield* Effect.all({
    contents: fileSystem.readFileString(passFile),
    info: fileSystem.stat(passFile),
  }).pipe(Effect.option);
  if (Option.isNone(snapshot) || snapshot.value.info.type !== "File") {
    return undefined;
  }
  if (paths.sep !== "\\" && (snapshot.value.info.mode & 0o077) !== 0) {
    return undefined;
  }

  for (const line of snapshot.value.contents.split(/\r?\n/)) {
    const entry = parsePgPassLine(line);
    if (entry !== undefined && matchesPgPass(connection, entry)) {
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
  const [host, port, database, user, password] = fields;
  if (
    fields.length !== 5 ||
    host === undefined ||
    port === undefined ||
    database === undefined ||
    user === undefined ||
    password === undefined ||
    fields.some((value) => value.length === 0) ||
    (port !== "*" && !Number.isInteger(Number(port)))
  ) {
    return undefined;
  }
  return { host, port, database, user, password };
}

function matchesPgPass(connection: PgPassConnection, entry: PgPassEntry) {
  const matches = (value: string, pattern: string) =>
    pattern === "*" || pattern === value;
  return matches(connection.host, entry.host) &&
    (entry.port === "*" || Number(entry.port) === connection.port) &&
    matches(connection.database, entry.database) &&
    matches(connection.user, entry.user);
}

export const PostgresNotificationSourceLive = Layer.effect(
  PostgresNotificationSource,
  Effect.gen(function*() {
    const config = yield* loadPostgresClientConfig;
    return PostgresNotificationSource.of({
      events: (channel) => nativePostgresEvents(config, channel),
    });
  }),
);

const nativePostgresEvents = (
  config: ClientConfig,
  channel: string,
): Stream.Stream<PostgresListenerEvent, PgListenError> =>
  Stream.callback<PostgresListenerEvent, PgListenError>(
    Effect.fn("agentos.pgListen.nativeClient")(function*(queue) {
      const client = yield* Effect.try({
        try: () => new Client(config),
        catch: (cause) =>
          pgListenError(
            "configuration",
            "Could not create the PostgreSQL listener client",
            cause,
          ),
      });
      let listening = false;
      let settled = false;
      let closing = false;
      let pending: PostgresNotification | undefined;
      const fail = (error: PgListenError) => {
        if (settled) return;
        settled = true;
        Queue.failCauseUnsafe(queue, Cause.fail(error));
      };
      const offerNotification = (notification: PostgresNotification) => {
        if (settled) return;
        settled = true;
        Queue.offerUnsafe(queue, { state: "notification", ...notification });
        Queue.endUnsafe(queue);
      };
      const onNotification = (message: Notification) => {
        if (message.channel !== channel || settled) return;
        const notification = { channel, payload: message.payload ?? "" };
        if (!listening) {
          pending ??= notification;
        } else {
          offerNotification(notification);
        }
      };
      const onError = (cause: Error) =>
        fail(pgListenError("connection", "PostgreSQL listener failed", cause));
      const onEnd = () => {
        if (!closing) {
          fail(pgListenError(
            "connection_ended",
            "PostgreSQL connection ended before a notification",
          ));
        }
      };

      client.on("notification", onNotification);
      client.on("error", onError);
      client.on("end", onEnd);
      yield* Effect.addFinalizer(() => {
        closing = true;
        client.removeListener("notification", onNotification);
        client.removeListener("error", onError);
        client.removeListener("end", onEnd);
        return Effect.tryPromise({
          try: () => client.end(),
          catch: (cause) =>
            pgListenError(
              "connection",
              "Could not close the PostgreSQL listener client",
              cause,
            ),
        }).pipe(Effect.ignore);
      });
      yield* Effect.tryPromise({
        try: () => client.connect(),
        catch: (cause) =>
          pgListenError(
            "connection",
            "Could not connect the PostgreSQL listener client",
            cause,
          ),
      });
      yield* Effect.tryPromise({
        try: () => client.query(`LISTEN ${escapeIdentifier(channel)}`),
        catch: (cause) =>
          pgListenError(
            "connection",
            "Could not register the PostgreSQL listener channel",
            cause,
          ),
      });
      Queue.offerUnsafe(queue, { state: "listening", channel });
      listening = true;
      if (pending !== undefined) offerNotification(pending);
    }),
  );

function escapeIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

const writeJsonLine = Effect.fn("agentos.pgListen.writeJsonLine")(
  function*(
    output: "stderr" | "stdout",
    value: PostgresListenerEvent,
  ) {
    const stdio = yield* Stdio.Stdio;
    const encoded = yield* (
      value.state === "listening"
        ? Schema.encodeEffect(ReadyFromString)(value)
        : Schema.encodeEffect(NotificationFromString)({
          channel: value.channel,
          payload: value.payload,
        })
    ).pipe(
      Effect.mapError((cause) =>
        pgListenError("encoding", "Could not encode PostgreSQL listener output", cause)
      ),
    );
    yield* Stream.make(`${encoded}\n`).pipe(
      Stream.run(output === "stderr" ? stdio.stderr() : stdio.stdout()),
      Effect.mapError((cause) =>
        pgListenError("output", "Could not write PostgreSQL listener output", cause)
      ),
    );
  },
);

export const waitForNotification = Effect.fn(
  "agentos.pgListen.waitForNotification",
)(function*(channel: string) {
  const source = yield* PostgresNotificationSource;
  const notification = yield* source.events(channel).pipe(
    Stream.mapEffect((event) =>
      writeJsonLine(event.state === "listening" ? "stderr" : "stdout", event)
        .pipe(Effect.as(event))
    ),
    Stream.filter((event) => event.state === "notification"),
    Stream.runHead,
  );
  return yield* Option.match(notification, {
    onNone: () => Effect.fail(pgListenError(
      "connection_ended",
      "PostgreSQL connection ended before a notification",
    )),
    onSome: ({ channel, payload }) => Effect.succeed({ channel, payload }),
  });
});

export const runPgListen = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  if (args.includes("--help") || args.includes("-h")) {
    yield* Stream.make(help).pipe(
      Stream.run(stdio.stdout()),
      Effect.mapError((cause) =>
        pgListenError("output", "Could not write pg-listen help", cause)
      ),
    );
    return;
  }
  const channel = args[0];
  if (channel === undefined || args.length !== 1) {
    return yield* pgListenError(
      "configuration",
      "Usage: pg-listen <channel>",
    );
  }
  yield* waitForNotification(channel);
});

const reportFailure = (error: PgListenError) =>
  Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(`${error.message}\n`).pipe(
      Stream.run(stdio.stderr()),
      Effect.ignore,
    );
  });

if (import.meta.main) {
  const source = PostgresNotificationSourceLive.pipe(
    Layer.provide(BunServices.layer),
  );
  const live = Layer.mergeAll(
    BunServices.layer,
    source,
    ConfigProvider.layer(ConfigProvider.fromEnv()),
  );
  BunRuntime.runMain(
    runPgListen.pipe(
      Effect.tapError(reportFailure),
      Effect.provide(live),
    ),
    { disableErrorReporting: true },
  );
}
