import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { PGlite } from "@electric-sql/pglite";
import { assert, layer } from "@effect/vitest";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
} from "effect";
import { fileURLToPath } from "node:url";

import { compileSecondMateTopologyPlan } from "../../packages/agentos/src/topology/second-mate.ts";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

const ids = {
  platformMate: "52000000-0000-4000-8000-000000000001",
  deliveryMate: "52000000-0000-4000-8000-000000000002",
  deliveryCrew: "52000000-0000-4000-8000-000000000003",
  task: "82000000-0000-4000-8000-000000000001",
  assignment: "92000000-0000-4000-8000-000000000001",
  proposal: "32000000-0000-4000-8000-000000000001",
};

const platformCharter = {
  version: 1,
  summary: "Own platform reliability outcomes",
  scope: "Coordinate runtime and operational reliability across products.",
  projectAccess: "non_exclusive",
  crossDomainRouting: "common_ancestor",
};

const expandedPlatformCharter = {
  ...platformCharter,
  summary: "Own platform and delivery reliability outcomes",
  scope:
    "Coordinate runtime, delivery systems, and operational reliability across products.",
};

const deliveryCharter = {
  ...platformCharter,
  summary: "Own delivery-system outcomes",
  scope: "Coordinate build and release reliability across products.",
};

export class TopologyTestDatabaseError extends Schema.TaggedErrorClass<TopologyTestDatabaseError>()(
  "TopologyTestDatabaseError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {}

function databaseFailure(operation: string, cause: unknown) {
  return TopologyTestDatabaseError.make({
    operation,
    detail: typeof cause === "string"
      ? cause
      : cause instanceof Error
      ? cause.message
      : "unknown failure",
  });
}

class TestDatabase extends Context.Service<TestDatabase, {
  readonly exec: (
    statement: string,
  ) => Effect.Effect<void, TopologyTestDatabaseError>;
  readonly query: <Row extends object>(
    statement: string,
  ) => Effect.Effect<ReadonlyArray<Row>, TopologyTestDatabaseError>;
}>()("agentos/test/SecondMateTopologyDatabase") {}

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
    const exec = Effect.fn("test.secondMateTopologyDatabase.exec")(
      (statement: string) =>
        Effect.tryPromise({
          try: () => database.exec(statement),
          catch: (cause) => databaseFailure("execute statement", cause),
        }).pipe(Effect.asVoid),
    );
    const query = <Row extends object>(statement: string) =>
      Effect.tryPromise({
        try: () => database.query<Row>(statement),
        catch: (cause) => databaseFailure("query database", cause),
      }).pipe(Effect.map((result) => result.rows));

    const migrationFiles = (yield* fileSystem.readDirectory(
      migrationsDirectory,
    )).filter((entry) => /^\d+_.+\.sql$/.test(entry)).sort();
    for (const migrationFile of migrationFiles) {
      yield* fileSystem.readFileString(
        paths.join(migrationsDirectory, migrationFile),
      ).pipe(Effect.flatMap(exec));
    }
    const firstMateRows = yield* query<{ readonly id: string }>(`
      SELECT id::text AS id FROM agentos.agents WHERE role = 'first_mate'
    `);
    const firstMateId = firstMateRows[0]?.id;
    if (firstMateId === undefined) {
      return yield* databaseFailure(
        "initialize fixtures",
        "test Fleet has no First Mate",
      );
    }

    yield* exec(`
      CREATE ROLE topology_second LOGIN;
      INSERT INTO agentos.agents (
        id, handle, display_name, role, parent_agent_id, harness,
        lifecycle_status, status_text, metadata
      ) VALUES (
        '${ids.platformMate}', 'platform-mate', 'Platform Mate', 'second_mate',
        '${firstMateId}', 'pi', 'active', 'Platform domain active',
        '${sqlJson({ charter: platformCharter })}'::jsonb
      ), (
        '${ids.deliveryMate}', 'delivery-mate', 'Delivery Mate', 'second_mate',
        '${firstMateId}', 'pi', 'active', 'Delivery domain active',
        '${sqlJson({ charter: deliveryCharter })}'::jsonb
      ), (
        '${ids.deliveryCrew}', 'delivery-crew', 'Delivery Crew', 'crewmate',
        '${ids.deliveryMate}', 'codex', 'active', 'Delivery Crew active', '{}'::jsonb
      );
      SELECT agentos.register_agent_principal(
        '${ids.platformMate}', 'topology_second'
      );
      INSERT INTO agentos.tasks (
        id, created_by_agent_id, title, status, status_text
      ) VALUES (
        '${ids.task}', '${firstMateId}', 'Review Second Mate topology',
        'active', 'Topology review accepted'
      );
      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, started_at, brief
      ) VALUES (
        '${ids.assignment}', '${ids.task}', '${ids.deliveryMate}',
        '${firstMateId}', 'ship', 'active', 'Delivery Mate still owns active work',
        transaction_timestamp(), 'Exercise safe topology transitions'
      );
    `);

    return TestDatabase.of({ exec, query });
  }),
).pipe(Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)));

