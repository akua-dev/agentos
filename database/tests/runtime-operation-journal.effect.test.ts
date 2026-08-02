import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const ids = {
  assignmentA: "55000000-0000-4000-8000-000000000001",
  assignmentB: "55000000-0000-4000-8000-000000000002",
  crewA: "25000000-0000-4000-8000-000000000003",
  crewB: "25000000-0000-4000-8000-000000000005",
  operationA: "75000000-0000-4000-8000-000000000001",
  operationB: "75000000-0000-4000-8000-000000000002",
  operationC: "75000000-0000-4000-8000-000000000003",
  operationD: "75000000-0000-4000-8000-000000000004",
  project: "35000000-0000-4000-8000-000000000001",
  secondA: "25000000-0000-4000-8000-000000000002",
  secondB: "25000000-0000-4000-8000-000000000004",
  taskA: "45000000-0000-4000-8000-000000000001",
  taskB: "45000000-0000-4000-8000-000000000002",
};
const digests = {
  initial: "a".repeat(64),
  replacement: "b".repeat(64),
  teardown: "c".repeat(64),
};
const retainedA = JSON.stringify([
  {
    disposition: "retain",
    kind: "persistent_volume_claim",
    name: "data-runtime-crew-a-0",
  },
  {
    disposition: "retain",
    kind: "worktree",
    name: "runtime-crew-a-task",
  },
]);
const retainedB = JSON.stringify([{
  disposition: "retain",
  kind: "persistent_volume_claim",
  name: "data-runtime-crew-b-0",
}]);

const durableIdentityCounts = Effect.fn("test.runtimeJournal.identityCounts")(
  function*() {
    const database = yield* PGliteTestDatabase;
    const counts = yield* database.query<{
      readonly agents: number;
      readonly assignments: number;
      readonly tasks: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM agentos.agents) AS agents,
        (SELECT count(*)::int FROM agentos.task_assignments) AS assignments,
        (SELECT count(*)::int FROM agentos.tasks) AS tasks
    `);
    return yield* firstRow(counts, "missing durable identity counts");
  },
);

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
      CREATE ROLE journal_second_a LOGIN;
      CREATE ROLE journal_crew_a LOGIN;
      CREATE ROLE journal_second_b LOGIN;
      CREATE ROLE journal_crew_b LOGIN;

      INSERT INTO agentos.projects (
        id, name, scope_text, status, status_text
      ) VALUES (
        '${ids.project}', 'runtime-operation-journal',
        'Exercise resumable Agent runtime operations',
        'active', 'Runtime journal fixture ready'
      );

      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status,
        status_text, persistent_volume_claim
      ) VALUES
        ('${ids.secondA}', 'journal-second-a', 'second_mate', '${firstMateId}', 'pi', 'active', 'Second Mate A ready', NULL),
        ('${ids.crewA}', 'journal-crew-a', 'crewmate', '${ids.secondA}', 'codex', 'active', 'Crewmate A ready', 'data-runtime-crew-a-0'),
        ('${ids.secondB}', 'journal-second-b', 'second_mate', '${firstMateId}', 'pi', 'active', 'Second Mate B ready', NULL),
        ('${ids.crewB}', 'journal-crew-b', 'crewmate', '${ids.secondB}', 'codex', 'active', 'Crewmate B ready', 'data-runtime-crew-b-0');

      SELECT agentos.register_agent_principal('${ids.secondA}', 'journal_second_a');
      SELECT agentos.register_agent_principal('${ids.crewA}', 'journal_crew_a');
      SELECT agentos.register_agent_principal('${ids.secondB}', 'journal_second_b');
      SELECT agentos.register_agent_principal('${ids.crewB}', 'journal_crew_b');

      INSERT INTO agentos.tasks (
        id, project_id, created_by_agent_id, title, status, status_text
      ) VALUES
        ('${ids.taskA}', '${ids.project}', '${ids.secondA}', 'Recover Crew A runtime', 'active', 'Crew A owns active work'),
        ('${ids.taskB}', '${ids.project}', '${ids.secondB}', 'Finish Crew B before teardown', 'active', 'Crew B owns active work');

      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, brief
      ) VALUES
        ('${ids.assignmentA}', '${ids.taskA}', '${ids.crewA}', '${ids.secondA}', 'worker', 'assigned', 'Crew A runtime must recover', '# Recover the same Crew A runtime'),
        ('${ids.assignmentB}', '${ids.taskB}', '${ids.crewB}', '${ids.secondB}', 'worker', 'assigned', 'Crew B work is still active', '# Complete Crew B work before teardown');
    `);
  }),
});

