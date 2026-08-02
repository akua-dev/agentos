import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { PGlite } from "@electric-sql/pglite";
import { assert, layer } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Path } from "effect";
import { fileURLToPath } from "node:url";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const ids = {
  caller: "51000000-0000-4000-8000-000000000011",
  target: "51000000-0000-4000-8000-000000000012",
  sibling: "51000000-0000-4000-8000-000000000013",
  task: "81000000-0000-4000-8000-000000000011",
  assignment: "91000000-0000-4000-8000-000000000011",
  inbox: "a1000000-0000-4000-8000-000000000011",
};

class TestDatabase extends Context.Service<TestDatabase, {
  readonly exec: (statement: string) => Effect.Effect<void, Error>;
  readonly query: <Row extends object>(
    statement: string,
  ) => Effect.Effect<ReadonlyArray<Row>, Error>;
}>()("agentos/test/A2aDatabase") {}

function databaseFailure(operation: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : "unknown failure";
  return new Error(`${operation}: ${detail}`);
}

const databaseLayer = Layer.effect(TestDatabase, Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const database = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => PGlite.create(),
      catch: (cause) => databaseFailure("create test database", cause),
    }),
    (database) => Effect.tryPromise({
      try: () => database.close(),
      catch: (cause) => databaseFailure("close test database", cause),
    }).pipe(Effect.ignore),
  );
  const exec = Effect.fn("test.a2aDatabase.exec")((statement: string) =>
    Effect.tryPromise({
      try: () => database.exec(statement),
      catch: (cause) => databaseFailure("execute test statement", cause),
    }).pipe(Effect.asVoid));
  const query = <Row extends object>(statement: string) =>
    Effect.tryPromise({
      try: () => database.query<Row>(statement),
      catch: (cause) => databaseFailure("query test database", cause),
    }).pipe(Effect.map((result) => result.rows));

  const migrationFiles = (yield* fileSystem.readDirectory(migrationsDirectory))
    .filter((entry) => /^\d+_.+\.sql$/.test(entry))
    .sort();
  for (const migrationFile of migrationFiles) {
    yield* fileSystem.readFileString(
      paths.join(migrationsDirectory, migrationFile),
    ).pipe(Effect.flatMap(exec));
  }
  const roots = yield* query<{ readonly id: string }>(`
    SELECT id::text AS id FROM agentos.agents WHERE role = 'first_mate'
  `);
  const firstMate = roots[0]?.id;
  if (firstMate === undefined) {
    return yield* Effect.fail(new Error("test Fleet has no First Mate"));
  }
  yield* exec(`
    CREATE ROLE a2a_service_test LOGIN;
    CREATE ROLE a2a_caller_test LOGIN;
    CREATE ROLE a2a_target_test LOGIN;
    CREATE ROLE a2a_unrelated_test LOGIN;

    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status,
      status_text, kubernetes_namespace, kubernetes_pod
    ) VALUES (
      '${ids.caller}', 'a2a-caller', 'second_mate', '${firstMate}', 'pi',
      'active', 'A2A caller ready', 'agentos-platform', 'a2a-caller-0'
    ), (
      '${ids.target}', 'a2a-target', 'crewmate', '${ids.caller}', 'codex',
      'active', 'A2A target ready', 'agentos-platform', 'a2a-target-0'
    ), (
      '${ids.sibling}', 'a2a-sibling', 'crewmate', '${ids.caller}', 'codex',
      'active', 'A2A sibling ready', 'agentos-platform', 'a2a-sibling-0'
    );
    SELECT agentos.register_agent_principal('${ids.caller}', 'a2a_caller_test');
    SELECT agentos.register_agent_principal('${ids.target}', 'a2a_target_test');

    INSERT INTO agentos.tasks (
      id, created_by_agent_id, title, status, status_text
    ) VALUES (
      '${ids.task}', '${ids.caller}', 'A2A delivery test', 'active',
      'Exercise PostgreSQL-first A2A delivery'
    );
    INSERT INTO agentos.task_assignments (
      id, task_id, agent_id, assigned_by_agent_id, assignment_role,
      status, status_text, started_at, brief
    ) VALUES (
      '${ids.assignment}', '${ids.task}', '${ids.target}', '${ids.caller}',
      'ship', 'active', 'A2A target assignment active',
      transaction_timestamp(), 'Canonical brief stays in PostgreSQL'
    );

    SET SESSION AUTHORIZATION a2a_caller_test;
    INSERT INTO agentos.inbox (
      id, sender_agent_id, sender_label, recipient_agent_id, task_id, kind,
      subject, body, status, status_text, metadata
    ) VALUES (
      '${ids.inbox}', '${ids.caller}', 'a2a-caller', '${ids.target}',
      '${ids.task}', 'request', 'Implement the reviewed repository change',
      'Protected body stays in PostgreSQL', 'unread', 'Awaiting recipient',
      jsonb_build_object(
        'a2aSkillId', 'repository.implementation@v1',
        'a2aAssignmentId', '${ids.assignment}'
      )
    );
    SET SESSION AUTHORIZATION postgres;

    GRANT USAGE ON SCHEMA agentos TO a2a_service_test;
    GRANT SELECT ON ALL TABLES IN SCHEMA agentos TO a2a_service_test;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA agentos TO a2a_service_test;
    SELECT agentos.configure_a2a_service_privileges('a2a_service_test');
  `);
  return TestDatabase.of({ exec, query });
})).pipe(Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)));

