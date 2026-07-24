import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);

const ids = {
  assignment: "50000000-0000-4000-8000-000000000091",
  authority: "10000000-0000-4000-8000-000000000091",
  childAssignment: "50000000-0000-4000-8000-000000000092",
  childTask: "40000000-0000-4000-8000-000000000092",
  unrelatedAuthority: "10000000-0000-4000-8000-000000000092",
  crewmate: "20000000-0000-4000-8000-000000000091",
  firstMate: "",
  legacyAssignment: "50000000-0000-4000-8000-000000000094",
  legacyCrewmate: "20000000-0000-4000-8000-000000000094",
  legacyProject: "30000000-0000-4000-8000-000000000094",
  legacyTask: "40000000-0000-4000-8000-000000000094",
  project: "30000000-0000-4000-8000-000000000091",
  secondMate: "20000000-0000-4000-8000-000000000092",
  task: "40000000-0000-4000-8000-000000000091",
};

function material(
  id: string,
  kind: "instructions" | "skill",
) {
  return {
    id,
    kind,
    origin: {
      kind: "git",
      locator: "github.com/example/company-capabilities",
      path: `materials/${id}`,
      revision: "0123456789abcdef",
    },
    digest: `sha256:${id.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)}`,
    entrypoint:
      kind === "skill"
        ? "SKILL.md"
        : "instructions.md",
  };
}

function manifest(harness = "pi") {
  return {
    version: 1,
    composer: {
      id: "agentos-composition",
      origin: {
        kind: "git",
        locator: "github.com/akua-dev/agentos",
        path: "agents/.agents/skills/agentos-composition",
        revision: "0123456789abcdef",
      },
      digest: `sha256:${"a".repeat(64)}`,
    },
    materials: [
      material("instructions", "instructions"),
      material("delivery", "skill"),
    ],
    harness,
    settings: {
      model: "gpt-5.6-sol",
      effort: "xhigh",
      fast_mode: true,
      compaction: { strategy: "server" },
      context_limit: 200_000,
      image: "registry.example/agent@sha256:1234",
    },
    capability_requirements: [
      {
        id: "github:repository",
        access: "contents:write,pull_requests:write",
        authority_ref: "captain:github-app",
      },
    ],
  };
}

