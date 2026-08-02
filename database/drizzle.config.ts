import { defineConfig } from "drizzle-kit";
import { Config, Effect, Option } from "effect";

const databaseUrl = Effect.runSync(
  Config.option(Config.string("DATABASE_URL")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  ),
);

export default defineConfig({
  dialect: "postgresql",
  schema: "./drizzle.tooling.ts",
  out: "./migrations",
  ...(Option.isSome(databaseUrl)
    ? { dbCredentials: { url: databaseUrl.value } }
    : {}),
});