const asLogin = Effect.fn("test.a2aDatabase.asLogin")(
  function*<A, E, R>(
    role: "a2a_service_test" | "a2a_target_test" | "a2a_unrelated_test",
    operation: Effect.Effect<A, E, R>,
  ) {
    const database = yield* TestDatabase;
    return yield* Effect.acquireUseRelease(
      database.exec(`SET SESSION AUTHORIZATION ${role}`),
      () => operation,
      () => database.exec("SET SESSION AUTHORIZATION postgres").pipe(
        Effect.orDie,
      ),
    );
  },
);

function verify(overrides?: {
  readonly assignmentId?: string;
  readonly callerAgentId?: string;
  readonly skillId?: string;
}) {
  return Effect.gen(function*() {
    const database = yield* TestDatabase;
    return yield* database.query<{
      readonly version: number;
      readonly inboxId: string;
      readonly taskId: string | null;
      readonly assignmentId: string | null;
      readonly callerAgentId: string;
      readonly targetAgentId: string;
      readonly speechAct: string;
      readonly canonicalInbox: string;
      readonly a2aContextId: string;
      readonly skillId: string;
      readonly subject: string;
    }>(`
      SELECT * FROM agentos.verify_a2a_inbox_reference(
        '${ids.inbox}', '${ids.task}',
        '${overrides?.assignmentId ?? ids.assignment}',
        '${overrides?.callerAgentId ?? ids.caller}', '${ids.target}',
        'request',
        '${overrides?.skillId ?? "repository.implementation@v1"}',
        'Implement the reviewed repository change'
      )
    `);
  });
}

