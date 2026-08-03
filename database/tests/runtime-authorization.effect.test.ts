import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const ids = {
  crewA: "20000000-0000-4000-8000-000000000003",
  crewB: "20000000-0000-4000-8000-000000000005",
  firstMate: "20000000-0000-4000-8000-000000000001",
  externalTask: "40000000-0000-4000-8000-000000000004",
  project: "30000000-0000-4000-8000-000000000001",
  secondA: "20000000-0000-4000-8000-000000000002",
  secondB: "20000000-0000-4000-8000-000000000004",
  retirementTask: "40000000-0000-4000-8000-000000000003",
  taskA: "40000000-0000-4000-8000-000000000001",
  taskB: "40000000-0000-4000-8000-000000000002",
};

const databaseLayer = makePGliteTestLayer({
  migrations: [
    new URL("../migrations/0000_initial_fleet_schema.sql", import.meta.url),
    new URL("../migrations/0001_agent_authorization.sql", import.meta.url),
  ],
  setup: (database) => Effect.gen(function*() {
    yield* database.exec(`
      CREATE ROLE runtime_second_a LOGIN;
      CREATE ROLE runtime_crew_a LOGIN;
      CREATE ROLE runtime_second_b LOGIN;
      CREATE ROLE runtime_crew_b LOGIN;

      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES
        ('${ids.firstMate}', 'runtime-first', 'first_mate', NULL, 'pi', 'active', 'First Mate ready'),
        ('${ids.secondA}', 'runtime-second-a', 'second_mate', '${ids.firstMate}', 'pi', 'active', 'Second Mate A ready'),
        ('${ids.crewA}', 'runtime-crew-a', 'crewmate', '${ids.secondA}', 'codex', 'active', 'Crewmate A ready'),
        ('${ids.secondB}', 'runtime-second-b', 'second_mate', '${ids.firstMate}', 'pi', 'active', 'Second Mate B ready'),
        ('${ids.crewB}', 'runtime-crew-b', 'crewmate', '${ids.secondB}', 'codex', 'active', 'Crewmate B ready');

      INSERT INTO agentos.projects (
        id, name, scope_text, status, status_text
      ) VALUES (
        '${ids.project}', 'runtime-authorization',
        'Exercise runtime mutation authorization', 'active', 'Project ready'
      );

      SELECT agentos.register_agent_principal('${ids.firstMate}', 'postgres');
      SELECT agentos.register_agent_principal('${ids.secondA}', 'runtime_second_a');
      SELECT agentos.register_agent_principal('${ids.crewA}', 'runtime_crew_a');
    `);
    yield* database.migrate("0002_runtime_mutation_authorization.sql");
    yield* database.exec(`
      SELECT agentos.register_agent_principal('${ids.secondB}', 'runtime_second_b');
      SELECT agentos.register_agent_principal('${ids.crewB}', 'runtime_crew_b');
    `);
    yield* database.migrate("0004_provision_agents.sql");
  }),
});

