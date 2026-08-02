import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Path,
} from "effect";

import { resolvePgPassDatabaseUrl } from "../runtime/database-credentials.ts";
import { PgPassReaderLive } from "../runtime/database-credentials.ts";
import { loadDrizzleConfig } from "../runtime/drizzle-config.ts";

const platform = Layer.mergeAll(
  BunFileSystem.layer,
  BunPath.layer,
  PgPassReaderLive.pipe(Layer.provide(BunFileSystem.layer)),
);

function environment(values: Readonly<Record<string, string>>) {
  return ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...values } }));
}

describe("Drizzle database credentials", () => {
  it.effect("adds the matching pgpass password to an in-memory connection URL", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-pgpass-",
      });
      const pgPassFile = paths.join(directory, ".pgpass");
      yield* fileSystem.writeFileString(
        pgPassFile,
        "postgres.example:5433:agentos:fleet_owner:secret-value\n",
        { mode: 0o600 },
      );

      const resolved = yield* resolvePgPassDatabaseUrl(
        "postgresql://fleet_owner@postgres.example:5433/agentos?sslmode=require",
      ).pipe(Effect.provide(environment({
        HOME: directory,
        PGPASSFILE: pgPassFile,
      })));
      const url = new URL(resolved);

      assert.strictEqual(url.password, "secret-value");
      assert.strictEqual(url.searchParams.get("sslmode"), "require");
    }).pipe(Effect.provide(platform))));

  it.effect("preserves an explicit URL password without opening pgpass", () =>
    Effect.gen(function*() {
      const databaseUrl =
        "postgresql://fleet_owner:already-set@postgres.example/agentos";
      const resolved = yield* resolvePgPassDatabaseUrl(databaseUrl).pipe(
        Effect.provide(environment({ HOME: "/unobserved" })),
        Effect.provide(platform),
      );
      assert.strictEqual(resolved, databaseUrl);
    }));

  it.effect("fails in the typed channel for an invalid database URL", () =>
    Effect.gen(function*() {
      const failure = yield* resolvePgPassDatabaseUrl("not-a-url").pipe(
        Effect.provide(environment({ HOME: "/unobserved" })),
        Effect.provide(platform),
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "DatabaseCredentialError");
      assert.strictEqual(failure.code, "invalid_database_url");
    }));

  it.effect("builds Drizzle configuration from typed Effect Config", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-drizzle-config-",
      });
      const pgPassFile = paths.join(directory, ".pgpass");
      yield* fileSystem.writeFileString(
        pgPassFile,
        "postgres.example:5432:agentos:fleet_owner:secret-value\n",
        { mode: 0o600 },
      );
      const config = yield* loadDrizzleConfig.pipe(
        Effect.provide(environment({
          DATABASE_URL:
            "postgresql://fleet_owner@postgres.example/agentos",
          HOME: directory,
          PGPASSFILE: pgPassFile,
        })),
      );

      assert.deepStrictEqual(config, {
        dialect: "postgresql",
        schema: "./drizzle.tooling.ts",
        out: "./migrations",
        dbCredentials: {
          url: "postgresql://fleet_owner:secret-value@postgres.example/agentos",
        },
      });
    }).pipe(Effect.provide(platform))));
});
