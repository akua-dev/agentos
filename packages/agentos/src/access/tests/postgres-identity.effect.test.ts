import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Ref,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import * as PgClient from "@effect/sql-pg/PgClient";
import { Reactivity } from "effect/unstable/reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlConnection from "effect/unstable/sql/SqlConnection";
import {
  ConnectionError,
  SqlError,
} from "effect/unstable/sql/SqlError";

import {
  AgentOSWorkloadIdentityStorePostgresLayer,
  ProviderAccessDatabase,
  ProviderAccessDatabaseSqlLayer,
  ProviderAccessDatabaseUnavailable,
  ProviderPolicySnapshotStore,
  ProviderPolicySnapshotStorePostgresLayer,
  ProviderPolicySnapshotUnavailable,
} from "../postgres-identity.ts";
import {
  AgentOSWorkloadIdentityStore,
  WorkloadIdentityDependencyUnavailable,
  type AgentOSWorkloadAgentV1,
  type AgentOSWorkloadAssignmentV1,
} from "../identity.ts";
import type {
  AccessBindingSubjectV1,
  AccessCeilingScopeV1,
  AccessPermissionV1,
} from "../contracts.ts";

const Now = 1785585600000;
const AgentId = "51000000-0000-4000-8000-000000000003";
const AssignmentId = "91000000-0000-4000-8000-000000000001";
const CeilingId = "ceiling_0123456789abcdef0123456789abcdef";
const BindingId = "binding_0123456789abcdef0123456789abcdef";
const subject: AccessBindingSubjectV1 = {
  kind: "mate",
  fleet: "agentos",
  domain: "platform",
  agentId: AgentId,
};
const scope: AccessCeilingScopeV1 = {
  kind: "domain",
  fleet: "agentos",
  domain: "platform",
};
const permission: AccessPermissionV1 = {
  capability: "github.issue.write",
  resource: {
    kind: "github_repository",
    owner: "akua-dev",
    repository: "agentos",
  },
  environment: "production",
  expiresAtMillis: Now + 3_600_000,
  rateClass: "standard",
};
const agentRow: AgentOSWorkloadAgentV1 = {
  agentId: AgentId,
  role: "crewmate",
  fleet: "agentos",
  domain: "platform",
  kubernetesNamespace: "crew-platform",
  kubernetesPod: "crew-pod",
  lifecycleStatus: "active",
  retiredAtMillis: null,
};
const assignmentRow: AgentOSWorkloadAssignmentV1 = {
  assignmentId: AssignmentId,
  agentId: AgentId,
  status: "active",
  endedAtMillis: null,
};
interface SnapshotRowFixture {
  readonly bindingId: string;
  readonly bindingSubject: AccessBindingSubjectV1;
  readonly bindingCreatedAtMillis: number;
  readonly bindingExpiresAtMillis: number | null;
  readonly bindingState: "pending" | "active";
  readonly profileId: string;
  readonly profileVersion: number;
  readonly previousProfileVersion: number | null;
  readonly profileTargetScope: AccessCeilingScopeV1;
  readonly profilePermissions: readonly [AccessPermissionV1];
  readonly profileCeilingId: string;
  readonly profileCeilingRevision: number;
  readonly profileHeadVersion: number | null;
  readonly bindingCeilingId: string;
  readonly bindingCeilingRevision: number;
  readonly ceilingScope: AccessCeilingScopeV1;
  readonly ceilingEffectiveAtMillis: number;
  readonly ceilingPermissions: readonly [AccessPermissionV1];
  readonly ceilingState: "pending" | "active" | "superseded";
  readonly pendingCeilingRevision: number | null;
  readonly operationInProgress: boolean;
}

const snapshotRow: SnapshotRowFixture = {
  bindingId: BindingId,
  bindingSubject: subject,
  bindingCreatedAtMillis: Now - 3_600_000,
  bindingExpiresAtMillis: Now + 3_600_000,
  bindingState: "active",
  profileId: "github-maintainer",
  profileVersion: 1,
  previousProfileVersion: null,
  profileTargetScope: scope,
  profilePermissions: [permission],
  profileCeilingId: CeilingId,
  profileCeilingRevision: 1,
  profileHeadVersion: 1,
  bindingCeilingId: CeilingId,
  bindingCeilingRevision: 1,
  ceilingScope: scope,
  ceilingEffectiveAtMillis: Now - 3_600_000,
  ceilingPermissions: [permission],
  ceilingState: "active",
  pendingCeilingRevision: null,
  operationInProgress: false,
};

function databaseLayer(input?: {
  readonly agents?: Effect.Effect<ReadonlyArray<unknown>, ProviderAccessDatabaseUnavailable>;
  readonly assignments?: Effect.Effect<ReadonlyArray<unknown>, ProviderAccessDatabaseUnavailable>;
  readonly snapshots?: Effect.Effect<ReadonlyArray<unknown>, ProviderAccessDatabaseUnavailable>;
}) {
  return Layer.succeed(ProviderAccessDatabase)({
    findWorkloadAgents: () => input?.agents ?? Effect.succeed([agentRow]),
    findAssignments: () =>
      input?.assignments ?? Effect.succeed([assignmentRow]),
    findPolicySnapshots: () =>
      input?.snapshots ?? Effect.succeed([snapshotRow]),
  });
}