layer(databaseLayer)("Agent runtime mutation authorization", (it) => {
  it.effect("provisions direct reports idempotently within the hierarchy", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const secondMates = yield* asLogin("postgres", database.query<{
        readonly id: string;
      }>(`
        SELECT agentos.provision_agent(
          'delivery-second', 'second_mate', 'pi',
          'Waiting for its persistent runtime', 'Delivery Second Mate',
          '{"charter":{"summary":"Own delivery","scope":"AgentOS delivery work"}}'::jsonb
        )::text AS id
      `));
      const secondMateId = (yield* firstRow(
        secondMates,
        "provisioning returned no Second Mate",
      )).id;
      const repeated = yield* asLogin("postgres", database.query<{
        readonly id: string;
      }>(`
        SELECT agentos.provision_agent(
          'delivery-second', 'second_mate', 'pi',
          'This retry does not rewrite runtime state', 'Delivery Second Mate',
          '{"charter":{"summary":"Own delivery","scope":"AgentOS delivery work"}}'::jsonb
        )::text AS id
      `));
      assert.strictEqual(
        (yield* firstRow(repeated, "retry returned no Second Mate")).id,
        secondMateId,
      );

      yield* asLogin("runtime_second_a", Effect.gen(function*() {
        const provisioned = yield* database.query<{ readonly id: string }>(`
          SELECT agentos.provision_agent(
            'runtime-scout', 'crewmate', 'codex',
            'Ready for a task-specific runtime'
          )::text AS id
        `);
        const crewmateId = (yield* firstRow(
          provisioned,
          "provisioning returned no Crewmate",
        )).id;
        const crewmates = yield* database.query<{
          readonly parent_agent_id: string;
        }>(`
          SELECT parent_agent_id::text
            FROM agentos.agents
           WHERE id = '${crewmateId}'
        `);
        assert.strictEqual(
          (yield* firstRow(crewmates, "missing provisioned Crewmate")).parent_agent_id,
          ids.secondA,
        );
        const denied = yield* Effect.flip(database.query(`
          SELECT agentos.provision_agent(
            'nested-second', 'second_mate', 'pi',
            'Second Mates cannot create another Second Mate', 'Nested Second',
            '{"charter":{"summary":"Invalid","scope":"Invalid"}}'::jsonb
          )
        `));
        assert.include(denied.detail, "Second Mate may provision only Crewmates");
      }));

      const crewDenied = yield* Effect.flip(asLogin(
        "runtime_crew_b",
        database.query(`
          SELECT agentos.provision_agent(
            'crew-created-agent', 'crewmate', 'codex',
            'Crewmates cannot provision Agents'
          )
        `),
      ));
      assert.strictEqual(crewDenied.operation, "query");

      yield* asLogin("postgres", Effect.gen(function*() {
        const conflict = yield* Effect.flip(database.query(`
          SELECT agentos.provision_agent(
            'delivery-second', 'second_mate', 'other-harness', 'Conflicting retry',
            'Delivery Second Mate',
            '{"charter":{"summary":"Own delivery","scope":"AgentOS delivery work"}}'::jsonb
          )
        `));
        assert.include(conflict.detail, "conflicts with the existing Agent identity");
        const missingCharter = yield* Effect.flip(database.query(`
          SELECT agentos.provision_agent(
            'missing-charter', 'second_mate', 'pi',
            'Invalid Second Mate', 'Missing Charter'
          )
        `));
        assert.include(missingCharter.detail, "charter requires non-empty summary and scope");
      }));

      const provisioned = yield* database.query<{
        readonly count: number;
        readonly lifecycle_status: string;
        readonly parent_agent_id: string;
      }>(`
        SELECT count(*)::int AS count,
               min(lifecycle_status) AS lifecycle_status,
               min(parent_agent_id::text) AS parent_agent_id
          FROM agentos.agents WHERE handle = 'delivery-second'
      `);
      assert.deepStrictEqual(provisioned, [{
        count: 1,
        lifecycle_status: "provisioning",
        parent_agent_id: ids.firstMate,
      }]);
    }));

  it.effect("lets Mates create and assign work only inside their hierarchy", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin("runtime_second_a", Effect.gen(function*() {
        yield* database.exec(`
          INSERT INTO agentos.tasks (
            id, project_id, created_by_agent_id, title, status, status_text
          ) VALUES (
            '${ids.taskA}', '${ids.project}', '${ids.secondA}',
            'Task A', 'active', 'Ready for Crewmate A'
          );
          INSERT INTO agentos.task_assignments (
            task_id, agent_id, assigned_by_agent_id, assignment_role, status,
            status_text
          ) VALUES (
            '${ids.taskA}', '${ids.crewA}', '${ids.secondA}', 'worker', 'assigned',
            'Assigned by Second Mate A'
          );
        `);
        const crossTree = yield* Effect.flip(database.exec(`
          INSERT INTO agentos.task_assignments (
            task_id, agent_id, assigned_by_agent_id, assignment_role, status,
            status_text
          ) VALUES (
            '${ids.taskA}', '${ids.crewB}', '${ids.secondA}', 'worker', 'assigned',
            'Attempted cross-tree assignment'
          )
        `));
        assert.strictEqual(crossTree.operation, "exec");
      }));
      yield* asLogin("runtime_second_b", database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, status, status_text
        ) VALUES (
          '${ids.taskB}', '${ids.project}', '${ids.secondB}',
          'Task B', 'active', 'Ready for Crewmate B'
        )
      `));
      yield* asLogin("runtime_crew_a", Effect.gen(function*() {
        yield* database.exec(`
          UPDATE agentos.tasks
             SET status = 'in_progress',
                 status_text = 'Crewmate A started assigned work'
           WHERE id = '${ids.taskA}';
          UPDATE agentos.tasks
             SET status_text = 'Crewmate A attempted unrelated work'
           WHERE id = '${ids.taskB}';
        `);
        const scopeRewrite = yield* Effect.flip(database.exec(`
          UPDATE agentos.tasks SET title = 'Crewmate A rewrote task scope'
           WHERE id = '${ids.taskA}'
        `));
        assert.strictEqual(scopeRewrite.operation, "exec");
      }));
      const tasks = yield* database.query<{
        readonly id: string;
        readonly status_text: string;
      }>(`
        SELECT id, status_text FROM agentos.tasks
         WHERE id IN ('${ids.taskA}', '${ids.taskB}') ORDER BY id
      `);
      assert.deepStrictEqual(tasks, [
        { id: ids.taskA, status_text: "Crewmate A started assigned work" },
        { id: ids.taskB, status_text: "Ready for Crewmate B" },
      ]);
    }));

  it.effect("lets only the authenticated Mate reconcile external events", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin("runtime_second_b", database.exec(`
        INSERT INTO agentos.tasks (
          id, project_id, created_by_agent_id, title, status, status_text
        ) VALUES (
          '${ids.externalTask}', '${ids.project}', '${ids.secondB}',
          'Reconcile external event', 'active', 'Awaiting provider event'
        );
        INSERT INTO agentos.task_assignments (
          task_id, agent_id, assigned_by_agent_id, assignment_role, status,
          status_text
        ) VALUES (
          '${ids.externalTask}', '${ids.crewB}', '${ids.secondB}', 'worker',
          'assigned', 'Crewmate B owns the linked implementation'
        );
      `));
      yield* database.exec(`
        SELECT agentos.ingest_external_event(
          'github', 'runtime-delivery-1', 'issues.edited',
          'repo:akua/agentos:issue:runtime', '{"action":"edited"}'::jsonb,
          'captain', '{}'::jsonb, interval '1 microsecond', interval '30 seconds'
        )
      `);
      const crewClaim = yield* Effect.flip(asLogin(
        "runtime_crew_b",
        database.query(`
          SELECT * FROM agentos.claim_external_events('${ids.crewB}', 'github')
        `),
      ));
      assert.strictEqual(crewClaim.operation, "query");

      yield* asLogin("runtime_second_b", Effect.gen(function*() {
        const wrongIdentity = yield* Effect.flip(database.query(`
          SELECT * FROM agentos.claim_external_events('${ids.secondA}', 'github')
        `));
        assert.include(wrongIdentity.detail, "authenticated Agent identity");
        const claims = yield* database.query<{ readonly claimed_token: string }>(`
          SELECT claimed_token::text
            FROM agentos.claim_external_events(
              '${ids.secondB}', 'github',
              'repo:akua/agentos:issue:runtime', interval '5 minutes'
            )
        `);
        const claimToken = (yield* firstRow(claims, "claim returned no token")).claimed_token;
        const bypass = yield* Effect.flip(database.exec(`
          UPDATE agentos.external_events
             SET status_text = 'Bypassed the reconciliation functions'
           WHERE claim_token = '${claimToken}'
        `));
        assert.strictEqual(bypass.operation, "exec");
        yield* database.exec(`
          BEGIN;
          UPDATE agentos.tasks
             SET status = 'completed',
                 status_text = 'Reconciled from the current provider state',
                 completed_at = transaction_timestamp()
           WHERE id = '${ids.externalTask}';
          SELECT agentos.complete_external_event_claim(
            '${ids.secondB}', '${claimToken}', '{"outcome":"task-updated"}'::jsonb
          );
          COMMIT;
        `);
      }));
      const reconciled = yield* database.query<{
        readonly reconciliation_status: string;
        readonly task_status: string;
      }>(`
        SELECT event.reconciliation_status, task.status AS task_status
          FROM agentos.external_events AS event
          JOIN agentos.tasks AS task ON task.id = '${ids.externalTask}'
         WHERE event.delivery_id = 'runtime-delivery-1'
      `);
      assert.deepStrictEqual(reconciled, [{
        reconciliation_status: "reconciled",
        task_status: "completed",
      }]);
    }));

  it.effect("requires an explicit handoff before retiring an Agent", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const activeChildren = yield* Effect.flip(asLogin("postgres", database.exec(`
        SELECT agentos.retire_agent(
          '${ids.secondA}', 'Attempted retirement before child handoff'
        )
      `)));
      assert.include(activeChildren.detail, "active child Agents");

      yield* asLogin("runtime_second_a", Effect.gen(function*() {
        yield* database.exec(`
          INSERT INTO agentos.tasks (
            id, project_id, created_by_agent_id, title, status, status_text
          ) VALUES (
            '${ids.retirementTask}', '${ids.project}', '${ids.secondA}',
            'Retirement handoff', 'active', 'Crewmate A still owns this work'
          );
          INSERT INTO agentos.task_assignments (
            task_id, agent_id, assigned_by_agent_id, assignment_role, status,
            status_text
          ) VALUES (
            '${ids.retirementTask}', '${ids.crewA}', '${ids.secondA}', 'worker',
            'active', 'Assignment must be handed off before retirement'
          );
        `);
        const activeWork = yield* Effect.flip(database.exec(`
          SELECT agentos.retire_agent(
            '${ids.crewA}', 'Retired after completing assigned work'
          )
        `));
        assert.include(activeWork.detail, "active Task assignments");
        const hierarchy = yield* Effect.flip(database.exec(`
          SELECT agentos.retire_agent(
            '${ids.crewB}', 'Attempted retirement outside the managed hierarchy'
          )
        `));
        assert.include(hierarchy.detail, "managed hierarchy");
      }));

      yield* asLogin("runtime_crew_a", database.exec(`
        UPDATE agentos.task_assignments
           SET status = 'completed',
               status_text = 'Crewmate A completed the assignment',
               started_at = transaction_timestamp(),
               ended_at = transaction_timestamp()
         WHERE agent_id = '${ids.crewA}' AND ended_at IS NULL
      `));
      yield* asLogin("runtime_second_a", Effect.gen(function*() {
        const immutable = yield* Effect.flip(database.exec(`
          UPDATE agentos.task_assignments
             SET status_text = 'Rewrote completed assignment history'
           WHERE task_id = '${ids.retirementTask}' AND agent_id = '${ids.crewA}'
        `));
        assert.include(immutable.detail, "completed Task assignment is immutable");
        yield* database.exec(`
          SELECT agentos.retire_agent(
            '${ids.crewA}', 'Retired after completing assigned work'
          )
        `);
      }));
      const retired = yield* database.query<{
        readonly lifecycle_status: string;
        readonly retired_at: string | null;
        readonly status_text: string;
      }>(`
        SELECT lifecycle_status, retired_at, status_text
          FROM agentos.agents WHERE id = '${ids.crewA}'
      `);
      const retiredCrew = yield* firstRow(retired, "missing retired Crewmate");
      assert.strictEqual(retiredCrew.lifecycle_status, "retired");
      assert.isNotNull(retiredCrew.retired_at);
      assert.strictEqual(
        retiredCrew.status_text,
        "Retired after completing assigned work",
      );
      const visible = yield* asLogin(
        "runtime_crew_a",
        database.query<{ readonly count: number }>(
          "SELECT count(*)::int AS count FROM agentos.tasks",
        ),
      );
      assert.strictEqual(
        (yield* firstRow(visible, "missing retired Agent visibility count")).count,
        0,
      );
    }));
});