layer(databaseLayer)("PostgreSQL-first A2A delivery boundary", (it) => {
  it.effect("exposes only content-free exact-reference functions", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      const privileges = yield* database.query<{
        readonly inboxSelect: boolean;
        readonly projectExecute: boolean;
        readonly verifyExecute: boolean;
        readonly wakeExecute: boolean;
        readonly receiveExecute: boolean;
        readonly configureExecute: boolean;
      }>(`
        SELECT
          has_table_privilege(
            'a2a_service_test', 'agentos.inbox', 'SELECT'
          ) AS "inboxSelect",
          has_function_privilege(
            'a2a_service_test',
            'agentos.verify_a2a_inbox_reference(uuid,uuid,uuid,uuid,uuid,text,text,text)',
            'EXECUTE'
          ) AS "verifyExecute",
          has_function_privilege(
            'a2a_service_test',
            'agentos.wake_a2a_inbox_reference(uuid)', 'EXECUTE'
          ) AS "wakeExecute",
          has_function_privilege(
            'a2a_service_test',
            'agentos.read_a2a_delivery_projection(uuid,uuid,uuid)', 'EXECUTE'
          ) AS "projectExecute",
          has_function_privilege(
            'a2a_service_test', 'agentos.receive_inbox(uuid)', 'EXECUTE'
          ) AS "receiveExecute",
          has_function_privilege(
            'a2a_service_test',
            'agentos.configure_a2a_service_privileges(name)', 'EXECUTE'
          ) AS "configureExecute"
      `);
      assert.deepStrictEqual(privileges, [{
        inboxSelect: false,
        projectExecute: true,
        verifyExecute: true,
        wakeExecute: true,
        receiveExecute: false,
        configureExecute: false,
      }]);
      const directRead = yield* Effect.exit(asLogin(
        "a2a_service_test",
        database.query("SELECT body FROM agentos.inbox"),
      ));
      assert.isTrue(Exit.isFailure(directRead));
    }));

  it.effect("verifies the exact committed direct-edge Assignment reference", () =>
    Effect.gen(function*() {
      const rows = yield* asLogin("a2a_service_test", verify());
      assert.deepStrictEqual(rows, [{
        version: 1,
        inboxId: ids.inbox,
        taskId: ids.task,
        assignmentId: ids.assignment,
        callerAgentId: ids.caller,
        targetAgentId: ids.target,
        speechAct: "request",
        canonicalInbox: "unread",
        a2aContextId: `agentos:task:${ids.task}`,
        skillId: "repository.implementation@v1",
        subject: "Implement the reviewed repository change",
      }]);
      for (const mismatch of [{
        callerAgentId: ids.sibling,
      }, {
        skillId: "production.deployment@v1",
      }, {
        assignmentId: "91000000-0000-4000-8000-000000000099",
      }]) {
        assert.deepStrictEqual(
          yield* asLogin("a2a_service_test", verify(mismatch)),
          [],
        );
      }
    }));

  it.effect("replays only a wake and leaves all durable row counts unchanged", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      const counts = () => database.query<{
        readonly assignments: number;
        readonly inbox: number;
        readonly tasks: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM agentos.tasks) AS tasks,
          (SELECT count(*)::int FROM agentos.task_assignments) AS assignments,
          (SELECT count(*)::int FROM agentos.inbox) AS inbox
      `);
      const before = yield* counts();
      for (const _attempt of [1, 2]) {
        const rows = yield* asLogin(
          "a2a_service_test",
          database.query<{ readonly inboxId: string }>(`
            SELECT * FROM agentos.wake_a2a_inbox_reference('${ids.inbox}')
          `),
        );
        assert.strictEqual(rows.length, 1);
      }
      assert.deepStrictEqual(yield* counts(), before);
    }));

  it.effect("derives GetTask only from the canonical Inbox receipt", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      const projection = () => asLogin(
        "a2a_service_test",
        database.query<{
          readonly version: number;
          readonly inboxId: string;
          readonly taskId: string | null;
          readonly contextId: string;
          readonly state: string;
          readonly canonicalInbox: string;
          readonly skillId: string;
          readonly assignmentId: string | null;
        }>(`
          SELECT * FROM agentos.read_a2a_delivery_projection(
            '${ids.inbox}', '${ids.caller}', '${ids.target}'
          )
        `),
      );
      assert.deepStrictEqual(yield* projection(), [{
        version: 1,
        inboxId: ids.inbox,
        taskId: ids.task,
        contextId: `agentos:task:${ids.task}`,
        state: "TASK_STATE_SUBMITTED",
        canonicalInbox: "unread",
        skillId: "repository.implementation@v1",
        assignmentId: ids.assignment,
      }]);
      yield* asLogin(
        "a2a_target_test",
        database.query(`SELECT * FROM agentos.receive_inbox('${ids.inbox}')`),
      );
      assert.deepStrictEqual(yield* projection(), [{
        version: 1,
        inboxId: ids.inbox,
        taskId: ids.task,
        contextId: `agentos:task:${ids.task}`,
        state: "TASK_STATE_COMPLETED",
        canonicalInbox: "read",
        skillId: "repository.implementation@v1",
        assignmentId: ids.assignment,
      }]);
      assert.deepStrictEqual(
        yield* asLogin(
          "a2a_service_test",
          database.query(`
            SELECT * FROM agentos.read_a2a_delivery_projection(
              '${ids.inbox}', '${ids.sibling}', '${ids.target}'
            )
          `),
        ),
        [],
      );
    }));

  it.effect("does not expose A2A functions to an unrelated database login", () =>
    Effect.gen(function*() {
      const denied = yield* Effect.exit(asLogin("a2a_unrelated_test", verify()));
      assert.isTrue(Exit.isFailure(denied));
    }));
});
