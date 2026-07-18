import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type PgPassConnection = {
  host: string;
  port: number;
  database: string;
  user: string;
};

export function resolvePgPassDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  if (url.password || process.env.PGPASSWORD !== undefined) return databaseUrl;

  const user = decodeURIComponent(
    url.username || process.env.PGUSER || process.env.USER || "",
  );
  const database = decodeURIComponent(
    url.pathname.replace(/^\/+/, "") || process.env.PGDATABASE || user,
  );
  if (!user || !database) return databaseUrl;

  const password = resolvePgPassPassword({
    host: url.hostname || process.env.PGHOST || "localhost",
    port: Number(url.port || process.env.PGPORT || 5432),
    database,
    user,
  });
  if (password === undefined) return databaseUrl;

  url.password = password;
  return url.toString();
}

function resolvePgPassPassword(
  connection: PgPassConnection,
): string | undefined {
  const path = process.env.PGPASSFILE || join(homedir(), ".pgpass");
  try {
    const stats = statSync(path);
    if (!stats.isFile()) return undefined;
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      return undefined;
    }

    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const entry = parsePgPassLine(line);
      if (!entry || !matches(connection, entry)) continue;
      return entry.password;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parsePgPassLine(line: string) {
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
  if (fields.length !== 5 || fields.some((value) => value.length === 0)) {
    return undefined;
  }

  const [host, port, database, user, password] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (port !== "*" && !Number.isInteger(Number(port))) return undefined;
  return { host, port, database, user, password };
}

function matches(
  connection: PgPassConnection,
  entry: ReturnType<typeof parsePgPassLine> & {},
) {
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
