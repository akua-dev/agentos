import { defineConfig } from "drizzle-kit";

import { resolvePgPassDatabaseUrl } from "./runtime/database-credentials";

const databaseUrl = process.env.DATABASE_URL;
const resolvedDatabaseUrl = databaseUrl
  ? resolvePgPassDatabaseUrl(databaseUrl)
  : undefined;

export default defineConfig({
  dialect: "postgresql",
  schema: "./drizzle.tooling.ts",
  out: "./migrations",
  ...(resolvedDatabaseUrl
    ? { dbCredentials: { url: resolvedDatabaseUrl } }
    : {}),
});
