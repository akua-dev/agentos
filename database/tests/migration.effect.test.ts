import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const databaseLayer = makePGliteTestLayer({
  migrations: [
    new URL("../migrations/0000_initial_fleet_schema.sql", import.meta.url),
    new URL("./0000_initial_fleet_schema.sql", import.meta.url),
  ],
});

layer(databaseLayer)("initial Fleet migration", (it) => {
  it.effect("enforces the fleet coordination contract", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const tables = yield* database.query<{ readonly table_name: string }>(`
        SELECT table_name
          FROM information_schema.tables
         WHERE table_schema = 'agentos'
         ORDER BY table_name
      `);

      assert.deepStrictEqual(tables.map(({ table_name }) => table_name), [
        "agents",
        "captain",
        "external_events",
        "inbox",
        "learnings",
        "projects",
        "task_assignments",
        "tasks",
      ]);

      const rolledBackRows = yield* database.query<{ readonly count: number }>(
        "SELECT count(*)::int AS count FROM agentos.agents",
      );
      assert.strictEqual(rolledBackRows[0]?.count, 0);
    }));
});