function json(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

beforeAll(async () => {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  const compositionMigration = files.find(
    (file) => file === "0011_agent_composition.sql",
  );
  if (!compositionMigration) {
    throw new Error("Composition migration is missing");
  }

  for (const file of files.filter((file) => file !== compositionMigration)) {
    const migration = await import(new URL(file, migrationsDirectory).href, {
      with: { type: "text" },
    });
    await database.exec(migration.default);
  }

  const root = await database.query<{ id: string }>(`
    SELECT id::text AS id
      FROM agentos.agents
     WHERE role = 'first_mate'
  `);
  ids.firstMate = root.rows[0]!.id;

  await database.exec(`
    INSERT INTO agentos.projects (
      id, name, scope_text, status, status_text
    ) VALUES (
      '${ids.legacyProject}', 'legacy-composition',
      'Prove dispatch profile upgrade', 'active', 'Project ready'
    );

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES (
      '${ids.legacyCrewmate}', 'legacy-composition-crew', 'crewmate',
      '${ids.firstMate}', 'codex', 'active', 'Crewmate ready'
    );

    INSERT INTO agentos.tasks (
      id, project_id, created_by_agent_id, title, status, status_text
    ) VALUES (
      '${ids.legacyTask}', '${ids.legacyProject}', '${ids.firstMate}',
      'Upgrade a legacy profile', 'active', 'Ready'
    );

    INSERT INTO agentos.task_assignments (
      id, task_id, agent_id, assigned_by_agent_id, assignment_role, status,
      status_text, brief, report, dispatch_profile, started_at, ended_at
    ) VALUES (
      '${ids.legacyAssignment}', '${ids.legacyTask}', '${ids.legacyCrewmate}',
      '${ids.firstMate}', 'worker', 'completed', 'Legacy work completed',
      'Prove the migration preserves every native knob.',
      'Legacy work remains immutable after its representation upgrade.',
      '{"harness":"codex","version":"native-setting","model":"gpt-5.6-sol","effort":"medium","fast_mode":true,"compaction":{"strategy":"server"},"context_limit":200000}'::jsonb,
      transaction_timestamp() - interval '1 minute',
      transaction_timestamp()
    );

    UPDATE agentos.agents
       SET harness = 'codex-next'
     WHERE id = '${ids.legacyCrewmate}';
  `);

  const migration = await import(
    new URL(compositionMigration, migrationsDirectory).href,
    { with: { type: "text" } },
  );
  await database.exec(migration.default);

  await database.exec(`
    CREATE ROLE composition_second LOGIN;
    CREATE ROLE composition_crew LOGIN;

    INSERT INTO agentos.projects (
      id, name, scope_text, status, status_text
    ) VALUES (
      '${ids.project}', 'composition-contracts',
      'Exercise resolved Agent composition', 'active', 'Project ready'
    );

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES
      (
        '${ids.secondMate}', 'composition-second', 'second_mate',
        '${ids.firstMate}', 'pi', 'active', 'Second Mate ready'
      ),
      (
        '${ids.crewmate}', 'composition-crew', 'crewmate',
        '${ids.secondMate}', 'codex', 'active', 'Crewmate ready'
      );

    SELECT agentos.register_agent_principal(
      '${ids.secondMate}', 'composition_second'
    );
    SELECT agentos.register_agent_principal(
      '${ids.crewmate}', 'composition_crew'
    );
  `);
});

afterAll(async () => {
  await database.close();
});

describe.serial("resolved Agent composition manifests", () => {
  test("upgrades every legacy runtime knob into opaque settings", async () => {
    const upgraded = await database.query<{ dispatch_profile: unknown }>(`
      SELECT dispatch_profile
        FROM agentos.task_assignments
       WHERE id = '${ids.legacyAssignment}'
    `);

    expect(upgraded.rows[0]?.dispatch_profile).toEqual({
      version: 1,
      harness: "codex",
      materials: [],
      settings: {
        version: "native-setting",
        model: "gpt-5.6-sol",
        effort: "medium",
        fast_mode: true,
        compaction: { strategy: "server" },
        context_limit: 200_000,
      },
    });

    await expect(
      database.exec(`
        UPDATE agentos.task_assignments
           SET status_text = 'Rewrite completed history after upgrade.'
         WHERE id = '${ids.legacyAssignment}'
      `),
    ).rejects.toThrow("completed Task assignment is immutable");
  });

  test("stores the same versioned contract at Agent and Assignment scope", async () => {
    const firstMateManifest = manifest();
    const crewmateManifest = manifest("codex");

    await database.exec(`
      UPDATE agentos.agents
         SET resolved_composition = ${json(firstMateManifest)}
       WHERE id = '${ids.firstMate}';

      INSERT INTO agentos.tasks (
        id, project_id, created_by_agent_id, title, status, status_text
      ) VALUES (
        '${ids.task}', '${ids.project}', '${ids.secondMate}',
        'Validate composition', 'active', 'Ready for bounded work'
      );

      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role, status,
        status_text, brief, dispatch_profile
      ) VALUES (
        '${ids.assignment}', '${ids.task}', '${ids.crewmate}',
        '${ids.secondMate}', 'worker', 'assigned',
        'Composition selected', 'Validate the composition contract.',
        ${json(crewmateManifest)}
      );
    `);

    const stored = await database.query<{
      assignment: unknown;
      persistent: unknown;
    }>(`
      SELECT agent.resolved_composition AS persistent,
             assignment.dispatch_profile AS assignment
        FROM agentos.agents AS agent
        JOIN agentos.task_assignments AS assignment
          ON assignment.id = '${ids.assignment}'
       WHERE agent.id = '${ids.firstMate}'
    `);

    expect(stored.rows[0]).toEqual({
      assignment: crewmateManifest,
      persistent: firstMateManifest,
    });
  });

  test("rejects malformed versions, executable material kinds and unsafe provenance", async () => {
    const invalid: unknown[] = [
      (({ version: _, ...candidate }) => candidate)(manifest()),
      (({ materials: _, ...candidate }) => candidate)(manifest()),
      { ...manifest(), version: 2 },
      { ...manifest(), harness: "\t" },
      { ...manifest(), settings: [] },
      { ...manifest(), fast_mode: true },
      {
        ...manifest(),
        materials: [
          (({ origin: _, ...candidate }) => candidate)(
            material("missing-origin", "skill"),
          ),
        ],
      },
      {
        ...manifest(),
        materials: [{ ...material("invalid", "skill"), kind: "mise_config" }],
      },
      {
        ...manifest(),
        materials: [
          { ...material("invalid", "skill"), kind: "harness_extension" },
        ],
      },
      {
        ...manifest(),
        materials: [
          material("duplicate", "skill"),
          material("duplicate", "skill"),
        ],
      },
      {
        ...manifest(),
        materials: [
          { ...material("escape", "skill"), entrypoint: "../SKILL.md" },
        ],
      },
      {
        ...manifest(),
        materials: [
          {
            ...material("missing-origin", "skill"),
            origin: { kind: "git", locator: "" },
          },
        ],
      },
      {
        ...manifest(),
        materials: [
          {
            ...material("blank-origin", "skill"),
            origin: { kind: "git", locator: "   " },
          },
        ],
      },
      {
        ...manifest(),
        materials: [
          {
            ...material("tab-origin", "skill"),
            origin: { kind: "git", locator: "\t" },
          },
        ],
      },
      {
        ...manifest(),
        capability_requirements: [{ id: "\t", access: "read" }],
      },
    ];

    for (const candidate of invalid) {
      await expect(
        database.exec(`
          UPDATE agentos.agents
             SET resolved_composition = ${json(candidate)}
           WHERE id = '${ids.firstMate}'
        `),
      ).rejects.toThrow();
    }
  });

  test("requires each scoped manifest harness to match its Agent", async () => {
    await expect(
      database.exec(`
        UPDATE agentos.agents
           SET resolved_composition = ${json(manifest("codex"))}
         WHERE id = '${ids.firstMate}'
      `),
    ).rejects.toThrow("composition harness must match the Agent");

    await expect(
      database.exec(`
        UPDATE agentos.task_assignments
           SET dispatch_profile = ${json(manifest())}
         WHERE id = '${ids.assignment}'
      `),
    ).rejects.toThrow("composition harness must match the assigned Agent");

    await expect(
      database.exec(`
        UPDATE agentos.agents
           SET resolved_composition = ${json(manifest("codex"))}
         WHERE id = '${ids.crewmate}'
      `),
    ).rejects.toThrow(
      "persistent composition is limited to First and Second Mates",
    );
  });

  test("keeps composition readable Fleet-wide without granting child mutation", async () => {
    await asRole("composition_second", async () => {
      const visible = await database.query<{ resolved_composition: unknown }>(`
        SELECT resolved_composition
          FROM agentos.agents
         WHERE id = '${ids.firstMate}'
      `);
      expect(visible.rows[0]?.resolved_composition).toEqual(manifest());

      await database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, status, status_text
        ) VALUES (
          '${ids.childTask}', '${ids.project}', '${ids.secondMate}',
          'Dispatch a validated composition', 'active',
          'Ready for the direct Crewmate'
        );

        INSERT INTO agentos.task_assignments (
          id, task_id, agent_id, assigned_by_agent_id, assignment_role, status,
          status_text, brief, dispatch_profile
        ) VALUES (
          '${ids.childAssignment}', '${ids.childTask}', '${ids.crewmate}',
          '${ids.secondMate}', 'worker', 'assigned',
          'Composition validated', 'Use the exact selected material.',
          ${json(manifest("codex"))}
        );
      `);

      await expect(
        database.exec(`
          UPDATE agentos.agents
             SET resolved_composition = ${json(manifest())}
          WHERE id = '${ids.secondMate}'
        `),
      ).rejects.toThrow();

      await database.exec(`
        UPDATE agentos.task_assignments
           SET status = 'completed',
               status_text = 'Validation-only dispatch completed',
               report = 'The child accepted the versioned composition.',
               ended_at = transaction_timestamp()
         WHERE id = '${ids.childAssignment}'
      `);
    });

    await asRole("composition_crew", async () => {
      const visible = await database.query<{ count: number }>(`
        SELECT count(*)::int AS count
          FROM agentos.agents
         WHERE resolved_composition IS NOT NULL
      `);
      expect(visible.rows[0]?.count).toBe(1);

      await expect(
        database.exec(`
          UPDATE agentos.agents
             SET resolved_composition = ${json(manifest("codex"))}
           WHERE id = '${ids.crewmate}'
        `),
      ).rejects.toThrow();
    });
  });

  test("freezes an Assignment composition at start and prevents active harness drift", async () => {
    await database.exec(`
      UPDATE agentos.task_assignments
         SET status = 'active',
             status_text = 'Execution started',
             started_at = transaction_timestamp()
       WHERE id = '${ids.assignment}'
    `);

    await expect(
      database.exec(`
        UPDATE agentos.task_assignments
           SET brief = 'Rewrite the accepted work after launch.'
         WHERE id = '${ids.assignment}'
      `),
    ).rejects.toThrow("started Task Assignment");

    await expect(
      database.exec(`
        UPDATE agentos.task_assignments
           SET dispatch_profile = ${json({
             ...manifest("codex"),
             settings: { effort: "low" },
           })}
         WHERE id = '${ids.assignment}'
      `),
    ).rejects.toThrow("started Task Assignment");

    await database.exec(`
      SELECT set_config(
        'agentos.task_assignment_dispatch_repair',
        '${ids.assignment}',
        false
      )
    `);
    await expect(
      database.exec(`
        UPDATE agentos.task_assignments
           SET brief = 'Bypass the repair function.'
         WHERE id = '${ids.assignment}'
      `),
    ).rejects.toThrow("started Task Assignment");
    await database.exec(`
      SELECT set_config('agentos.task_assignment_dispatch_repair', '', false)
    `);

    await expect(
      database.exec(`
        UPDATE agentos.agents
           SET harness = 'pi'
         WHERE id = '${ids.crewmate}'
      `),
    ).rejects.toThrow("active Task Assignment");

    const repairedBrief =
      "Repair the corrupt dispatch while preserving the accepted outcome.";
    const repairedComposition = {
      ...manifest("codex"),
      settings: { effort: "low", recovery: "explicit" },
    };

    await asRole("composition_second", async () => {
      await expect(
        database.exec(`
          SELECT agentos.repair_task_assignment_dispatch(
            '${ids.assignment}',
            '${repairedBrief}',
            ${json(repairedComposition)},
            'Attempt to repair a started Assignment as Second Mate.'
          )
        `),
      ).rejects.toThrow();
    });

    await database.exec("BEGIN");
    try {
      await database.exec(`
        SELECT agentos.repair_task_assignment_dispatch(
          '${ids.assignment}',
          '${repairedBrief}',
          ${json(repairedComposition)},
          'Prove one repair does not lock unrelated Fleet assignments.'
        )
      `);
      const locks = await database.query<{ mode: string }>(`
        SELECT mode
          FROM pg_locks
         WHERE pid = pg_backend_pid()
           AND relation = 'agentos.task_assignments'::regclass
           AND granted
      `);
      expect(locks.rows.map((lock) => lock.mode)).not.toContain(
        "AccessExclusiveLock",
      );
    } finally {
      await database.exec("ROLLBACK");
    }

    await database.exec(`
      SELECT agentos.repair_task_assignment_dispatch(
        '${ids.assignment}',
        '${repairedBrief}',
        ${json(repairedComposition)},
        'Correct corrupt durable dispatch data after native inspection.'
      )
    `);

    const repaired = await database.query<{
      brief: string;
      dispatch_profile: unknown;
      metadata: {
        dispatch_repair: {
          changed_by_agent_id: string;
          previous_brief: string;
          previous_composition: unknown;
          reason: string;
        };
      };
    }>(`
      SELECT brief, dispatch_profile, metadata
        FROM agentos.task_assignments
       WHERE id = '${ids.assignment}'
    `);
    expect(repaired.rows[0]).toEqual({
      brief: repairedBrief,
      dispatch_profile: repairedComposition,
      metadata: {
        dispatch_repair: {
          changed_by_agent_id: ids.firstMate,
          previous_brief: "Validate the composition contract.",
          previous_composition: manifest("codex"),
          reason:
            "Correct corrupt durable dispatch data after native inspection.",
        },
      },
    });

    await database.exec(`
      UPDATE agentos.task_assignments
         SET status = 'completed',
             status_text = 'Composition contract verified',
             report = 'The original accepted composition completed.',
             ended_at = transaction_timestamp()
       WHERE id = '${ids.assignment}';

      UPDATE agentos.agents
         SET harness = 'pi'
       WHERE id = '${ids.crewmate}';
    `);

    await expect(
      database.exec(`
        SELECT agentos.repair_task_assignment_dispatch(
          '${ids.assignment}',
          'Rewrite completed work.',
          ${json(repairedComposition)},
          'Attempt to repair immutable completed history.'
        )
      `),
    ).rejects.toThrow("active started Task Assignment");
  });

  test("replaces and repairs persistent composition only through explicit Captain authority", async () => {
    await database.exec(`
      INSERT INTO agentos.captain (
        id, topic, content, source, recorded_by_agent_id
      ) VALUES
        (
          '${ids.authority}', 'agent-composition-authority',
          'First Mate may manage reviewed persistent Mate composition.',
          'Captain approval', '${ids.firstMate}'
        ),
        (
          '${ids.unrelatedAuthority}', 'captain-communication-surface',
          'Use the selected provider for concise Captain updates.',
          'Captain preference', '${ids.firstMate}'
        )
    `);

    const selected = manifest();
    await expect(
      database.exec(`
        SELECT agentos.replace_agent_composition(
          '${ids.secondMate}',
          ${json(selected)},
          '${ids.unrelatedAuthority}',
          'Treat an unrelated Captain preference as composition authority.'
        )
      `),
    ).rejects.toThrow("active Captain composition authority");

    await database.exec(`
      SELECT agentos.replace_agent_composition(
        '${ids.secondMate}',
        ${json(selected)},
        '${ids.authority}',
        'Apply the reviewed persistent Second Mate setup.'
      )
    `);

    const replaced = await database.query<{
      metadata: {
        composition_change: {
          authority_id: string;
          change_kind: string;
          changed_by_agent_id: string;
          previous: unknown;
          reason: string;
        };
      };
      resolved_composition: unknown;
    }>(`
      SELECT resolved_composition, metadata
        FROM agentos.agents
       WHERE id = '${ids.secondMate}'
    `);
    expect(replaced.rows[0]).toEqual({
      resolved_composition: selected,
      metadata: {
        composition_change: {
          authority_id: ids.authority,
          change_kind: "replace",
          changed_by_agent_id: ids.firstMate,
          previous: null,
          reason: "Apply the reviewed persistent Second Mate setup.",
        },
      },
    });

    const repaired = {
      ...selected,
      settings: { ...selected.settings, effort: "high" },
    };
    await database.exec(`
      SELECT agentos.repair_agent_composition(
        '${ids.secondMate}',
        ${json(repaired)},
        '${ids.authority}',
        'Correct an incorrectly recorded effort after inspecting native state.'
      )
    `);

    const repairedRow = await database.query<{
      metadata: {
        composition_change: {
          change_kind: string;
          previous: unknown;
          reason: string;
        };
      };
      resolved_composition: unknown;
    }>(`
      SELECT resolved_composition, metadata
        FROM agentos.agents
       WHERE id = '${ids.secondMate}'
    `);
    expect(repairedRow.rows[0]?.resolved_composition).toEqual(repaired);
    expect(repairedRow.rows[0]?.metadata.composition_change).toMatchObject({
      change_kind: "repair",
      previous: selected,
      reason:
        "Correct an incorrectly recorded effort after inspecting native state.",
    });

    await asRole("composition_second", async () => {
      await expect(
        database.exec(`
          SELECT agentos.replace_agent_composition(
            '${ids.secondMate}',
            ${json(selected)},
            '${ids.authority}',
            'Rewrite my own persistent composition.'
          )
        `),
      ).rejects.toThrow();
    });

    await expect(
      database.exec(`
        SELECT agentos.replace_agent_composition(
          '${ids.secondMate}',
          ${json(selected)},
          '10000000-0000-4000-8000-000000000099',
          'Use authority that does not exist.'
        )
      `),
    ).rejects.toThrow("active Captain composition authority");
  });
});

async function asRole<T>(role: string, operation: () => Promise<T>): Promise<T> {
  await database.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await operation();
  } finally {
    await database.exec("SET SESSION AUTHORIZATION postgres");
  }
}
