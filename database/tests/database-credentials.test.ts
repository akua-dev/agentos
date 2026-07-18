import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePgPassDatabaseUrl } from "../runtime/database-credentials";

const originalPgPassFile = process.env.PGPASSFILE;

afterEach(() => {
  if (originalPgPassFile === undefined) {
    delete process.env.PGPASSFILE;
  } else {
    process.env.PGPASSFILE = originalPgPassFile;
  }
});

describe("Drizzle database credentials", () => {
  test("adds the matching pgpass password to an in-memory connection URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-pgpass-"));
    const pgPassFile = join(directory, ".pgpass");
    await writeFile(
      pgPassFile,
      "postgres.example:5433:agentos:fleet_owner:secret-value\n",
      { mode: 0o600 },
    );
    process.env.PGPASSFILE = pgPassFile;

    try {
      const resolved = await resolvePgPassDatabaseUrl(
        "postgresql://fleet_owner@postgres.example:5433/agentos?sslmode=require",
      );
      const url = new URL(resolved);

      expect(url.password).toBe("secret-value");
      expect(url.searchParams.get("sslmode")).toBe("require");
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  test("preserves an explicit URL password", async () => {
    const databaseUrl = "postgresql://fleet_owner:already-set@postgres.example/agentos";

    expect(await resolvePgPassDatabaseUrl(databaseUrl)).toBe(databaseUrl);
  });
});
