#!/usr/bin/env bun

import { Client, escapeIdentifier } from "pg";
import type { ClientConfig } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";
import pgPass from "pgpass";

type Notification = {
  channel: string;
  payload?: string;
};

export interface PostgresListenerClient {
  connect(): Promise<unknown>;
  query(statement: string): Promise<unknown>;
  end(): Promise<unknown>;
  on(event: "notification", listener: (message: Notification) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "end", listener: () => void): this;
  removeListener(
    event: "notification",
    listener: (message: Notification) => void,
  ): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "end", listener: () => void): this;
}

export type PostgresNotification = {
  channel: string;
  payload: string;
};

export type PostgresListenerReady = {
  state: "listening";
  channel: string;
};

export type PgPassConnection = {
  host: string;
  port: number;
  database: string;
  user: string;
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

export async function waitForNotification(
  client: PostgresListenerClient,
  channel: string,
  write: (text: string) => void = (text) => process.stdout.write(text),
  writeReady?: (text: string) => void,
): Promise<PostgresNotification> {
  let settled = false;
  let listening = false;
  let pendingNotification: PostgresNotification | undefined;
  let resolveNotification!: (notification: PostgresNotification) => void;
  let rejectNotification!: (error: Error) => void;
  const notification = new Promise<PostgresNotification>((resolve, reject) => {
    resolveNotification = resolve;
    rejectNotification = reject;
  });

  const cleanup = async () => {
    client.removeListener("notification", onNotification);
    client.removeListener("error", onError);
    client.removeListener("end", onEnd);
    await client.end();
  };
  const settle = async (
    result: PostgresNotification | undefined,
    initialError?: Error,
  ) => {
    if (settled) return;
    settled = true;
    let error = initialError;
    try {
      if (result) write(`${JSON.stringify(result)}\n`);
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause));
    }
    try {
      await cleanup();
    } catch (cause) {
      error ??= cause instanceof Error ? cause : new Error(String(cause));
    }
    if (error) {
      rejectNotification(error);
    } else {
      resolveNotification(result!);
    }
  };
  const onNotification = (message: Notification) => {
    if (message.channel !== channel || settled) return;
    const result = { channel, payload: message.payload ?? "" };
    if (!listening) {
      pendingNotification ??= result;
      return;
    }
    void settle(result);
  };
  const onError = (error: Error) => {
    void settle(undefined, error);
  };
  const onEnd = () => {
    void settle(
      undefined,
      new Error("PostgreSQL connection ended before a notification"),
    );
  };

  client.on("notification", onNotification);
  client.on("error", onError);
  client.on("end", onEnd);

  try {
    await client.connect();
    await client.query(`LISTEN ${escapeIdentifier(channel)}`);
    const ready: PostgresListenerReady = { state: "listening", channel };
    writeReady?.(`${JSON.stringify(ready)}\n`);
    listening = true;
    if (pendingNotification) void settle(pendingNotification);
  } catch (error) {
    void settle(
      undefined,
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  return notification;
}

export function resolvePgPassPassword(
  connection: PgPassConnection,
): Promise<string | undefined> {
  return new Promise((resolve) => pgPass(connection, resolve));
}

export function createPostgresListenerClient(): PostgresListenerClient {
  const connectionString = process.env.DATABASE_URL;
  const parsedConnection = connectionString
    ? Object.fromEntries(
        Object.entries(parseConnectionString(connectionString)).filter(
          ([, value]) => value !== null,
        ),
      )
    : {};
  const config = {
    ...parsedConnection,
    application_name: "pg-listen",
  } as ClientConfig;

  if (
    process.env.PGPASSWORD === undefined &&
    !connectionStringHasPassword(connectionString)
  ) {
    config.password = ((connection?: PgPassConnection) =>
      connection
        ? resolvePgPassPassword(connection)
        : Promise.resolve(undefined)) as () => Promise<string>;
  }

  return new Client(config) as PostgresListenerClient;
}

function connectionStringHasPassword(connectionString: string | undefined) {
  if (!connectionString) return false;
  try {
    return new URL(connectionString).password.length > 0;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(help);
  } else {
    const channels = process.argv.slice(2);
    const channel = channels[0];
    if (!channel || channels.length !== 1) {
      process.stderr.write("Usage: pg-listen <channel>\n");
      process.exitCode = 2;
    } else {
      const client = createPostgresListenerClient();
      try {
        await waitForNotification(
          client,
          channel,
          undefined,
          (text) => process.stderr.write(text),
        );
      } catch (error) {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      }
    }
  }
}
