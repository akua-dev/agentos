import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const ids = {
  backlogAssignment: "51000000-0000-4000-8000-000000000003",
  backlogTask: "41000000-0000-4000-8000-000000000003",
  crewA: "21000000-0000-4000-8000-000000000003",
  crewB: "21000000-0000-4000-8000-000000000005",
  firstAssignment: "51000000-0000-4000-8000-000000000001",
  firstTask: "41000000-0000-4000-8000-000000000001",
  historicalAssignment: "51000000-0000-4000-8000-000000000004",
  historicalTask: "41000000-0000-4000-8000-000000000004",
  invalidAssignment: "51000000-0000-4000-8000-000000000002",
  invalidTask: "41000000-0000-4000-8000-000000000002",
  project: "31000000-0000-4000-8000-000000000001",
  replacementCrew: "21000000-0000-4000-8000-000000000006",
  secondA: "21000000-0000-4000-8000-000000000002",
  secondB: "21000000-0000-4000-8000-000000000004",
};

interface AcceptedTaskRow {
  readonly accepted_assignment_id: string;
  readonly accepted_task_id: string;
}

const fleetRootId = Effect.fn("test.acceptance.fleetRootId")(function*() {
  const database = yield* PGliteTestDatabase;
  const roots = yield* database.query<{ readonly id: string }>(`
    SELECT id::text AS id FROM agentos.agents WHERE role = 'first_mate'
  `);
  return (yield* firstRow(roots, "test Fleet has no First Mate")).id;
});

const createAcceptedTask = Effect.fn("test.acceptance.create")(function*(
  overrides: {
    readonly agentId?: string;
    readonly assignmentId?: string;
    readonly brief?: string;
    readonly taskId?: string;
    readonly title?: string;
  } = {},
) {
  const database = yield* PGliteTestDatabase;
  const agentId = overrides.agentId ?? ids.crewA;
  const assignmentId = overrides.assignmentId ?? ids.firstAssignment;
  const brief = overrides.brief ?? "# Complete brief";
  const taskId = overrides.taskId ?? ids.firstTask;
  const title = overrides.title ?? "Implement atomic acceptance";
  return yield* database.query<AcceptedTaskRow>(`
    SELECT accepted_task_id::text, accepted_assignment_id::text
      FROM agentos.create_task_with_assignment(
        '${taskId}', '${assignmentId}', '${agentId}', '${ids.project}', NULL,
        '${title}', 'Create one accepted outcome.', 'active',
        'Accepted by the owning Mate', 'high', '[]'::jsonb, '[]'::jsonb,
        '{"source":"captain"}'::jsonb, 'ship', 'assigned',
        'Crewmate owns the accepted outcome', '${brief}',
        '{"acceptance":"initial"}'::jsonb
      )
  `);
});

