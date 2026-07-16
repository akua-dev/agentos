import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./drizzle.tooling.ts",
  out: "./migrations",
  ...(databaseUrl ? { dbCredentials: { url: databaseUrl } } : {}),
});
