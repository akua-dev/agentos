import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { PGlite } from "@electric-sql/pglite";
import { assert, layer } from "@effect/vitest";
import { fileURLToPath } from "node:url";
import { Context, Effect, Exit, FileSystem, Layer, Path } from "effect";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const ids = {
  crewmate: "51000000-0000-4000-8000-000000000003",
  task: "81000000-0000-4000-8000-000000000001",
  assignment: "91000000-0000-4000-8000-000000000001",
  ceiling: "ceiling_0123456789abcdef0123456789abcdef",
  binding: "binding_0123456789abcdef0123456789abcdef",
  assignmentBinding: "binding_2123456789abcdef0123456789abcdef",
};
const scope = { kind: "domain", fleet: "agentos", domain: "platform" };
const subject = {
  kind: "mate",
  fleet: "agentos",
  domain: "platform",
  agentId: ids.crewmate,
};
const assignmentSubject = {
  kind: "assignment",
  fleet: "agentos",
  domain: "platform",
  assignmentId: ids.assignment,
};
const permission = {
  capability: "github.issue.write",
  resource: {
    kind: "github_repository",
    owner: "akua-dev",
    repository: "agentos",
  },
  environment: "production",
  expiresAtMillis: 1785715200000,
  rateClass: "standard",
};

function databaseFailure(operation: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : "unknown failure";
  return new Error(`${operation}: ${detail}`);
}

class TestDatabase extends Context.Service<TestDatabase, {
  readonly exec: (statement: string) => Effect.Effect<void, Error>;
  readonly query: <Row extends object>(
    statement: string,
  ) => Effect.Effect<ReadonlyArray<Row>, Error>;
}>()("agentos/test/EgressAuthorizerDatabase") {}

const databaseLayer = Layer.effect(
  TestDatabase,
  Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const database = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => PGlite.create(),
        catch: (cause) => databaseFailure("create test database", cause),
      }),
      (database) =>
        Effect.tryPromise({
          try: () => database.close(),
          catch: (cause) => databaseFailure("close test database", cause),
        }).pipe(Effect.ignore),
    );
    const exec = Effect.fn("test.egressAuthorizerDatabase.exec")(
      (statement: string) =>
        Effect.tryPromise({
          try: () => database.exec(statement),
          catch: (cause) => databaseFailure("execute test statement", cause),
        }).pipe(Effect.asVoid),
    );
    const query = <Row extends object>(statement: string) =>
      Effect.tryPromise({
        try: () => database.query<Row>(statement),
        catch: (cause) => databaseFailure("query test database", cause),
      }).pipe(Effect.map((result) => result.rows));

    const migrationFiles = (yield* fileSystem.readDirectory(
      migrationsDirectory,
    )).filter((entry) => /^\d+_.+\.sql$/.test(entry)).sort();
    for (const migrationFile of migrationFiles) {
      yield* fileSystem.readFileString(
        paths.join(migrationsDirectory, migrationFile),
      ).pipe(Effect.flatMap(exec));
    }
    const firstMates = yield* query<{ readonly id: string }>(`
      SELECT id::text AS id FROM agentos.agents WHERE role = 'first_mate'
    `);
    const firstMate = firstMates[0]?.id;
    if (firstMate === undefined) {
      return yield* Effect.fail(new Error("test Fleet has no First Mate"));
    }
    yield* exec(`
      CREATE ROLE egress_authz_test LOGIN;
      CREATE ROLE egress_unrelated LOGIN;
      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status,
        status_text, kubernetes_namespace, kubernetes_pod
      ) VALUES (
        '${ids.crewmate}', 'egress-crew', 'crewmate', '${firstMate}', 'codex',
        'active', 'Egress authorizer test Crewmate', 'crew-platform', 'crew-pod'
      );
      INSERT INTO agentos.tasks (
        id, created_by_agent_id, title, status, status_text
      ) VALUES (
        '${ids.task}', '${firstMate}', 'Egress access test', 'active',
        'Exercise the least-privilege egress authorizer readers'
      );
      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, started_at, brief
      ) VALUES (
        '${ids.assignment}', '${ids.task}', '${ids.crewmate}', '${firstMate}',
        'ship', 'active', 'Egress access assignment is active',
        transaction_timestamp(), 'Exercise Assignment-bound access'
      );
      INSERT INTO agentos.access_ceilings (
        ceiling_id, revision, supersedes_revision, scope, effective_at_millis,
        permissions, document_digest, state
      ) VALUES (
        '${ids.ceiling}', 1, NULL, '${JSON.stringify(scope)}'::jsonb,
        1785542400000, '${JSON.stringify([permission])}'::jsonb,
        '${"f".repeat(64)}', 'active'
      );
      INSERT INTO agentos.access_profiles (
        profile_id, profile_version, previous_profile_version, ceiling_id,
        ceiling_revision, target_scope, permissions, published_by_agent_id
      ) VALUES (
        'github-maintainer', 1, NULL, '${ids.ceiling}', 1,
        '${JSON.stringify(scope)}'::jsonb,
        '${JSON.stringify([permission])}'::jsonb, '${firstMate}'
      );
      INSERT INTO agentos.access_profile_heads (profile_id, profile_version)
      VALUES ('github-maintainer', 1);
      INSERT INTO agentos.access_bindings (
        binding_id, profile_id, profile_version, subject, created_at_millis,
        expires_at_millis, ceiling_id, ceiling_revision, state,
        created_by_agent_id
      ) VALUES (
        '${ids.binding}', 'github-maintainer', 1,
        '${JSON.stringify(subject)}'::jsonb, 1785542400000, 1785715200000,
        '${ids.ceiling}', 1, 'active', '${firstMate}'
      ), (
        '${ids.assignmentBinding}', 'github-maintainer', 1,
        '${JSON.stringify(assignmentSubject)}'::jsonb,
        1785542400000, 1785715200000,
        '${ids.ceiling}', 1, 'active', '${firstMate}'
      );

      GRANT USAGE ON SCHEMA agentos TO egress_authz_test;
      GRANT SELECT ON ALL TABLES IN SCHEMA agentos TO egress_authz_test;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA agentos TO egress_authz_test;
      SELECT agentos.configure_egress_authorizer_privileges(
        'egress_authz_test'
      );
    `);
    return TestDatabase.of({ exec, query });
  }),
).pipe(
  Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)),
);

