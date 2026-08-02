import { Config, Effect, Option } from "effect";

import { resolvePgPassDatabaseUrl } from "./database-credentials.ts";

export interface AgentOSDrizzleConfig {
  readonly dialect: "postgresql";
  readonly schema: "./drizzle.tooling.ts";
  readonly out: "./migrations";
  readonly dbCredentials?: { readonly url: string };
}

export const loadDrizzleConfig = Effect.gen(function*() {
  const databaseUrl = yield* Config.option(Config.string("DATABASE_URL")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const base: AgentOSDrizzleConfig = {
    dialect: "postgresql",
    schema: "./drizzle.tooling.ts",
    out: "./migrations",
  };
  if (Option.isNone(databaseUrl)) return base;
  const resolved = yield* resolvePgPassDatabaseUrl(databaseUrl.value);
  return {
    ...base,
    dbCredentials: { url: resolved },
  } satisfies AgentOSDrizzleConfig;
});