function sqlJson(value: unknown) {
  return JSON.stringify(value).replaceAll("'", "''");
}

function proposal(
  action: string,
  observedAtMillis: number,
  sources: ReadonlyArray<object>,
  destinations: ReadonlyArray<object>,
) {
  return {
    version: 1,
    proposalId: ids.proposal,
    proposedByAgentId: "00000000-0000-4000-8000-000000000000",
    action,
    observedAtMillis,
    validUntilMillis: observedAtMillis + 86_400_000,
    sources,
    destinations,
    reasons: ["persistent_load", "routing_ambiguity"],
    signals: [
      {
        authority: "postgresql",
        kind: "assignment_load",
        observation: "observed",
        trend: "rising",
      },
    ],
    invariants: {
      projectAccess: "non_exclusive",
      crossDomainRouting: "common_ancestor",
      lateralDelivery: "forbidden",
      automaticScheduling: "forbidden",
    },
  };
}

const source = (agentId: string, expectedCharter: object) => ({
  agentId,
  expectedCharter,
});

const destination = (agentId: string, desiredCharter: object) => ({
  kind: "existing",
  agentId,
  desiredCharter,
});

const withFirstMateId = Effect.fn("test.secondMateTopology.withFirstMateId")(
  function*(input: object) {
    const database = yield* TestDatabase;
    const rows = yield* database.query<{ readonly id: string }>(`
      SELECT id::text AS id FROM agentos.agents WHERE role = 'first_mate'
    `);
    const firstMateId = rows[0]?.id;
    if (firstMateId === undefined) {
      return yield* databaseFailure("read First Mate", "missing identity");
    }
    return { ...input, proposedByAgentId: firstMateId };
  },
);

const databaseNow = Effect.fn("test.secondMateTopology.databaseNow")(
  function*() {
    const database = yield* TestDatabase;
    const rows = yield* database.query<{ readonly millis: number }>(`
      SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS millis
    `);
    const millis = rows[0]?.millis;
    if (millis === undefined) {
      return yield* databaseFailure("read database time", "missing value");
    }
    return millis;
  },
);

const approve = Effect.fn("test.secondMateTopology.approve")(function*(
  plan: object,
  key: string,
) {
  const database = yield* TestDatabase;
  const decisions = yield* database.query<{ readonly id: string }>(`
    SELECT agentos.hold_second_mate_topology_decision(
      '${ids.task}', '${sqlJson(plan)}'::jsonb, '${key}',
      'Review Second Mate topology', 'Approve bounded topology transition',
      'Awaiting Captain topology approval'
    )::text AS id
  `);
  const decisionId = decisions[0]?.id;
  if (decisionId === undefined) {
    return yield* databaseFailure("hold topology decision", "missing id");
  }
  yield* database.query<{ readonly id: string }>(`
    SELECT agentos.resolve_second_mate_topology_decision(
      '${decisionId}', true, 'Approved', 'Captain approved topology transition'
    )::text AS id
  `);
  return decisionId;
});

const asRole = Effect.fn("test.secondMateTopology.asRole")(function*<A, E, R>(
  role: string,
  operation: Effect.Effect<A, E, R>,
) {
  const database = yield* TestDatabase;
  return yield* Effect.acquireUseRelease(
    database.exec(`SET SESSION AUTHORIZATION ${role}`),
    () => operation,
    () => database.exec("SET SESSION AUTHORIZATION postgres").pipe(Effect.ignore),
  );
});