const asLogin = Effect.fn("test.egressAuthorizerDatabase.asLogin")(
  function*<A, E, R>(
    role: "egress_authz_test" | "egress_unrelated",
    operation: Effect.Effect<A, E, R>,
  ) {
    const database = yield* TestDatabase;
    return yield* Effect.acquireUseRelease(
      database.exec(`SET SESSION AUTHORIZATION ${role}`),
      () => operation,
      () =>
        database.exec("SET SESSION AUTHORIZATION postgres").pipe(
          Effect.orDie,
        ),
    );
  },
);

layer(databaseLayer)("egress authorizer PostgreSQL boundary", (it) => {
  it.effect("strips broad grants and exposes only exact consistent readers", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      const privilegeRows = yield* database.query<{
        readonly agentsSelect: boolean;
        readonly snapshotExecute: boolean;
        readonly mutationExecute: boolean;
        readonly configuratorExecute: boolean;
      }>(`
        SELECT
          has_table_privilege(
            'egress_authz_test', 'agentos.agents', 'SELECT'
          ) AS "agentsSelect",
          has_function_privilege(
            'egress_authz_test',
            'agentos.read_egress_policy_snapshots(jsonb)', 'EXECUTE'
          ) AS "snapshotExecute",
          has_function_privilege(
            'egress_authz_test',
            'agentos.publish_access_profile(uuid,text,integer,text,integer,jsonb,text,text,text,uuid)',
            'EXECUTE'
          ) AS "mutationExecute",
          has_function_privilege(
            'egress_authz_test',
            'agentos.configure_egress_authorizer_privileges(name)',
            'EXECUTE'
          ) AS "configuratorExecute"
      `);
      assert.deepStrictEqual(privilegeRows, [{
        agentsSelect: false,
        snapshotExecute: true,
        mutationExecute: false,
        configuratorExecute: false,
      }]);

      const directRead = yield* Effect.exit(asLogin(
        "egress_authz_test",
        database.query("SELECT id FROM agentos.agents"),
      ));
      assert.isTrue(Exit.isFailure(directRead));

      const agentRows = yield* asLogin(
        "egress_authz_test",
        database.query<{
          readonly agentId: string;
          readonly role: string;
          readonly fleet: string;
          readonly domain: string;
          readonly kubernetesNamespace: string;
          readonly kubernetesPod: string;
          readonly lifecycleStatus: string;
          readonly retiredAtMillis: number | null;
        }>(`
          SELECT * FROM agentos.read_egress_workload_agents(
            'crew-platform', 'crew-pod'
          )
        `),
      );
      assert.deepStrictEqual(agentRows, [{
        agentId: ids.crewmate,
        role: "crewmate",
        fleet: "agentos",
        domain: "platform",
        kubernetesNamespace: "crew-platform",
        kubernetesPod: "crew-pod",
        lifecycleStatus: "active",
        retiredAtMillis: null,
      }]);

      const assignmentRows = yield* asLogin(
        "egress_authz_test",
        database.query<{
          readonly assignmentId: string;
          readonly agentId: string;
          readonly status: string;
          readonly endedAtMillis: number | null;
        }>(`
          SELECT * FROM agentos.read_egress_assignments(
            '${ids.crewmate}'
          )
        `),
      );
      assert.deepStrictEqual(assignmentRows, [{
        assignmentId: ids.assignment,
        agentId: ids.crewmate,
        status: "active",
        endedAtMillis: null,
      }]);

      const snapshotRows = yield* asLogin(
        "egress_authz_test",
        database.query<{
          readonly bindingId: string;
          readonly bindingState: string;
          readonly profileVersion: number;
          readonly profileHeadVersion: number;
          readonly ceilingState: string;
          readonly pendingCeilingRevision: number | null;
          readonly operationInProgress: boolean;
        }>(`
          SELECT * FROM agentos.read_egress_policy_snapshots(
            '${JSON.stringify(subject)}'::jsonb
          )
        `),
      );
      assert.deepStrictEqual(snapshotRows.map((row) => ({
        bindingId: row.bindingId,
        bindingState: row.bindingState,
        profileVersion: row.profileVersion,
        profileHeadVersion: row.profileHeadVersion,
        ceilingState: row.ceilingState,
        pendingCeilingRevision: row.pendingCeilingRevision,
        operationInProgress: row.operationInProgress,
      })), [{
        bindingId: ids.binding,
        bindingState: "active",
        profileVersion: 1,
        profileHeadVersion: 1,
        ceilingState: "active",
        pendingCeilingRevision: null,
        operationInProgress: false,
      }]);

      const assignmentSnapshot = yield* asLogin(
        "egress_authz_test",
        database.query<{ readonly bindingId: string }>(`
          SELECT * FROM agentos.read_egress_policy_snapshots(
            '${JSON.stringify(assignmentSubject)}'::jsonb
          )
        `),
      );
      assert.deepStrictEqual(
        assignmentSnapshot.map((row) => row.bindingId),
        [ids.assignmentBinding],
      );

      const unrelatedRead = yield* Effect.exit(asLogin(
        "egress_unrelated",
        database.query(`
          SELECT * FROM agentos.read_egress_policy_snapshots(
            '${JSON.stringify(subject)}'::jsonb
          )
        `),
      ));
      assert.isTrue(Exit.isFailure(unrelatedRead));

      yield* database.exec(`
        INSERT INTO agentos.access_ceilings (
          ceiling_id, revision, supersedes_revision, scope,
          effective_at_millis, permissions, document_digest, state
        ) VALUES (
          '${ids.ceiling}', 2, 1, '${JSON.stringify(scope)}'::jsonb,
          1785628800000, '${JSON.stringify([permission])}'::jsonb,
          '${"e".repeat(64)}', 'pending'
        )
      `);
      const pendingRows = yield* asLogin(
        "egress_authz_test",
        database.query<{
          readonly pendingCeilingRevision: number | null;
        }>(`
          SELECT * FROM agentos.read_egress_policy_snapshots(
            '${JSON.stringify(subject)}'::jsonb
          )
        `),
      );
      assert.strictEqual(pendingRows[0]?.pendingCeilingRevision, 2);
    }));
});
