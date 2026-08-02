import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
  withDatabaseLogin,
} from "./pglite-test.ts";

const ids = {
  assignment: "2a000000-0000-4000-8000-000000000001",
  assignmentResume: "2a000000-0000-4000-8000-000000000002",
  crew: "2b000000-0000-4000-8000-000000000003",
  crewReplacement: "2b000000-0000-4000-8000-000000000004",
  epoch: "7a000000-0000-4000-8000-000000000001",
  epochCompleted: "7a000000-0000-4000-8000-000000000002",
  epochResumeSource: "7a000000-0000-4000-8000-000000000004",
  epochResumeSuccessor: "7a000000-0000-4000-8000-000000000005",
  epochResumeConflict: "7a000000-0000-4000-8000-00000000000a",
  epochAuthority: "7a000000-0000-4000-8000-000000000006",
  epochAuthoritySuccessor: "7a000000-0000-4000-8000-000000000007",
  epochCapacity: "7a000000-0000-4000-8000-000000000008",
  epochCapacitySuccessor: "7a000000-0000-4000-8000-000000000009",
  epochPolicy: "7a000000-0000-4000-8000-00000000000b",
  epochPolicySuccessor: "7a000000-0000-4000-8000-00000000000c",
  epochStopConflict: "7a000000-0000-4000-8000-00000000000d",
  epochReassignConflict: "7a000000-0000-4000-8000-00000000000e",
  operation: "7b000000-0000-4000-8000-000000000001",
  operationResume: "7b000000-0000-4000-8000-000000000002",
  operationCapacity: "7b000000-0000-4000-8000-000000000003",
  project: "3a000000-0000-4000-8000-000000000001",
  secondMate: "2b000000-0000-4000-8000-000000000002",
  secondMatePeer: "2b000000-0000-4000-8000-000000000005",
  task: "4a000000-0000-4000-8000-000000000001",
  taskResume: "4a000000-0000-4000-8000-000000000002",
};
const renderDigest = "a".repeat(64);

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
      CREATE ROLE retry_recovery_second LOGIN;
      CREATE ROLE retry_recovery_peer LOGIN;
      CREATE ROLE retry_recovery_crew LOGIN;
      CREATE ROLE retry_recovery_replacement LOGIN;

      INSERT INTO agentos.projects (
        id, name, scope_text, status, status_text
      ) VALUES (
        '${ids.project}', 'retry-recovery', 'Durable retry recovery',
        'active', 'Recovery fixture ready'
      );
      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status,
        status_text, kubernetes_namespace, kubernetes_pod,
        persistent_volume_claim, herdr_locator
      ) VALUES
        (
          '${ids.secondMate}', 'retry-second', 'second_mate',
          '${firstMateId}', 'pi', 'active', 'Owns recovery',
          'agentos-domain-retry', 'retry-second-0',
          'home-retry-second-0', 'herdr://retry-second'
        ),
        (
          '${ids.secondMatePeer}', 'retry-peer', 'second_mate',
          '${firstMateId}', 'pi', 'active', 'Owns another domain',
          'agentos-domain-peer', 'retry-peer-0',
          'home-retry-peer-0', 'herdr://retry-peer'
        ),
        (
          '${ids.crew}', 'retry-crew', 'crewmate', '${ids.secondMate}',
          'codex', 'active', 'Owns exhausted work',
          'agentos-domain-retry', 'retry-crew-0',
          'home-retry-crew-0', 'herdr://retry-crew'
        ),
        (
          '${ids.crewReplacement}', 'retry-replacement', 'crewmate',
          '${ids.secondMate}', 'codex', 'active', 'Can receive handoff',
          'agentos-domain-retry', 'retry-replacement-0',
          'home-retry-replacement-0', 'herdr://retry-replacement'
        );
      SELECT agentos.register_agent_principal(
        '${ids.secondMate}', 'retry_recovery_second'
      );
      SELECT agentos.register_agent_principal(
        '${ids.secondMatePeer}', 'retry_recovery_peer'
      );
      SELECT agentos.register_agent_principal(
        '${ids.crew}', 'retry_recovery_crew'
      );
      SELECT agentos.register_agent_principal(
        '${ids.crewReplacement}', 'retry_recovery_replacement'
      );
      INSERT INTO agentos.tasks (
        id, project_id, created_by_agent_id, title, status, status_text
      ) VALUES
        (
          '${ids.task}', '${ids.project}', '${ids.secondMate}',
          'Recover exact native work', 'active', 'Work is active'
        ),
        (
          '${ids.taskResume}', '${ids.project}', '${ids.secondMate}',
          'Resume exact native work', 'active', 'Resume fixture is active'
        );
      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, brief
      ) VALUES
        (
          '${ids.assignment}', '${ids.task}', '${ids.crew}',
          '${ids.secondMate}', 'worker', 'active', 'Execution active',
          '# Recover exact native work'
        ),
        (
          '${ids.assignmentResume}', '${ids.taskResume}',
          '${ids.crewReplacement}', '${ids.secondMate}', 'worker', 'active',
          'Resume execution active', '# Resume exact native work'
        );
    `);
    yield* withDatabaseLogin(
      database,
      "retry_recovery_second",
      Effect.gen(function*() {
        yield* database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operation}', '${ids.crew}', '${ids.assignment}',
            'agentos-domain-retry', 'retry-crew', 'recover',
            '${renderDigest}',
            '[{"kind":"persistent_volume_claim","name":"home-retry-crew-0","disposition":"retain"}]'::jsonb
          )
        `);
        yield* database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationResume}', '${ids.crewReplacement}',
            '${ids.assignmentResume}', 'agentos-domain-retry',
            'retry-replacement', 'recover', '${renderDigest}',
            '[{"kind":"persistent_volume_claim","name":"home-retry-replacement-0","disposition":"retain"}]'::jsonb
          )
        `);
      }),
    );
  }),
});

layer(databaseLayer)("assignment execution recovery", (it) => {
  it.effect("begins and exactly retries one active native-session epoch", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const begin = () => asLogin(
        "retry_recovery_crew",
        database.query<{ readonly id: string }>(`
          SELECT agentos.begin_assignment_execution_epoch(
            '${ids.epoch}', '${ids.assignment}', '${ids.operation}',
            'codex:thread-retry-1'
          )::text AS id
        `),
      );
      assert.deepStrictEqual(yield* begin(), [{ id: ids.epoch }]);
      assert.deepStrictEqual(yield* begin(), [{ id: ids.epoch }]);

      const row = yield* database.query<{
        readonly agent_id: string;
        readonly assignment_id: string;
        readonly epoch: number;
        readonly native_session_ref: string;
        readonly state: string;
      }>(`
        SELECT assignment_id::text, agent_id::text, epoch,
               native_session_ref, state
          FROM agentos.assignment_execution_epochs
         WHERE id = '${ids.epoch}'
      `);
      assert.deepStrictEqual(row, [{
        agent_id: ids.crew,
        assignment_id: ids.assignment,
        epoch: 1,
        native_session_ref: "codex:thread-retry-1",
        state: "active",
      }]);
    }));

  it.effect("derives a closed retry ceiling for every distinct failure class", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const ceilings = yield* database.query<{
        readonly failure_class: string;
        readonly retry_ceiling: number;
      }>(`
        SELECT failure_class,
               agentos.assignment_retry_ceiling(failure_class) AS retry_ceiling
          FROM unnest(ARRAY[
            'overload', 'authentication', 'transport', 'protocol', 'stream',
            'capacity', 'policy', 'provider', 'harness', 'runtime'
          ]) AS failure_class
         ORDER BY failure_class
      `);
      assert.deepStrictEqual(ceilings, [
        { failure_class: "authentication", retry_ceiling: 1 },
        { failure_class: "capacity", retry_ceiling: 1 },
        { failure_class: "harness", retry_ceiling: 2 },
        { failure_class: "overload", retry_ceiling: 5 },
        { failure_class: "policy", retry_ceiling: 1 },
        { failure_class: "protocol", retry_ceiling: 2 },
        { failure_class: "provider", retry_ceiling: 2 },
        { failure_class: "runtime", retry_ceiling: 2 },
        { failure_class: "stream", retry_ceiling: 3 },
        { failure_class: "transport", retry_ceiling: 5 },
      ]);
    }));

  it.effect("exhausts only at the exact class ceiling and completes a successor epoch", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin("retry_recovery_crew", database.query(`
        SELECT agentos.begin_assignment_execution_epoch(
          '${ids.epoch}', '${ids.assignment}', '${ids.operation}',
          'codex:thread-retry-1'
        )
      `));

      for (const attempts of [4, 6]) {
        const failure = yield* Effect.flip(asLogin(
          "retry_recovery_crew",
          database.query(`
            SELECT agentos.exhaust_assignment_execution_epoch(
              '${ids.epoch}', 'overload', ${attempts}
            )
          `),
        ));
        assert.include(failure.detail, "exact retry ceiling 5");
      }

      const exhaust = () => asLogin(
        "retry_recovery_crew",
        database.query<{ readonly state: string }>(`
          SELECT agentos.exhaust_assignment_execution_epoch(
            '${ids.epoch}', 'overload', 5
          ) AS state
        `),
      );
      assert.deepStrictEqual(yield* exhaust(), [{ state: "exhausted" }]);
      assert.deepStrictEqual(yield* exhaust(), [{ state: "exhausted" }]);
      const conflict = yield* Effect.flip(asLogin(
        "retry_recovery_crew",
        database.query(`
          SELECT agentos.exhaust_assignment_execution_epoch(
            '${ids.epoch}', 'transport', 5
          )
        `),
      ));
      assert.include(conflict.detail, "conflicts with exhausted execution epoch");

      const bypass = yield* Effect.flip(asLogin(
        "retry_recovery_crew",
        database.query(`
          SELECT agentos.begin_assignment_execution_epoch(
            '${ids.epochCompleted}', '${ids.assignment}', '${ids.operation}',
            'codex:thread-retry-1'
          )
        `),
      ));
      assert.include(bypass.detail, "requires supervising recovery");
      yield* asLogin("retry_recovery_second", database.query(`
        SELECT agentos.resume_assignment_execution_epoch(
          '${ids.epoch}', '${ids.epochCompleted}', NULL,
          'boundary:overload-cleared'
        )
      `));
      const complete = () => asLogin(
        "retry_recovery_crew",
        database.query<{ readonly state: string }>(`
          SELECT agentos.complete_assignment_execution_epoch(
            '${ids.epochCompleted}'
          ) AS state
        `),
      );
      assert.deepStrictEqual(yield* complete(), [{ state: "completed" }]);
      assert.deepStrictEqual(yield* complete(), [{ state: "completed" }]);

      const rows = yield* database.query<{
        readonly attempts_observed: number | null;
        readonly epoch: number;
        readonly failure_class: string | null;
        readonly retry_ceiling: number | null;
        readonly state: string;
      }>(`
        SELECT epoch, state, failure_class, retry_ceiling, attempts_observed
          FROM agentos.assignment_execution_epochs
         WHERE assignment_id = '${ids.assignment}'
         ORDER BY epoch
      `);
      assert.deepStrictEqual(rows, [
        {
          attempts_observed: 5,
          epoch: 1,
          failure_class: "overload",
          retry_ceiling: 5,
          state: "resumed",
        },
        {
          attempts_observed: null,
          epoch: 2,
          failure_class: null,
          retry_ceiling: null,
          state: "completed",
        },
      ]);

      const directRewrite = yield* Effect.flip(database.exec(`
        UPDATE agentos.assignment_execution_epochs
           SET state = 'active', failure_class = NULL, retry_ceiling = NULL,
               attempts_observed = NULL, exhausted_at = NULL
         WHERE id = '${ids.epoch}'
      `));
      assert.include(
        directRewrite.detail,
        "changes require a released transition Function",
      );
    }));

  it.effect("resumes exactly once under parent authority without replacing durable identity", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const countsBefore = yield* database.query<{
        readonly agents: number;
        readonly assignments: number;
        readonly tasks: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM agentos.agents) AS agents,
          (SELECT count(*)::int FROM agentos.task_assignments) AS assignments,
          (SELECT count(*)::int FROM agentos.tasks) AS tasks
      `);
      yield* asLogin("retry_recovery_replacement", Effect.gen(function*() {
        yield* database.query(`
          SELECT agentos.begin_assignment_execution_epoch(
            '${ids.epochResumeSource}', '${ids.assignmentResume}',
            '${ids.operationResume}',
            'codex:thread-retry-1'
          )
        `);
        yield* database.query(`
          SELECT agentos.exhaust_assignment_execution_epoch(
            '${ids.epochResumeSource}', 'overload', 5
          )
        `);
      }));

      const crewDenied = yield* Effect.flip(asLogin(
        "retry_recovery_replacement",
        database.query(`
          SELECT agentos.resume_assignment_execution_epoch(
            '${ids.epochResumeSource}', '${ids.epochResumeSuccessor}', NULL,
            'boundary:provider-ready-1'
          )
        `),
      ));
      assert.include(crewDenied.detail, "permission denied");

      const siblingDenied = yield* Effect.flip(asLogin(
        "retry_recovery_crew",
        database.query(`
          SELECT agentos.resume_assignment_execution_epoch(
            '${ids.epochResumeSource}', '${ids.epochResumeSuccessor}', NULL,
            'boundary:provider-ready-1'
          )
        `),
      ));
      assert.include(siblingDenied.detail, "permission denied");

      const peerDenied = yield* Effect.flip(asLogin(
        "retry_recovery_peer",
        database.query(`
          SELECT agentos.resume_assignment_execution_epoch(
            '${ids.epochResumeSource}', '${ids.epochResumeSuccessor}', NULL,
            'boundary:provider-ready-1'
          )
        `),
      ));
      assert.include(peerDenied.detail, "supervising Mate");

      const wrongBoundaryKind = yield* Effect.flip(asLogin(
        "retry_recovery_second",
        database.query(`
          SELECT agentos.resume_assignment_execution_epoch(
            '${ids.epochResumeSource}', '${ids.epochResumeSuccessor}', NULL,
            'authority:provider-ready-1'
          )
        `),
      ));
      assert.include(wrongBoundaryKind.detail, "changed-boundary recovery evidence");

      const resume = () => asLogin(
        "retry_recovery_second",
        database.query<{ readonly id: string }>(`
          SELECT agentos.resume_assignment_execution_epoch(
            '${ids.epochResumeSource}', '${ids.epochResumeSuccessor}', NULL,
            'boundary:provider-ready-1'
          )::text AS id
        `),
      );
      assert.deepStrictEqual(yield* resume(), [{ id: ids.epochResumeSuccessor }]);
      assert.deepStrictEqual(yield* resume(), [{ id: ids.epochResumeSuccessor }]);

      const successorConflict = yield* Effect.flip(asLogin(
        "retry_recovery_second",
        database.query(`
          SELECT agentos.resume_assignment_execution_epoch(
            '${ids.epochResumeSource}', '${ids.epochResumeConflict}', NULL,
            'boundary:provider-ready-1'
          )
        `),
      ));
      assert.include(successorConflict.detail, "conflicts with the existing execution resume");
      const evidenceConflict = yield* Effect.flip(asLogin(
        "retry_recovery_second",
        database.query(`
          SELECT agentos.resume_assignment_execution_epoch(
            '${ids.epochResumeSource}', '${ids.epochResumeSuccessor}', NULL,
            'boundary:provider-ready-2'
          )
        `),
      ));
      assert.include(evidenceConflict.detail, "conflicts with the existing execution resume");

      const rows = yield* database.query<{
        readonly agent_id: string;
        readonly assignment_id: string;
        readonly epoch: number;
        readonly native_session_ref: string;
        readonly predecessor_epoch_id: string | null;
        readonly runtime_operation_id: string | null;
        readonly state: string;
      }>(`
        SELECT assignment_id::text, agent_id::text, epoch,
               runtime_operation_id::text, native_session_ref, state,
               predecessor_epoch_id::text
          FROM agentos.assignment_execution_epochs
         WHERE assignment_id = '${ids.assignmentResume}'
         ORDER BY epoch
      `);
      assert.deepStrictEqual(rows, [
        {
          agent_id: ids.crewReplacement,
          assignment_id: ids.assignmentResume,
          epoch: 1,
          native_session_ref: "codex:thread-retry-1",
          predecessor_epoch_id: null,
          runtime_operation_id: ids.operationResume,
          state: "resumed",
        },
        {
          agent_id: ids.crewReplacement,
          assignment_id: ids.assignmentResume,
          epoch: 2,
          native_session_ref: "codex:thread-retry-1",
          predecessor_epoch_id: ids.epochResumeSource,
          runtime_operation_id: ids.operationResume,
          state: "active",
        },
      ]);
      assert.deepStrictEqual(
        yield* database.query(`
          SELECT
            (SELECT count(*)::int FROM agentos.agents) AS agents,
            (SELECT count(*)::int FROM agentos.task_assignments) AS assignments,
            (SELECT count(*)::int FROM agentos.tasks) AS tasks
        `),
        countsBefore,
      );
      assert.deepStrictEqual(
        yield* database.query(`
          SELECT persistent_volume_claim, herdr_locator
            FROM agentos.agents WHERE id = '${ids.crewReplacement}'
        `),
        [{
          herdr_locator: "herdr://retry-replacement",
          persistent_volume_claim: "home-retry-replacement-0",
        }],
      );
    }));

  it.effect("requires explicit authority evidence after authentication exhaustion", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin("retry_recovery_replacement", Effect.gen(function*() {
        yield* database.query(`
          SELECT agentos.complete_assignment_execution_epoch(
            '${ids.epochResumeSuccessor}'
          )
        `);
        yield* database.query(`
          SELECT agentos.begin_assignment_execution_epoch(
            '${ids.epochAuthority}', '${ids.assignmentResume}',
            '${ids.operationResume}', 'codex:thread-retry-1'
          )
        `);
        yield* database.query(`
          SELECT agentos.exhaust_assignment_execution_epoch(
            '${ids.epochAuthority}', 'authentication', 1
          )
        `);
      }));

      const missingAuthority = yield* Effect.flip(asLogin(
        "retry_recovery_second",
        database.query(`
          SELECT agentos.resume_assignment_execution_epoch(
            '${ids.epochAuthority}', '${ids.epochAuthoritySuccessor}', NULL,
            'boundary:credential-unchanged'
          )
        `),
      ));
      assert.include(missingAuthority.detail, "authority-granted");

      assert.deepStrictEqual(
        yield* asLogin(
          "retry_recovery_second",
          database.query<{ readonly id: string }>(`
            SELECT agentos.resume_assignment_execution_epoch(
              '${ids.epochAuthority}', '${ids.epochAuthoritySuccessor}', NULL,
              'authority:approval-credential-rotated'
            )::text AS id
          `),
        ),
        [{ id: ids.epochAuthoritySuccessor }],
      );

      yield* asLogin("retry_recovery_replacement", Effect.gen(function*() {
        yield* database.query(`
          SELECT agentos.complete_assignment_execution_epoch(
            '${ids.epochAuthoritySuccessor}'
          )
        `);
        yield* database.query(`
          SELECT agentos.begin_assignment_execution_epoch(
            '${ids.epochPolicy}', '${ids.assignmentResume}',
            '${ids.operationResume}', 'codex:thread-retry-1'
          )
        `);
        yield* database.query(`
          SELECT agentos.exhaust_assignment_execution_epoch(
            '${ids.epochPolicy}', 'policy', 1
          )
        `);
      }));
      const policyWithoutAuthority = yield* Effect.flip(asLogin(
        "retry_recovery_second",
        database.query(`
          SELECT agentos.resume_assignment_execution_epoch(
            '${ids.epochPolicy}', '${ids.epochPolicySuccessor}', NULL,
            'boundary:policy-unchanged'
          )
        `),
      ));
      assert.include(policyWithoutAuthority.detail, "authority-granted");
      assert.deepStrictEqual(
        yield* asLogin(
          "retry_recovery_second",
          database.query<{ readonly id: string }>(`
            SELECT agentos.resume_assignment_execution_epoch(
              '${ids.epochPolicy}', '${ids.epochPolicySuccessor}', NULL,
              'authority:approval-policy-updated'
            )::text AS id
          `),
        ),
        [{ id: ids.epochPolicySuccessor }],
      );
    }));

  it.effect("requires a distinct verified runtime boundary after capacity exhaustion", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin("retry_recovery_crew", Effect.gen(function*() {
        yield* database.query(`
          SELECT agentos.begin_assignment_execution_epoch(
            '${ids.epochCapacity}', '${ids.assignment}', '${ids.operation}',
            'codex:thread-retry-1'
          )
        `);
        yield* database.query(`
          SELECT agentos.exhaust_assignment_execution_epoch(
            '${ids.epochCapacity}', 'capacity', 1
          )
        `);
      }));

      const unchangedRuntime = yield* Effect.flip(asLogin(
        "retry_recovery_second",
        database.query(`
          SELECT agentos.resume_assignment_execution_epoch(
            '${ids.epochCapacity}', '${ids.epochCapacitySuccessor}',
            '${ids.operation}', 'boundary:capacity-unchanged'
          )
        `),
      ));
      assert.include(
        unchangedRuntime.detail,
        "distinct verified runtime operation",
      );

      yield* asLogin("retry_recovery_second", Effect.gen(function*() {
        yield* Effect.forEach(
          ["applied", "workload_ready", "harness_ready"],
          (phase) => database.query(`
            SELECT agentos.observe_runtime_operation(
              '${ids.operation}', '${phase}', NULL
            )
          `),
          { discard: true },
        );
        yield* database.query(`
          SELECT agentos.complete_runtime_operation('${ids.operation}')
        `);
        yield* database.query(`
          SELECT agentos.begin_runtime_operation(
            '${ids.operationCapacity}', '${ids.crew}', '${ids.assignment}',
            'agentos-domain-retry', 'retry-crew', 'recover',
            '${"b".repeat(64)}',
            '[{"kind":"persistent_volume_claim","name":"home-retry-crew-0","disposition":"retain"}]'::jsonb
          )
        `);
        yield* Effect.forEach(
          ["applied", "workload_ready", "harness_ready"],
          (phase) => database.query(`
            SELECT agentos.observe_runtime_operation(
              '${ids.operationCapacity}', '${phase}', NULL
            )
          `),
          { discard: true },
        );
      }));

      assert.deepStrictEqual(
        yield* asLogin(
          "retry_recovery_second",
          database.query<{ readonly id: string }>(`
            SELECT agentos.resume_assignment_execution_epoch(
              '${ids.epochCapacity}', '${ids.epochCapacitySuccessor}',
              '${ids.operationCapacity}', 'boundary:capacity-reallocated'
            )::text AS id
          `),
        ),
        [{ id: ids.epochCapacitySuccessor }],
      );
      assert.deepStrictEqual(
        yield* database.query(`
          SELECT agent_id::text, assignment_id::text,
                 runtime_operation_id::text, native_session_ref, state,
                 predecessor_epoch_id::text
            FROM agentos.assignment_execution_epochs
           WHERE id = '${ids.epochCapacitySuccessor}'
        `),
        [{
          agent_id: ids.crew,
          assignment_id: ids.assignment,
          native_session_ref: "codex:thread-retry-1",
          predecessor_epoch_id: ids.epochCapacity,
          runtime_operation_id: ids.operationCapacity,
          state: "active",
        }],
      );
    }));

  it.effect("stops exhausted work once while keeping its report on the Assignment", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin("retry_recovery_replacement", database.query(`
        SELECT agentos.exhaust_assignment_execution_epoch(
          '${ids.epochPolicySuccessor}', 'runtime', 2
        )
      `));
      const stop = () => asLogin(
        "retry_recovery_second",
        database.query<{ readonly id: string }>(`
          SELECT agentos.stop_assignment_execution_epoch(
            '${ids.epochPolicySuccessor}',
            'The worker preserved its final recovery findings.',
            'Stopped after bounded recovery was exhausted'
          )::text AS id
        `),
      );
      for (const login of ["retry_recovery_replacement", "retry_recovery_crew"]) {
        const denied = yield* Effect.flip(asLogin(login, database.query(`
          SELECT agentos.stop_assignment_execution_epoch(
            '${ids.epochPolicySuccessor}', 'Forbidden report',
            'Forbidden stop'
          )
        `)));
        assert.include(denied.detail, "permission denied");
      }
      const peerDenied = yield* Effect.flip(asLogin(
        "retry_recovery_peer",
        database.query(`
          SELECT agentos.stop_assignment_execution_epoch(
            '${ids.epochPolicySuccessor}', 'Forbidden report',
            'Forbidden stop'
          )
        `),
      ));
      assert.include(peerDenied.detail, "supervising Mate");

      assert.deepStrictEqual(yield* stop(), [{ id: ids.epochPolicySuccessor }]);
      assert.deepStrictEqual(yield* stop(), [{ id: ids.epochPolicySuccessor }]);
      const conflict = yield* Effect.flip(asLogin(
        "retry_recovery_second",
        database.query(`
          SELECT agentos.stop_assignment_execution_epoch(
            '${ids.epochPolicySuccessor}',
            'The worker preserved its final recovery findings.',
            'A conflicting stop status'
          )
        `),
      ));
      assert.include(conflict.detail, "conflicts with the existing execution stop");
      assert.deepStrictEqual(
        yield* database.query(`
          SELECT status, status_text, report, ended_at IS NOT NULL AS ended
            FROM agentos.task_assignments
           WHERE id = '${ids.assignmentResume}'
        `),
        [{
          ended: true,
          report: "The worker preserved its final recovery findings.",
          status: "stopped",
          status_text: "Stopped after bounded recovery was exhausted",
        }],
      );
      assert.deepStrictEqual(
        yield* database.query(`
          SELECT state, recovery_action, recovery_reference,
                 replacement_assignment_id::text,
                 finished_at IS NOT NULL AS finished
            FROM agentos.assignment_execution_epochs
           WHERE id = '${ids.epochPolicySuccessor}'
        `),
        [{
          finished: true,
          recovery_action: "stop",
          recovery_reference: null,
          replacement_assignment_id: null,
          state: "stopped",
        }],
      );
      const terminal = yield* Effect.flip(asLogin(
        "retry_recovery_second",
        database.query(`
          SELECT agentos.resume_assignment_execution_epoch(
            '${ids.epochPolicySuccessor}', '${ids.epochStopConflict}', NULL,
            'boundary:stop-is-terminal'
          )
        `),
      ));
      assert.include(terminal.detail, "stopped execution epoch cannot resume");
    }));

  it.effect("atomically reassigns exhausted work through append-only Assignment history", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const countsBefore = yield* database.query<{
        readonly agents: number;
        readonly assignments: number;
        readonly tasks: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM agentos.agents) AS agents,
          (SELECT count(*)::int FROM agentos.task_assignments) AS assignments,
          (SELECT count(*)::int FROM agentos.tasks) AS tasks
      `);
      const before = yield* firstRow(countsBefore, "reassignment counts missing");
      yield* asLogin("retry_recovery_crew", database.query(`
        SELECT agentos.exhaust_assignment_execution_epoch(
          '${ids.epochCapacitySuccessor}', 'transport', 5
        )
      `));
      const reassign = (brief = "# Continue recovery on the preserved Task") => asLogin(
        "retry_recovery_second",
        database.query<{ readonly id: string }>(`
          SELECT agentos.reassign_assignment_execution_epoch(
            '${ids.epochCapacitySuccessor}', '${ids.crewReplacement}',
            '${brief}',
            'The original worker preserved its bounded recovery findings.',
            'Transferred after retry exhaustion'
          )::text AS id
        `),
      );
      for (const login of ["retry_recovery_crew", "retry_recovery_replacement"]) {
        const denied = yield* Effect.flip(asLogin(login, database.query(`
          SELECT agentos.reassign_assignment_execution_epoch(
            '${ids.epochCapacitySuccessor}', '${ids.crewReplacement}',
            '# Forbidden reassignment', 'Forbidden report',
            'Forbidden reassignment'
          )
        `)));
        assert.include(denied.detail, "permission denied");
      }
      const peerDenied = yield* Effect.flip(asLogin(
        "retry_recovery_peer",
        database.query(`
          SELECT agentos.reassign_assignment_execution_epoch(
            '${ids.epochCapacitySuccessor}', '${ids.crewReplacement}',
            '# Forbidden reassignment', 'Forbidden report',
            'Forbidden reassignment'
          )
        `),
      ));
      assert.include(peerDenied.detail, "supervising Mate");

      const replacements = yield* reassign();
      const replacement = yield* firstRow(
        replacements,
        "execution reassignment returned no replacement Assignment",
      );
      assert.match(replacement.id, /^[0-9a-f-]{36}$/);
      assert.deepStrictEqual(yield* reassign(), [{ id: replacement.id }]);
      const conflict = yield* Effect.flip(reassign("# Conflicting replacement brief"));
      assert.include(
        conflict.detail,
        "conflicts with the existing execution reassignment",
      );
      const countsAfter = yield* database.query<{
        readonly agents: number;
        readonly assignments: number;
        readonly tasks: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM agentos.agents) AS agents,
          (SELECT count(*)::int FROM agentos.task_assignments) AS assignments,
          (SELECT count(*)::int FROM agentos.tasks) AS tasks
      `);
      const after = yield* firstRow(countsAfter, "post-reassignment counts missing");
      assert.deepStrictEqual(countsAfter, [{
        agents: before.agents,
        assignments: before.assignments + 1,
        tasks: before.tasks,
      }]);
      assert.deepStrictEqual(
        yield* database.query(`
          SELECT id::text, agent_id::text, status, report,
                 ended_at IS NOT NULL AS ended,
                 supersedes_assignment_id::text
            FROM agentos.task_assignments
           WHERE task_id = '${ids.task}'
           ORDER BY ended_at NULLS LAST, created_at, id
        `),
        [
          {
            agent_id: ids.crew,
            ended: true,
            id: ids.assignment,
            report: "The original worker preserved its bounded recovery findings.",
            status: "handed_off",
            supersedes_assignment_id: null,
          },
          {
            agent_id: ids.crewReplacement,
            ended: false,
            id: replacement.id,
            report: null,
            status: "assigned",
            supersedes_assignment_id: ids.assignment,
          },
        ],
      );
      assert.deepStrictEqual(
        yield* database.query(`
          SELECT state, recovery_action, replacement_assignment_id::text,
                 finished_at IS NOT NULL AS finished
            FROM agentos.assignment_execution_epochs
           WHERE id = '${ids.epochCapacitySuccessor}'
        `),
        [{
          finished: true,
          recovery_action: "reassign",
          replacement_assignment_id: replacement.id,
          state: "reassigned",
        }],
      );
      const terminal = yield* Effect.flip(asLogin(
        "retry_recovery_second",
        database.query(`
          SELECT agentos.resume_assignment_execution_epoch(
            '${ids.epochCapacitySuccessor}', '${ids.epochReassignConflict}',
            NULL, 'boundary:reassignment-is-terminal'
          )
        `),
      ));
      assert.include(terminal.detail, "reassigned execution epoch cannot resume");
      assert.deepStrictEqual(
        yield* asLogin(
          "retry_recovery_crew",
          database.query<{ readonly count: number }>(`
            SELECT count(*)::int AS count FROM agentos.agents
          `),
        ),
        [{ count: after.agents }],
      );
    }));
});
