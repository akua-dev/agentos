import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const ids = {
  crew: "20000000-0000-4000-8000-000000000014",
  destination: "20000000-0000-4000-8000-000000000012",
  project: "30000000-0000-4000-8000-000000000001",
  reviewAssignment: "50000000-0000-4000-8000-000000000003",
  reviewTask: "40000000-0000-4000-8000-000000000003",
  scout: "20000000-0000-4000-8000-000000000011",
  secondMate: "20000000-0000-4000-8000-000000000013",
  scoutAssignment: "50000000-0000-4000-8000-000000000001",
  scoutTask: "40000000-0000-4000-8000-000000000001",
  shipAssignment: "50000000-0000-4000-8000-000000000002",
  shipTask: "40000000-0000-4000-8000-000000000002",
};

const fleetRootId = Effect.fn("test.coordination.fleetRootId")(function*() {
  const database = yield* PGliteTestDatabase;
  const roots = yield* database.query<{ readonly id: string }>(`
    SELECT id::text AS id FROM agentos.agents WHERE role = 'first_mate'
  `);
  return (yield* firstRow(roots, "test Fleet has no First Mate")).id;
});

const databaseLayer = makePGliteTestLayer({
  migrations: "all",
  setup: (database) => Effect.gen(function*() {
    const roots = yield* database.query<{ readonly id: string }>(`
      SELECT id::text AS id FROM agentos.agents WHERE role = 'first_mate'
    `);
    const firstMateId = (yield* firstRow(
      roots,
      "test Fleet has no First Mate",
    )).id;
    yield* database.exec(`
      CREATE ROLE coordination_second LOGIN;
      CREATE ROLE coordination_crew LOGIN;

      INSERT INTO agentos.projects (
        id, name, scope_text, status, status_text
      ) VALUES (
        '${ids.project}', 'coordination-contracts',
        'Exercise durable Fleet coordination', 'active', 'Project ready'
      );

      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES
        (
          '${ids.scout}', 'coordination-scout', 'crewmate', '${firstMateId}',
          'codex', 'active', 'Scout ready'
        ),
        (
          '${ids.destination}', 'coordination-destination', 'crewmate', '${firstMateId}',
          'codex', 'active', 'Destination ready'
        ),
        (
          '${ids.secondMate}', 'coordination-second', 'second_mate', '${firstMateId}',
          'pi', 'active', 'Second Mate ready'
        ),
        (
          '${ids.crew}', 'coordination-crew', 'crewmate', '${ids.secondMate}',
          'codex', 'active', 'Crewmate ready'
        );

      SELECT agentos.register_agent_principal('${ids.secondMate}', 'coordination_second');
      SELECT agentos.register_agent_principal('${ids.crew}', 'coordination_crew');
    `);
  }),
});