const testLayer = Layer.merge(databaseLayer, BunCrypto.layer);

layer(testLayer)("durable Second Mate topology", (it) => {
  it.effect("applies approved charter changes exactly once and rejects non-First-Mates", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      const now = yield* databaseNow();
      const input = yield* withFirstMateId(
        proposal(
          "modify",
          now,
          [source(ids.platformMate, platformCharter)],
          [destination(ids.platformMate, expandedPlatformCharter)],
        ),
      );
      const plan = yield* compileSecondMateTopologyPlan(input);

      const denied = yield* asRole(
        "topology_second",
        database.query(`
          SELECT agentos.hold_second_mate_topology_decision(
            '${ids.task}', '${sqlJson(plan)}'::jsonb, 'topology.denied',
            'Denied', 'Denied', 'Denied'
          )
        `),
      ).pipe(Effect.flip);
      assert.match(denied.detail, /permission denied|owning First Mate/);

      const decisionId = yield* approve(plan, "topology.modify.platform");
      const repeatedDecision = yield* database.query<{ readonly id: string }>(`
        SELECT agentos.hold_second_mate_topology_decision(
          '${ids.task}', '${sqlJson(plan)}'::jsonb, 'topology.modify.platform',
          'Review Second Mate topology', 'Approve bounded topology transition',
          'Awaiting Captain topology approval'
        )::text AS id
      `);
      assert.strictEqual(repeatedDecision[0]?.id, decisionId);

      const applied = yield* database.query<{ readonly result: string }>(`
        SELECT agentos.apply_second_mate_topology_decision(
          '${decisionId}', 'Applied approved platform charter change'
        )::text AS result
      `);
      const repeated = yield* database.query<{ readonly result: string }>(`
        SELECT agentos.apply_second_mate_topology_decision(
          '${decisionId}', 'Applied approved platform charter change'
        )::text AS result
      `);
      assert.strictEqual(repeated[0]?.result, applied[0]?.result);

      const rows = yield* database.query<{
        readonly charter: object;
        readonly transitions: number;
      }>(`
        SELECT metadata -> 'charter' AS charter,
               (SELECT count(*)::int FROM agentos.second_mate_topology_transitions)
                 AS transitions
          FROM agentos.agents
         WHERE id = '${ids.platformMate}'
      `);
      assert.deepStrictEqual(rows[0], {
        charter: expandedPlatformCharter,
        transitions: 1,
      });
    }),
  );

  it.effect("blocks stale and unsafe merge plans before retiring a domain", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      const now = yield* databaseNow();
      const staleInput = yield* withFirstMateId({
        ...proposal(
          "modify",
          now,
          [source(ids.platformMate, platformCharter)],
          [destination(ids.platformMate, deliveryCharter)],
        ),
        proposalId: "32000000-0000-4000-8000-000000000003",
      });
      const stalePlan = yield* compileSecondMateTopologyPlan(staleInput);
      const staleDecision = yield* approve(stalePlan, "topology.stale.platform");
      const stale = yield* database.query(`
        SELECT agentos.apply_second_mate_topology_decision(
          '${staleDecision}', 'Attempt stale change'
        )
      `).pipe(Effect.flip);
      assert.match(stale.detail, /stale charter/);

      const mergeInput = yield* withFirstMateId({
        ...proposal(
          "merge",
          now,
          [
            source(ids.platformMate, expandedPlatformCharter),
            source(ids.deliveryMate, deliveryCharter),
          ],
          [destination(ids.platformMate, expandedPlatformCharter)],
        ),
        proposalId: "32000000-0000-4000-8000-000000000002",
      });
      const mergePlan = yield* compileSecondMateTopologyPlan(mergeInput);
      const mergeDecision = yield* approve(mergePlan, "topology.merge.delivery");
      const activeAssignment = yield* database.query(`
        SELECT agentos.apply_second_mate_topology_decision(
          '${mergeDecision}', 'Attempt unsafe merge'
        )
      `).pipe(Effect.flip);
      assert.match(activeAssignment.detail, /active Task assignments/);

      yield* database.exec(`
        UPDATE agentos.task_assignments
           SET status = 'completed', status_text = 'Work handed off',
               ended_at = transaction_timestamp(), report = 'Handoff complete'
         WHERE id = '${ids.assignment}';
      `);
      const activeChild = yield* database.query(`
        SELECT agentos.apply_second_mate_topology_decision(
          '${mergeDecision}', 'Attempt merge with active child'
        )
      `).pipe(Effect.flip);
      assert.match(activeChild.detail, /active child Agents/);

      yield* database.exec(`
        UPDATE agentos.agents
           SET parent_agent_id = '${ids.platformMate}',
               status_text = 'Crewmate handed to surviving domain'
         WHERE id = '${ids.deliveryCrew}';
      `);
      yield* database.query(`
        SELECT agentos.apply_second_mate_topology_decision(
          '${mergeDecision}', 'Merged delivery domain into platform domain'
        )
      `);
      const retired = yield* database.query<{
        readonly lifecycleStatus: string;
        readonly retired: boolean;
        readonly transitions: number;
      }>(`
        SELECT lifecycle_status AS "lifecycleStatus", retired_at IS NOT NULL AS retired,
               (SELECT count(*)::int FROM agentos.second_mate_topology_transitions)
                 AS transitions
          FROM agentos.agents WHERE id = '${ids.deliveryMate}'
      `);
      assert.deepStrictEqual(retired[0], {
        lifecycleStatus: "retired",
        retired: true,
        transitions: 2,
      });
    }),
  );

  it.effect("provisions a split domain from the exact approved charter", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      const now = yield* databaseNow();
      const splitInput = yield* withFirstMateId({
        ...proposal(
          "split",
          now,
          [source(ids.platformMate, expandedPlatformCharter)],
          [
            destination(ids.platformMate, platformCharter),
            {
              kind: "new",
              handle: "operations-mate",
              displayName: "Operations Mate",
              desiredCharter: {
                ...platformCharter,
                summary: "Own cross-product operational readiness",
                scope:
                  "Coordinate incident readiness and operational reviews across products.",
              },
            },
          ],
        ),
        proposalId: "32000000-0000-4000-8000-000000000004",
      });
      const splitPlan = yield* compileSecondMateTopologyPlan(splitInput);
      const weakenedPlan = {
        ...splitPlan,
        proposal: {
          ...splitPlan.proposal,
          invariants: {
            ...splitPlan.proposal.invariants,
            projectAccess: "exclusive",
          },
        },
      };
      const validity = yield* database.query<{ readonly valid: boolean }>(`
        SELECT agentos.valid_second_mate_topology_plan(
          '${sqlJson(weakenedPlan)}'::jsonb
        ) AS valid
      `);
      assert.strictEqual(validity[0]?.valid, false);

      const splitDecision = yield* approve(
        splitPlan,
        "topology.split.operations",
      );
      yield* database.query(`
        SELECT agentos.apply_second_mate_topology_decision(
          '${splitDecision}', 'Split operations into a durable broad domain'
        )
      `);
      const rows = yield* database.query<{
        readonly charter: object;
        readonly lifecycleStatus: string;
        readonly originProposalId: string;
        readonly parentAgentId: string;
      }>(`
        SELECT metadata -> 'charter' AS charter,
               lifecycle_status AS "lifecycleStatus",
               metadata #>> '{topology_origin,proposalId}' AS "originProposalId",
               parent_agent_id::text AS "parentAgentId"
          FROM agentos.agents
         WHERE handle = 'operations-mate'
      `);
      const firstMateRows = yield* database.query<{ readonly id: string }>(`
        SELECT id::text AS id FROM agentos.agents WHERE role = 'first_mate'
      `);
      const firstMateId = firstMateRows[0]?.id;
      if (firstMateId === undefined) {
        return yield* databaseFailure(
          "verify split topology",
          "missing First Mate",
        );
      }
      assert.deepStrictEqual(rows[0], {
        charter: {
          ...platformCharter,
          summary: "Own cross-product operational readiness",
          scope:
            "Coordinate incident readiness and operational reviews across products.",
        },
        lifecycleStatus: "provisioning",
        originProposalId: "32000000-0000-4000-8000-000000000004",
        parentAgentId: firstMateId,
      });
    }),
  );
});