function accessStores(database = databaseLayer()) {
  return Layer.merge(
    AgentOSWorkloadIdentityStorePostgresLayer,
    ProviderPolicySnapshotStorePostgresLayer,
  ).pipe(Layer.provide(database));
}

function sqlClientLayer(
  execute: (
    statement: string,
    parameters: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError>,
) {
  const connection: SqlConnection.Connection = {
    execute: (statement, parameters, transformRows) =>
      execute(statement, parameters).pipe(
        Effect.map((rows) =>
          transformRows === undefined ? rows : transformRows(rows)
        ),
      ),
    executeRaw: execute,
    executeStream: (statement, parameters, transformRows) =>
      Stream.fromEffect(execute(statement, parameters)).pipe(
        Stream.flatMap((rows) =>
          Stream.fromIterable(
            transformRows === undefined ? rows : transformRows(rows),
          )
        ),
      ),
    executeValues: (statement, parameters) =>
      execute(statement, parameters).pipe(
        Effect.map((rows) => rows.map((row) => Object.values(row))),
      ),
    executeValuesUnprepared: (statement, parameters) =>
      execute(statement, parameters).pipe(
        Effect.map((rows) => rows.map((row) => Object.values(row))),
      ),
    executeUnprepared: (statement, parameters, transformRows) =>
      execute(statement, parameters).pipe(
        Effect.map((rows) =>
          transformRows === undefined ? rows : transformRows(rows)
        ),
      ),
  };
  return Layer.effect(
    SqlClient.SqlClient,
    SqlClient.make({
      acquirer: Effect.succeed(connection),
      compiler: PgClient.makeCompiler(),
      spanAttributes: [],
    }),
  ).pipe(Layer.provide(Reactivity.layer));
}

describe("PostgreSQL provider identity and policy stores", () => {
  it.effect("decodes exact workload, Assignment, and immutable policy snapshots", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const identityStore = yield* AgentOSWorkloadIdentityStore;
      const policyStore = yield* ProviderPolicySnapshotStore;

      assert.deepStrictEqual(
        yield* identityStore.findAgentsByWorkload({
          kubernetesNamespace: "crew-platform",
          kubernetesPod: "crew-pod",
        }),
        [agentRow],
      );
      assert.deepStrictEqual(
        yield* identityStore.findAssignmentsByAgent(AgentId),
        [assignmentRow],
      );
      assert.deepStrictEqual(yield* policyStore.findBySubject(subject), {
        schemaVersion: 1,
        binding: {
          bindingId: BindingId,
          subject,
          createdAtMillis: Now - 3_600_000,
          expiresAtMillis: Now + 3_600_000,
        },
        profile: {
          profileId: "github-maintainer",
          profileVersion: 1,
          previousProfileVersion: null,
          targetScope: scope,
          permissions: [permission],
          issuedUnderCeiling: { ceilingId: CeilingId, revision: 1 },
        },
        ceiling: {
          ceilingId: CeilingId,
          revision: 1,
          scope,
          effectiveAtMillis: Now - 3_600_000,
          permissions: [permission],
        },
      });
    }).pipe(Effect.provide(accessStores())));

  it.effect("returns attributable content-free database and schema failures", () =>
    Effect.gen(function*() {
      const databaseFailure = ProviderAccessDatabaseUnavailable.make({
        operation: "find_workload_agents",
      });
      const failedAgent = yield* Effect.flip(
        Effect.gen(function*() {
          const store = yield* AgentOSWorkloadIdentityStore;
          return yield* store.findAgentsByWorkload({
            kubernetesNamespace: "crew-platform",
            kubernetesPod: "crew-pod",
          });
        }).pipe(Effect.provide(accessStores(databaseLayer({
          agents: Effect.fail(databaseFailure),
        })))),
      );
      assert.instanceOf(failedAgent, WorkloadIdentityDependencyUnavailable);
      assert.deepStrictEqual({
        dependency: failedAgent.dependency,
        operation: failedAgent.operation,
        code: failedAgent.code,
      }, {
        dependency: "identity_store",
        operation: "find_agent",
        code: "database_unavailable",
      });
      assert.notInclude(JSON.stringify(failedAgent), "postgres");

      const invalidSnapshot = yield* Effect.flip(
        Effect.gen(function*() {
          const store = yield* ProviderPolicySnapshotStore;
          return yield* store.findBySubject(subject);
        }).pipe(Effect.provide(accessStores(databaseLayer({
          snapshots: Effect.succeed([{ ...snapshotRow, profilePermissions: [] }]),
        })))),
      );
      assert.instanceOf(invalidSnapshot, ProviderPolicySnapshotUnavailable);
      assert.strictEqual(invalidSnapshot.code, "invalid_response");
    }));

  it.effect("fails closed for every non-authoritative snapshot state", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Now);
      const cases: ReadonlyArray<readonly [
        string,
        ReadonlyArray<unknown>,
        ProviderPolicySnapshotUnavailable["code"],
      ]> = [
        ["missing", [], "binding_not_found"],
        ["ambiguous", [snapshotRow, snapshotRow], "binding_ambiguous"],
        ["pending binding", [{ ...snapshotRow, bindingState: "pending" }], "binding_pending"],
        ["expired binding", [{ ...snapshotRow, bindingExpiresAtMillis: Now }], "binding_expired"],
        ["future binding", [{
          ...snapshotRow,
          bindingCreatedAtMillis: Now + 1,
        }], "binding_not_effective"],
        ["wrong subject", [{
          ...snapshotRow,
          bindingSubject: { ...subject, agentId: "52000000-0000-4000-8000-000000000004" },
        }], "subject_mismatch"],
        ["stale profile", [{ ...snapshotRow, profileHeadVersion: 2 }], "profile_stale"],
        ["missing profile head", [{ ...snapshotRow, profileHeadVersion: null }], "profile_stale"],
        ["reference mismatch", [{
          ...snapshotRow,
          profileCeilingRevision: 2,
        }], "reference_mismatch"],
        ["scope mismatch", [{
          ...snapshotRow,
          profileTargetScope: {
            kind: "domain",
            fleet: "agentos",
            domain: "another-domain",
          },
        }], "reference_mismatch"],
        ["pending ceiling", [{
          ...snapshotRow,
          pendingCeilingRevision: 2,
        }], "ceiling_reconciliation_pending"],
        ["inactive ceiling", [{
          ...snapshotRow,
          ceilingState: "superseded",
        }], "ceiling_inactive"],
        ["future ceiling", [{
          ...snapshotRow,
          ceilingEffectiveAtMillis: Now + 1,
        }], "ceiling_not_effective"],
        ["operation in progress", [{
          ...snapshotRow,
          operationInProgress: true,
        }], "operation_unreconciled"],
      ];

      for (const [, rows, expectedCode] of cases) {
        const snapshotFailure: ProviderPolicySnapshotUnavailable =
          yield* Effect.flip(
          Effect.gen(function*() {
            const store = yield* ProviderPolicySnapshotStore;
            return yield* store.findBySubject(subject);
          }).pipe(Effect.provide(accessStores(databaseLayer({
            snapshots: Effect.succeed(rows),
          })))),
        );
        assert.instanceOf(
          snapshotFailure,
          ProviderPolicySnapshotUnavailable,
        );
        assert.strictEqual(snapshotFailure.code, expectedCode);
      }
    }));

  it.effect("preserves interruption while a database query is blocked", () =>
    Effect.gen(function*() {
      const blocked = Effect.gen(function*() {
        const store = yield* ProviderPolicySnapshotStore;
        return yield* store.findBySubject(subject);
      }).pipe(Effect.provide(accessStores(databaseLayer({
        snapshots: Effect.never,
      }))));
      const fiber = yield* Effect.forkChild(blocked);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(
        Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason),
      );
    }));

  it.effect("recovers after pool starvation or a database restart", () =>
    Effect.gen(function*() {
      const mode = yield* Ref.make<"blocked" | "failed" | "ready">("blocked");
      const protectedDetail = "postgresql://authorizer:protected@database";
      const sqlLayer = sqlClientLayer(() =>
        Ref.get(mode).pipe(
          Effect.flatMap((state) => {
            if (state === "blocked") return Effect.never;
            if (state === "failed") {
              return Effect.fail(SqlError.make({
                reason: ConnectionError.make({
                  cause: new Error(protectedDetail),
                  message: protectedDetail,
                  operation: "connect",
                }),
              }));
            }
            return Effect.succeed([agentRow]);
          }),
        )
      );
      const liveDatabase = ProviderAccessDatabaseSqlLayer.pipe(
        Layer.provide(sqlLayer),
      );
      const blocked = Effect.gen(function*() {
        const database = yield* ProviderAccessDatabase;
        return yield* database.findWorkloadAgents({
          kubernetesNamespace: "crew-platform",
          kubernetesPod: "crew-pod",
        });
      }).pipe(Effect.provide(liveDatabase));
      const fiber = yield* Effect.forkChild(blocked);
      yield* Fiber.interrupt(fiber);
      const blockedExit = yield* Fiber.await(fiber);
      assert.isTrue(
        Exit.isFailure(blockedExit) &&
          blockedExit.cause.reasons.some(Cause.isInterruptReason),
      );

      yield* Ref.set(mode, "failed");
      const databaseFailure = yield* Effect.flip(blocked);
      assert.instanceOf(
        databaseFailure,
        ProviderAccessDatabaseUnavailable,
      );
      assert.strictEqual(
        databaseFailure.operation,
        "find_workload_agents",
      );
      assert.notInclude(JSON.stringify(databaseFailure), protectedDetail);

      yield* Ref.set(mode, "ready");
      assert.deepStrictEqual(yield* blocked, [agentRow]);
    }));
});