layer(databaseLayer)("durable Fleet coordination contracts", (it) => {
  it.effect("exposes the complete handoff contract", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const signatures = yield* database.query<{ readonly arguments: string }>(`
        SELECT pg_get_function_identity_arguments(procedure.oid) AS arguments
          FROM pg_proc AS procedure
          JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
         WHERE namespace.nspname = 'agentos'
           AND procedure.proname = 'handoff_task_assignment'
      `);
      assert.deepStrictEqual(signatures, [{
        arguments:
          "p_assignment_id uuid, p_destination_agent_id uuid, p_brief text, p_report text, p_status_text text",
      }]);
    }));

  it.effect("stores explicit Assignment artifacts without shared preference state", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const columns = yield* database.query<{ readonly column_name: string }>(`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'agentos'
           AND table_name = 'task_assignments'
           AND column_name IN (
             'brief', 'report', 'supersedes_assignment_id',
             'decision_keys', 'decisions_attested_at',
             'decisions_attested_by_agent_id'
           )
         ORDER BY ordinal_position
      `);
      assert.deepStrictEqual(columns.map(({ column_name }) => column_name), [
        "brief",
        "report",
        "supersedes_assignment_id",
        "decision_keys",
        "decisions_attested_at",
        "decisions_attested_by_agent_id",
      ]);

      const legacy = yield* database.query<{ readonly table_name: string | null }>(`
        SELECT to_regclass('agentos.captain')::text AS table_name
      `);
      assert.isNull((yield* firstRow(legacy, "missing legacy table result")).table_name);
    }));

  it.effect("requires a complete brief before dispatch and a report before ending", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const firstMateId = yield* fleetRootId();
      yield* database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, status, status_text
        ) VALUES (
          '${ids.shipTask}', '${ids.project}', '${firstMateId}',
          'Deliver a bounded change', 'active', 'Ready to assign'
        )
      `);
      const missingBrief = yield* Effect.flip(database.exec(`
        INSERT INTO agentos.task_assignments (
          id, task_id, agent_id, assigned_by_agent_id, assignment_role,
          status, status_text
        ) VALUES (
          '${ids.shipAssignment}', '${ids.shipTask}', '${ids.scout}',
          '${firstMateId}', 'ship', 'assigned', 'Missing its brief'
        )
      `));
      assert.include(missingBrief.detail, "Task Assignment requires a durable brief");

      yield* database.exec(`
        INSERT INTO agentos.task_assignments (
          id, task_id, agent_id, assigned_by_agent_id, assignment_role,
          status, status_text, brief, started_at
        ) VALUES (
          '${ids.shipAssignment}', '${ids.shipTask}', '${ids.scout}',
          '${firstMateId}', 'ship', 'active', 'Implementation started',
          '# Ship brief', transaction_timestamp()
        )
      `);
      const missingReport = yield* Effect.flip(database.exec(`
        UPDATE agentos.task_assignments
           SET status = 'completed',
               status_text = 'Claimed complete without a report',
               ended_at = transaction_timestamp()
         WHERE id = '${ids.shipAssignment}'
      `));
      assert.include(
        missingReport.detail,
        "ending a Task Assignment requires a durable report",
      );
    }));

  it.effect("hands off one stable Task with append-only Assignment history", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const handoffs = yield* database.query<{ readonly id: string }>(`
        SELECT agentos.handoff_task_assignment(
          '${ids.shipAssignment}',
          '${ids.destination}',
          '# Replacement brief',
          'The original worker preserved its current findings.',
          'Transferred after an explicit handoff'
        )::text AS id
      `);
      const replacementId = (yield* firstRow(handoffs, "handoff returned no row")).id;
      const repeated = yield* database.query<{ readonly id: string }>(`
        SELECT agentos.handoff_task_assignment(
          '${ids.shipAssignment}',
          '${ids.destination}',
          '# Replacement brief',
          'The original worker preserved its current findings.',
          'Transferred after an explicit handoff'
        )::text AS id
      `);
      assert.strictEqual(
        (yield* firstRow(repeated, "repeated handoff returned no row")).id,
        replacementId,
      );

      const assignments = yield* database.query<{
        readonly agent_id: string;
        readonly ended: boolean;
        readonly report: string | null;
        readonly supersedes_assignment_id: string | null;
        readonly task_id: string;
      }>(`
        SELECT agent_id::text,
               ended_at IS NOT NULL AS ended,
               report,
               supersedes_assignment_id::text,
               task_id::text
          FROM agentos.task_assignments
         WHERE task_id = '${ids.shipTask}'
         ORDER BY (supersedes_assignment_id IS NOT NULL), created_at, id
      `);
      assert.deepStrictEqual(assignments, [
        {
          agent_id: ids.scout,
          ended: true,
          report: "The original worker preserved its current findings.",
          supersedes_assignment_id: null,
          task_id: ids.shipTask,
        },
        {
          agent_id: ids.destination,
          ended: false,
          report: null,
          supersedes_assignment_id: ids.shipAssignment,
          task_id: ids.shipTask,
        },
      ]);
    }));

  it.effect("keeps decisions open after Scout completion and releases dependencies atomically", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const firstMateId = yield* fleetRootId();
      yield* database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, status, status_text
        ) VALUES (
          '${ids.scoutTask}', '${ids.project}', '${firstMateId}',
          'Investigate a product choice', 'active', 'Scout ready'
        );
        INSERT INTO agentos.task_assignments (
          id, task_id, agent_id, assigned_by_agent_id, assignment_role,
          status, status_text, brief, started_at
        ) VALUES (
          '${ids.scoutAssignment}', '${ids.scoutTask}', '${ids.scout}',
          '${firstMateId}', 'scout', 'active', 'Investigation started',
          '# Scout brief', transaction_timestamp()
        )
      `);

      const decisions = yield* database.query<{ readonly id: string }>(`
        SELECT agentos.hold_captain_decision(
          '${ids.scoutTask}',
          'product.default-topology',
          'Choose the default topology',
          'Should the default use the existing cluster or an isolated vCluster?',
          'Awaiting the Captain choice'
        )::text AS id
      `);
      const decisionId = (yield* firstRow(
        decisions,
        "Captain decision returned no row",
      )).id;

      yield* database.exec(`
        SELECT agentos.link_task_decision(
          '${ids.shipTask}',
          'product.default-topology',
          'Blocked on the default topology decision'
        );
        SELECT agentos.attest_assignment_decisions(
          '${ids.scoutAssignment}',
          ARRAY['product.default-topology']::text[]
        );
        UPDATE agentos.task_assignments
           SET status = 'completed',
               status_text = 'Investigation reported with one open Captain choice',
               report = 'Evidence and options are complete.',
               ended_at = transaction_timestamp()
         WHERE id = '${ids.scoutAssignment}';
      `);

      const stillOpen = yield* database.query<{ readonly count: number }>(`
        SELECT count(*)::int AS count
          FROM agentos.inbox
         WHERE id = '${decisionId}' AND resolved_at IS NULL
      `);
      assert.strictEqual(
        (yield* firstRow(stillOpen, "missing open-decision count")).count,
        1,
      );

      const answers = yield* database.query<{ readonly id: string }>(`
        SELECT agentos.resolve_captain_decision(
          '${decisionId}',
          'Use an isolated vCluster when sharing an existing production cluster.',
          'Captain selected the isolated path'
        )::text AS id
      `);
      const answerId = (yield* firstRow(answers, "decision answer returned no row")).id;
      const resolved = yield* database.query<{
        readonly answer: string;
        readonly decision_resolved: boolean;
        readonly dependencies: ReadonlyArray<unknown>;
      }>(`
        SELECT answer.body AS answer,
               decision.resolved_at IS NOT NULL AS decision_resolved,
               task.dependencies
          FROM agentos.inbox AS decision
          JOIN agentos.inbox AS answer ON answer.id = '${answerId}'
          JOIN agentos.tasks AS task ON task.id = '${ids.shipTask}'
         WHERE decision.id = '${decisionId}'
      `);
      assert.deepStrictEqual(resolved, [{
        answer: "Use an isolated vCluster when sharing an existing production cluster.",
        decision_resolved: true,
        dependencies: [],
      }]);
    }));

  it.effect("requires explicit empty decision attestation for a choice-free review", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const firstMateId = yield* fleetRootId();
      yield* database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, status, status_text
        ) VALUES (
          '${ids.reviewTask}', '${ids.project}', '${firstMateId}',
          'Review a bounded result', 'active', 'Review ready'
        );
        INSERT INTO agentos.task_assignments (
          id, task_id, agent_id, assigned_by_agent_id, assignment_role,
          status, status_text, brief, started_at
        ) VALUES (
          '${ids.reviewAssignment}', '${ids.reviewTask}', '${ids.destination}',
          '${firstMateId}', 'review', 'active', 'Review started',
          '# Review brief', transaction_timestamp()
        )
      `);

      const error = yield* Effect.flip(database.exec(`
        UPDATE agentos.task_assignments
           SET status = 'completed',
               status_text = 'Review complete',
               report = 'No unresolved Captain choices remain.',
               ended_at = transaction_timestamp()
         WHERE id = '${ids.reviewAssignment}'
      `));
      assert.include(error.detail, "exact Captain-decision attestation");

      yield* database.exec(`
        SELECT agentos.attest_assignment_decisions(
          '${ids.reviewAssignment}', ARRAY[]::text[]
        );
        UPDATE agentos.task_assignments
           SET status = 'completed',
               status_text = 'Review complete',
               report = 'No unresolved Captain choices remain.',
               ended_at = transaction_timestamp()
         WHERE id = '${ids.reviewAssignment}'
      `);
      const attested = yield* database.query<{
        readonly decision_keys: ReadonlyArray<string>;
      }>(`
        SELECT decision_keys
          FROM agentos.task_assignments
         WHERE id = '${ids.reviewAssignment}'
      `);
      assert.deepStrictEqual(
        (yield* firstRow(attested, "missing attestation row")).decision_keys,
        [],
      );
    }));
});