const beginOperationA = Effect.fn("test.runtimeJournal.beginA")(function*() {
  const database = yield* PGliteTestDatabase;
  return yield* database.query<{ readonly id: string }>(`
    SELECT agentos.begin_runtime_operation(
      '${ids.operationA}', '${ids.crewA}', '${ids.assignmentA}',
      'agentos-domain-a', 'runtime-crew-a', 'recover',
      '${digests.initial}', '${retainedA}'::jsonb
    )::text AS id
  `);
});

layer(databaseLayer)("SQL-backed runtime operation journal", (it) => {
  it.effect("begins one hierarchy-owned operation and fails closed on conflicts", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const concurrent = yield* asLogin("journal_second_a", Effect.all([
        beginOperationA(),
        beginOperationA(),
      ], { concurrency: "unbounded" }));
      assert.deepStrictEqual(concurrent, [
        [{ id: ids.operationA }],
        [{ id: ids.operationA }],
      ]);
      assert.deepStrictEqual(
        yield* asLogin("journal_second_a", beginOperationA()),
        [{ id: ids.operationA }],
      );

      yield* asLogin("journal_second_a", Effect.gen(function*() {
        const errors = yield* Effect.forEach([
          database.query(`
            SELECT agentos.begin_runtime_operation(
              '${ids.operationA}', '${ids.crewA}', '${ids.assignmentA}',
              'agentos-domain-a', 'runtime-crew-a', 'recover',
              '${digests.replacement}', '${retainedA}'::jsonb
            )
          `),
          database.query(`
            SELECT agentos.begin_runtime_operation(
              '${ids.operationB}', '${ids.crewA}', '${ids.assignmentA}',
              'agentos-domain-a', 'runtime-crew-a', 'recover',
              '${digests.initial}', '${retainedA}'::jsonb
            )
          `),
          database.query(`
            SELECT agentos.begin_runtime_operation(
              '${ids.operationB}', '${ids.crewA}', '${ids.assignmentA}',
              'agentos-domain-a', 'runtime-crew-a', 'recover', '${digests.initial}',
              '[{"kind":"worktree","name":"crew-a","disposition":"retain","manifest":"forbidden"}]'::jsonb
            )
          `),
          database.query(`
            SELECT agentos.begin_runtime_operation(
              '${ids.operationB}', '${ids.crewA}', '${ids.assignmentA}',
              'agentos-domain-a', 'runtime-crew-a', 'recover',
              '${digests.initial}', NULL
            )
          `),
        ], Effect.flip);
        assert.include(errors[0]?.detail, "conflicts with the existing runtime operation");
        assert.include(errors[1]?.detail, "already has an active runtime operation");
        assert.include(errors[2]?.detail, "retained resources");
        assert.include(errors[3]?.detail, "retained resources");
      }));

      const ownerConflict = yield* Effect.flip(asLogin("postgres", beginOperationA()));
      assert.include(ownerConflict.detail, "conflicts with the existing runtime operation");
      const hierarchy = yield* Effect.flip(asLogin(
        "journal_second_b",
        database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationB}', '${ids.crewA}', '${ids.assignmentA}',
            'agentos-domain-a', 'runtime-crew-a', 'recover',
            '${digests.initial}', '${retainedA}'::jsonb
          )
        `),
      ));
      assert.include(hierarchy.detail, "managed hierarchy");

      const crewErrors = yield* asLogin("journal_crew_a", Effect.forEach([
        database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationB}', '${ids.crewA}', '${ids.assignmentA}',
            'agentos-domain-a', 'runtime-crew-a', 'recover',
            '${digests.initial}', '${retainedA}'::jsonb
          )
        `),
        database.exec(`
          INSERT INTO agentos.runtime_operations (
            id, agent_id, owner_agent_id, assignment_id,
            kubernetes_namespace, workload_name, action, render_digest,
            retained_resources, phase
          ) VALUES (
            '${ids.operationB}', '${ids.crewA}', '${ids.secondA}',
            '${ids.assignmentA}', 'agentos-domain-a', 'runtime-crew-a',
            'recover', '${digests.initial}', '${retainedA}'::jsonb, 'prepared'
          )
        `),
      ], Effect.flip));
      assert.strictEqual(crewErrors.length, 2);

      const visible = yield* asLogin("journal_crew_b", database.query<{
        readonly id: string;
        readonly owner_agent_id: string;
        readonly phase: string;
      }>(`
        SELECT id::text, owner_agent_id::text, phase
          FROM agentos.runtime_operations WHERE id = '${ids.operationA}'
      `));
      assert.deepStrictEqual(visible, [{
        id: ids.operationA,
        owner_agent_id: ids.secondA,
        phase: "prepared",
      }]);
    }));

  it.effect("records boundaries, repair-forward recovery, and immutable completion", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const transitions: ReadonlyArray<readonly [string, string | null]> = [
        ["recovery_required", "prepare_interrupted"],
        ["prepared", null],
        ["applied", null],
        ["recovery_required", "apply_interrupted"],
        ["applied", null],
        ["workload_ready", null],
        ["recovery_required", "workload_wait_interrupted"],
        ["workload_ready", null],
        ["harness_ready", null],
        ["recovery_required", "harness_confirmation_interrupted"],
        ["harness_ready", null],
      ];
      yield* asLogin("journal_second_a", Effect.gen(function*() {
        yield* Effect.forEach(transitions, ([phase, decision]) =>
          database.query<{ readonly phase: string }>(`
            SELECT agentos.observe_runtime_operation(
              '${ids.operationA}', '${phase}',
              ${decision === null ? "NULL" : `'${decision}'`}
            ) AS phase
          `).pipe(Effect.tap((observed) => Effect.sync(() => {
            assert.deepStrictEqual(observed, [{ phase }]);
          }))), { discard: true });

        const completed = yield* database.query<{ readonly phase: string }>(`
          SELECT agentos.complete_runtime_operation('${ids.operationA}') AS phase
        `);
        assert.deepStrictEqual(completed, [{ phase: "completed" }]);
        assert.deepStrictEqual(
          yield* database.query(`
            SELECT agentos.complete_runtime_operation('${ids.operationA}') AS phase
          `),
          [{ phase: "completed" }],
        );
        const immutable = yield* Effect.flip(database.query(`
          SELECT agentos.observe_runtime_operation(
            '${ids.operationA}', 'harness_ready', NULL
          )
        `));
        assert.include(immutable.detail, "completed runtime operation is immutable");
        const direct = yield* Effect.flip(database.exec(`
          UPDATE agentos.runtime_operations SET phase = 'failed'
           WHERE id = '${ids.operationA}'
        `));
        assert.strictEqual(direct.operation, "exec");
      }));

      const ownerRewrite = yield* Effect.flip(asLogin("postgres", database.exec(`
        UPDATE agentos.runtime_operations SET decision_code = 'owner_rewrite'
         WHERE id = '${ids.operationA}'
      `)));
      assert.include(ownerRewrite.detail, "completed runtime operation is immutable");
      const events = yield* database.query<{
        readonly decision_code: string | null;
        readonly phase: string;
        readonly sequence: number;
      }>(`
        SELECT sequence, phase, decision_code
          FROM agentos.runtime_operation_events
         WHERE operation_id = '${ids.operationA}' ORDER BY sequence
      `);
      assert.deepStrictEqual(events.map(({ phase }) => phase), [
        "prepared",
        ...transitions.map(([phase]) => phase),
        "completed",
      ]);
      assert.deepStrictEqual(events.at(-1), {
        decision_code: null,
        phase: "completed",
        sequence: transitions.length + 2,
      });
    }));

  it.effect("supersedes without replacing durable Agent or work identity", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const countsBefore = yield* durableIdentityCounts();
      yield* asLogin("journal_second_a", Effect.gen(function*() {
        yield* database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationB}', '${ids.crewA}', '${ids.assignmentA}',
            'agentos-domain-a', 'runtime-crew-a', 'rollout',
            '${digests.initial}', '${retainedA}'::jsonb
          )
        `);
        yield* database.query(`
          SELECT agentos.fail_runtime_operation(
            '${ids.operationB}', 'desired_render_changed'
          )
        `);
        const replacement = yield* database.query<{ readonly id: string }>(`
          SELECT agentos.supersede_runtime_operation(
            '${ids.operationB}', '${ids.operationC}',
            '${digests.replacement}', '${retainedA}'::jsonb,
            'replace_desired_render'
          )::text AS id
        `);
        assert.deepStrictEqual(replacement, [{ id: ids.operationC }]);
        assert.deepStrictEqual(yield* database.query(`
          SELECT agentos.supersede_runtime_operation(
            '${ids.operationB}', '${ids.operationC}',
            '${digests.replacement}', '${retainedA}'::jsonb,
            'replace_desired_render'
          )::text AS id
        `), [{ id: ids.operationC }]);
        const conflict = yield* Effect.flip(database.query(`
          SELECT agentos.supersede_runtime_operation(
            '${ids.operationB}', '${ids.operationC}',
            '${digests.initial}', '${retainedA}'::jsonb,
            'replace_desired_render'
          )
        `));
        assert.include(conflict.detail, "conflicts with the replacement runtime operation");
        const failed = yield* database.query<{ readonly phase: string }>(`
          SELECT agentos.fail_runtime_operation(
            '${ids.operationC}', 'replacement_admission_rejected'
          ) AS phase
        `);
        assert.deepStrictEqual(failed, [{ phase: "failed" }]);
        assert.deepStrictEqual(yield* database.query(`
          SELECT agentos.fail_runtime_operation(
            '${ids.operationC}', 'replacement_admission_rejected'
          ) AS phase
        `), [{ phase: "failed" }]);
      }));

      const operations = yield* database.query<{
        readonly id: string;
        readonly phase: string;
        readonly supersedes_operation_id: string | null;
      }>(`
        SELECT id::text, phase, supersedes_operation_id::text
          FROM agentos.runtime_operations
         WHERE id IN ('${ids.operationB}', '${ids.operationC}') ORDER BY id
      `);
      assert.deepStrictEqual(operations, [
        { id: ids.operationB, phase: "superseded", supersedes_operation_id: null },
        { id: ids.operationC, phase: "failed", supersedes_operation_id: ids.operationB },
      ]);
      assert.deepStrictEqual(yield* durableIdentityCounts(), countsBefore);
    }));

  it.effect("requires ended work and retained-PVC disposition before teardown", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const activeWork = yield* Effect.flip(asLogin(
        "journal_second_b",
        database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationD}', '${ids.crewB}', '${ids.assignmentB}',
            'agentos-domain-b', 'runtime-crew-b', 'teardown',
            '${digests.teardown}', '${retainedB}'::jsonb
          )
        `),
      ));
      assert.include(activeWork.detail, "teardown requires ended work");
      yield* database.exec(`
        UPDATE agentos.task_assignments
           SET status = 'completed',
               status_text = 'Crew B work ended before teardown',
               report = '# Crew B final report',
               started_at = transaction_timestamp(),
               ended_at = transaction_timestamp()
         WHERE id = '${ids.assignmentB}'
      `);

      yield* asLogin("journal_second_b", Effect.gen(function*() {
        const disposition = yield* Effect.flip(database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationD}', '${ids.crewB}', '${ids.assignmentB}',
            'agentos-domain-b', 'runtime-crew-b', 'teardown',
            '${digests.teardown}', '[]'::jsonb
          )
        `));
        assert.include(disposition.detail, "explicit retained PVC disposition");
        const begun = yield* database.query<{ readonly id: string }>(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationD}', '${ids.crewB}', '${ids.assignmentB}',
            'agentos-domain-b', 'runtime-crew-b', 'teardown',
            '${digests.teardown}', '${retainedB}'::jsonb
          )::text AS id
        `);
        assert.deepStrictEqual(begun, [{ id: ids.operationD }]);
        yield* database.query(`
          SELECT agentos.observe_runtime_operation(
            '${ids.operationD}', 'applied', NULL
          )
        `);
        assert.deepStrictEqual(yield* database.query(`
          SELECT agentos.complete_runtime_operation('${ids.operationD}') AS phase
        `), [{ phase: "completed" }]);
      }));

      assert.deepStrictEqual(yield* durableIdentityCounts(), {
        agents: 5,
        assignments: 2,
        tasks: 2,
      });
      const retained = yield* database.query<{
        readonly persistent_volume_claim: string;
      }>(`
        SELECT persistent_volume_claim FROM agentos.agents
         WHERE id = '${ids.crewB}'
      `);
      assert.deepStrictEqual(retained, [{
        persistent_volume_claim: "data-runtime-crew-b-0",
      }]);
    }));
});