const acceptBacklogTask = Effect.fn("test.acceptance.acceptBacklog")(function*(
  taskId: string,
  assignmentId: string,
) {
  const database = yield* PGliteTestDatabase;
  return yield* database.query<AcceptedTaskRow>(`
    SELECT accepted_task_id::text, accepted_assignment_id::text
      FROM agentos.accept_backlog_task(
        '${taskId}', '${assignmentId}', '${ids.crewA}', 'active',
        'Accepted from deliberate backlog', 'ship', 'assigned',
        'Crewmate owns the accepted backlog outcome',
        '# Backlog acceptance brief', '{"acceptance":"backlog"}'::jsonb
      )
  `);
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
      CREATE ROLE acceptance_second_a LOGIN;
      CREATE ROLE acceptance_crew_a LOGIN;
      CREATE ROLE acceptance_second_b LOGIN;
      CREATE ROLE acceptance_crew_b LOGIN;
      CREATE ROLE acceptance_unregistered LOGIN;

      INSERT INTO agentos.projects (
        id, name, scope_text, status, status_text
      ) VALUES (
        '${ids.project}', 'atomic-acceptance',
        'Exercise atomic Task acceptance', 'active', 'Project ready'
      );

      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES
        ('${ids.secondA}', 'acceptance-second-a', 'second_mate', '${firstMateId}', 'pi', 'active', 'Second Mate A ready'),
        ('${ids.crewA}', 'acceptance-crew-a', 'crewmate', '${ids.secondA}', 'codex', 'active', 'Crewmate A ready'),
        ('${ids.secondB}', 'acceptance-second-b', 'second_mate', '${firstMateId}', 'pi', 'active', 'Second Mate B ready'),
        ('${ids.crewB}', 'acceptance-crew-b', 'crewmate', '${ids.secondB}', 'codex', 'active', 'Crewmate B ready'),
        ('${ids.replacementCrew}', 'acceptance-replacement', 'crewmate', '${ids.secondA}', 'codex', 'active', 'Replacement ready');

      SELECT agentos.register_agent_principal('${ids.secondA}', 'acceptance_second_a');
      SELECT agentos.register_agent_principal('${ids.crewA}', 'acceptance_crew_a');
      SELECT agentos.register_agent_principal('${ids.secondB}', 'acceptance_second_b');
      SELECT agentos.register_agent_principal('${ids.crewB}', 'acceptance_crew_b');
    `);
  }),
});

layer(databaseLayer)("atomic Task acceptance", (it) => {
  it.effect("creates one Task and Assignment and retries immutable input", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin("acceptance_second_a", Effect.gen(function*() {
        const accepted = yield* createAcceptedTask();
        assert.deepStrictEqual(accepted, [{
          accepted_assignment_id: ids.firstAssignment,
          accepted_task_id: ids.firstTask,
        }]);
        yield* database.exec(`
          UPDATE agentos.tasks
             SET status = 'in_progress',
                 status_text = 'Crewmate started after acceptance'
           WHERE id = '${ids.firstTask}'
        `);
        assert.deepStrictEqual(yield* createAcceptedTask(), accepted);
        const titleConflict = yield* Effect.flip(createAcceptedTask({
          title: "Conflicting reuse",
        }));
        assert.include(titleConflict.detail, "conflicts with the original acceptance request");
        const taskConflict = yield* Effect.flip(createAcceptedTask({
          assignmentId: ids.firstAssignment,
          taskId: "41000000-0000-4000-8000-000000000099",
        }));
        assert.include(taskConflict.detail, "conflicts with the original acceptance request");
      }));

      const stored = yield* database.query<{
        readonly assignments: number;
        readonly request_actor: string;
        readonly tasks: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM agentos.tasks WHERE id = '${ids.firstTask}') AS tasks,
          (SELECT count(*)::int FROM agentos.task_assignments WHERE id = '${ids.firstAssignment}') AS assignments,
          (SELECT acceptance_request ->> 'actor_id' FROM agentos.task_assignments WHERE id = '${ids.firstAssignment}') AS request_actor
      `);
      assert.deepStrictEqual(stored, [{
        assignments: 1,
        request_actor: ids.secondA,
        tasks: 1,
      }]);
      const immutable = yield* Effect.flip(database.exec(`
        UPDATE agentos.task_assignments
           SET acceptance_request = '{}'::jsonb
         WHERE id = '${ids.firstAssignment}'
      `));
      assert.include(immutable.detail, "acceptance request is immutable");
    }));

  it.effect("keeps Fleet-owner acceptance available to First Mate", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const assignmentId = "51000000-0000-4000-8000-000000000010";
      const taskId = "41000000-0000-4000-8000-000000000010";
      assert.deepStrictEqual(yield* createAcceptedTask({
        agentId: ids.crewB,
        assignmentId,
        taskId,
        title: "First Mate accepted outcome",
      }), [{ accepted_assignment_id: assignmentId, accepted_task_id: taskId }]);
      const actors = yield* database.query<{ readonly actor_id: string }>(`
        SELECT acceptance_request ->> 'actor_id' AS actor_id
          FROM agentos.task_assignments
         WHERE id = '${assignmentId}'
      `);
      assert.strictEqual(
        (yield* firstRow(actors, "missing acceptance actor")).actor_id,
        yield* fleetRootId(),
      );
    }));

  it.effect("lets a Second Mate record backlog but denies raw acceptance", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin("acceptance_second_a", Effect.gen(function*() {
        yield* database.exec(`
          INSERT INTO agentos.tasks (
            id, project_id, created_by_agent_id, title, status, status_text
          ) VALUES (
            '41000000-0000-4000-8000-000000000030',
            '${ids.project}', '${ids.secondA}', 'Deliberate raw backlog',
            'queued', 'Not accepted until the released Function runs'
          )
        `);
        const error = yield* Effect.flip(database.exec(`
          INSERT INTO agentos.task_assignments (
            id, task_id, agent_id, assigned_by_agent_id, assignment_role,
            status, status_text, brief
          ) VALUES (
            '51000000-0000-4000-8000-000000000030',
            '41000000-0000-4000-8000-000000000030',
            '${ids.crewA}', '${ids.secondA}', 'ship', 'assigned',
            'Attempted non-atomic acceptance', '# Raw acceptance brief'
          )
        `));
        assert.strictEqual(error.operation, "exec");
      }));
      const ownership = yield* database.query<{ readonly count: number }>(`
        SELECT count(*)::int AS count FROM agentos.task_assignments
         WHERE task_id = '41000000-0000-4000-8000-000000000030'
      `);
      assert.strictEqual(
        (yield* firstRow(ownership, "missing ownership count")).count,
        0,
      );
    }));

  it.effect("rolls back invalid input and rejects unauthorized calls", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin("acceptance_second_a", Effect.gen(function*() {
        const invalid = yield* Effect.flip(createAcceptedTask({
          assignmentId: ids.invalidAssignment,
          brief: "",
          taskId: ids.invalidTask,
        }));
        assert.include(invalid.detail, "complete Task, Assignment and brief text");
        const hierarchy = yield* Effect.flip(createAcceptedTask({
          assignmentId: "51000000-0000-4000-8000-000000000020",
          agentId: ids.crewB,
          taskId: "41000000-0000-4000-8000-000000000020",
        }));
        assert.include(hierarchy.detail, "managed hierarchy");
      }));
      const invalidRows = yield* database.query<{ readonly count: number }>(`
        SELECT count(*)::int AS count FROM agentos.tasks
         WHERE id IN ('${ids.invalidTask}', '41000000-0000-4000-8000-000000000020')
      `);
      assert.strictEqual(
        (yield* firstRow(invalidRows, "missing rollback count")).count,
        0,
      );

      const crewErrors = yield* asLogin("acceptance_crew_a", Effect.forEach([
        createAcceptedTask({
          assignmentId: "51000000-0000-4000-8000-000000000021",
          taskId: "41000000-0000-4000-8000-000000000021",
        }),
        acceptBacklogTask(ids.backlogTask, ids.backlogAssignment),
      ], Effect.flip));
      assert.strictEqual(crewErrors.length, 2);
      const unregistered = yield* Effect.flip(asLogin(
        "acceptance_unregistered",
        createAcceptedTask({
          assignmentId: "51000000-0000-4000-8000-000000000022",
          taskId: "41000000-0000-4000-8000-000000000022",
        }),
      ));
      assert.strictEqual(unregistered.operation, "query");
    }));

  it.effect("accepts recorded backlog once and retries after state advances", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, description,
          status, status_text, priority
        ) VALUES (
          '${ids.backlogTask}', '${ids.project}', '${ids.secondA}',
          'Recorded backlog outcome', 'Accept this only when capacity is ready',
          'queued', 'Waiting in deliberate backlog', 'normal'
        )
      `);
      yield* asLogin("acceptance_second_a", Effect.gen(function*() {
        const accepted = yield* acceptBacklogTask(
          ids.backlogTask,
          ids.backlogAssignment,
        );
        assert.deepStrictEqual(accepted, [{
          accepted_assignment_id: ids.backlogAssignment,
          accepted_task_id: ids.backlogTask,
        }]);
        yield* database.exec(`
          UPDATE agentos.tasks
             SET status = 'in_progress', status_text = 'Accepted backlog work started'
           WHERE id = '${ids.backlogTask}'
        `);
        assert.deepStrictEqual(
          yield* acceptBacklogTask(ids.backlogTask, ids.backlogAssignment),
          accepted,
        );
      }));
    }));

  it.effect("rejects backlog history and enforces one active owner", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, status, status_text
        ) VALUES (
          '${ids.historicalTask}', '${ids.project}', '${ids.secondA}',
          'Historical work', 'active', 'Previously accepted'
        );
        INSERT INTO agentos.task_assignments (
          id, task_id, agent_id, assigned_by_agent_id, assignment_role,
          status, status_text, brief
        ) VALUES (
          '${ids.historicalAssignment}', '${ids.historicalTask}', '${ids.crewA}',
          '${ids.secondA}', 'ship', 'assigned', 'Original owner',
          '# Historical brief'
        );
        UPDATE agentos.task_assignments
           SET status = 'completed', status_text = 'Historical assignment completed',
               report = 'The historical assignment ended.',
               ended_at = transaction_timestamp()
         WHERE id = '${ids.historicalAssignment}';
      `);
      const history = yield* Effect.flip(asLogin(
        "acceptance_second_a",
        acceptBacklogTask(
          ids.historicalTask,
          "51000000-0000-4000-8000-000000000023",
        ),
      ));
      assert.include(history.detail, "has Assignment history");

      const duplicate = yield* Effect.flip(database.exec(`
        INSERT INTO agentos.task_assignments (
          id, task_id, agent_id, assigned_by_agent_id, assignment_role,
          status, status_text, brief
        ) VALUES (
          '51000000-0000-4000-8000-000000000024',
          '${ids.firstTask}', '${ids.replacementCrew}', '${ids.secondA}',
          'ship', 'assigned', 'Invalid concurrent owner', '# Concurrent brief'
        )
      `));
      assert.include(
        duplicate.detail,
        'duplicate key value violates unique constraint "task_assignments_one_active_owner_idx"',
      );

      yield* asLogin("acceptance_second_a", Effect.gen(function*() {
        const handoffs = yield* database.query<{ readonly id: string }>(`
          SELECT agentos.handoff_task_assignment(
            '${ids.firstAssignment}', '${ids.replacementCrew}',
            '# Replacement brief', 'The first owner preserved its findings.',
            'Transferred to the replacement owner'
          )::text AS id
        `);
        const handoffId = (yield* firstRow(handoffs, "handoff returned no row")).id;
        const active = yield* database.query<{
          readonly agent_id: string;
          readonly count: number;
          readonly id: string;
        }>(`
          SELECT count(*)::int AS count,
                 min(id::text) AS id,
                 min(agent_id::text) AS agent_id
            FROM agentos.task_assignments
           WHERE task_id = '${ids.firstTask}' AND ended_at IS NULL
        `);
        assert.deepStrictEqual(active, [{
          agent_id: ids.replacementCrew,
          count: 1,
          id: handoffId,
        }]);
      }));
    }));
});
