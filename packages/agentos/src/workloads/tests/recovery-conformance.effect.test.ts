import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import { Effect, Layer, Path } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "../../../../../database/tests/pglite-test.ts";
import {
  projectAgentWorkloadPlan,
  projectRuntimeJournalObservation,
} from "../../telemetry/resilience-projections.ts";
import {
  resilienceMetricAttributes,
  resilienceProtectedAttributes,
} from "../../telemetry/resilience-contract.ts";
import { renderCompiledWorkloadSpec } from "./conformance-support.ts";

const packageRootUrl = new URL("../../../", import.meta.url);
const ids = {
  assignment: "58000000-0000-4000-8000-000000000001",
  crew: "28000000-0000-4000-8000-000000000003",
  operation: "78000000-0000-4000-8000-000000000001",
  project: "38000000-0000-4000-8000-000000000001",
  secondMate: "28000000-0000-4000-8000-000000000002",
  task: "48000000-0000-4000-8000-000000000001",
};
const imageDigest = "a".repeat(64);
const briefDigest = "b".repeat(64);

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
      CREATE ROLE workload_recovery_second LOGIN;
      CREATE ROLE workload_recovery_crew LOGIN;

      INSERT INTO agentos.projects (
        id, name, scope_text, status, status_text
      ) VALUES (
        '${ids.project}', 'workload-recovery-conformance',
        'Join a typed workload plan to repair-forward custody',
        'active', 'Workload recovery fixture ready'
      );
      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status,
        status_text, persistent_volume_claim
      ) VALUES
        (
          '${ids.secondMate}', 'workload-recovery-second', 'second_mate',
          '${firstMateId}', 'pi', 'active', 'Second Mate owns recovery', NULL
        ),
        (
          '${ids.crew}', 'workload-recovery-crew', 'crewmate',
          '${ids.secondMate}', 'codex', 'active', 'Crewmate is recoverable',
          'home-agentos-recovery-crew-0'
        );
      SELECT agentos.register_agent_principal(
        '${ids.secondMate}', 'workload_recovery_second'
      );
      SELECT agentos.register_agent_principal(
        '${ids.crew}', 'workload_recovery_crew'
      );
      INSERT INTO agentos.tasks (
        id, project_id, created_by_agent_id, title, status, status_text
      ) VALUES (
        '${ids.task}', '${ids.project}', '${ids.secondMate}',
        'Recover the reviewed workload plan', 'active',
        'Crewmate owns the held-out recovery task'
      );
      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, brief
      ) VALUES (
        '${ids.assignment}', '${ids.task}', '${ids.crew}',
        '${ids.secondMate}', 'worker', 'assigned',
        'Crewmate must preserve exact typed intent',
        '# Recover the reviewed workload plan'
      );
    `);
  }),
});

const platform = Layer.merge(databaseLayer, BunServices.layer);

function workloadSpec(
  distributionRoot: string,
  overlayRoot: string,
  fleet = "default",
) {
  return {
    version: 1,
    distributionRoot,
    overlayRoot,
    profile: { name: "interactive-crewmate", version: 1 },
    fleet,
    namespace: "agentos-domain-recovery",
    identity: {
      agentId: ids.crew,
      ownerAgentId: ids.secondMate,
      taskId: ids.task,
      assignmentId: ids.assignment,
      role: "crewmate",
      agentName: "recovery-crew",
    },
    names: {
      workload: "agentos-recovery-crew",
      service: "agentos-recovery-crew",
      serviceAccount: "agentos-recovery-crew",
      herdrSession: "agentos-recovery-crew",
    },
    ownerServiceAccount: {
      name: "agentos-recovery-second",
      namespace: "agentos-domain-recovery",
    },
    image: {
      reference: `ghcr.io/akua-dev/agentos@sha256:${imageDigest}`,
      pullPolicy: "IfNotPresent",
    },
    harness: "codex",
    home: {
      accessMode: "ReadWriteOnce",
      retention: "Retain",
      size: "20Gi",
      storageClassName: "portable-csi",
    },
    resources: {
      agent: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "2", memory: "4Gi" },
      },
      init: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "2", memory: "2Gi" },
      },
    },
    scheduling: { nodeSelector: {}, tolerations: [] },
    database: {
      identity: "runtime_recovery_crew",
      url:
        "postgresql://runtime_recovery_crew@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos?sslmode=require",
      secret: {
        key: "pgpass",
        name: "agentos-recovery-crew-postgres",
      },
    },
    providerAccessProfiles: ["openai-responses@v1"],
    brief: { path: "/home/agent/brief.md", sha256: briefDigest },
    readiness: { contract: "semantic-v1" },
    protocols: { a2a: "v1", acp: "v1" },
  };
}

const renderPlan = Effect.fn("test.workloadRecovery.renderPlan")(
  function*(fleet = "default") {
    const paths = yield* Path.Path;
    const distributionRoot = paths.resolve(
      yield* paths.fromFileUrl(packageRootUrl),
    );
    return yield* renderCompiledWorkloadSpec({
      withOverlayRoot: (overlayRoot) =>
        workloadSpec(distributionRoot, overlayRoot, fleet),
    });
  },
);

const durableIdentityCounts = Effect.fn(
  "test.workloadRecovery.durableIdentityCounts",
)(function*() {
  const database = yield* PGliteTestDatabase;
  return yield* database.query<{
    readonly agents: number;
    readonly assignments: number;
    readonly tasks: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM agentos.agents) AS agents,
      (SELECT count(*)::int FROM agentos.task_assignments) AS assignments,
      (SELECT count(*)::int FROM agentos.tasks) AS tasks
  `).pipe(Effect.flatMap((rows) => firstRow(rows, "missing identity counts")));
});

layer(platform)("workload plan repair-forward conformance", (it) => {
  it.effect("joins exact compiler, render, SQL journal, and protected trace provenance", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const reviewed = yield* renderPlan();
      const heldOut = yield* renderPlan("held-out-fleet");
      assert.notStrictEqual(
        reviewed.plan.specDigest,
        heldOut.plan.specDigest,
      );
      assert.strictEqual(
        reviewed.plan.overlayDigest,
        heldOut.plan.overlayDigest,
      );
      assert.strictEqual(reviewed.renderDigest, heldOut.renderDigest);
      assert.deepStrictEqual(
        reviewed.resourceIdentities,
        heldOut.resourceIdentities,
      );

      const countsBefore = yield* durableIdentityCounts();
      const retained = JSON.stringify([{
        disposition: "retain",
        kind: "persistent_volume_claim",
        name: reviewed.plan.summary.homeClaim,
      }]);

      yield* asLogin("workload_recovery_second", Effect.gen(function*() {
        const begin = () => database.query<{ readonly id: string }>(`
          SELECT agentos.begin_workload_runtime_operation(
            '${ids.operation}', '${ids.crew}', '${ids.assignment}',
            '${reviewed.plan.summary.namespace}',
            '${reviewed.plan.summary.workload}', 'recover',
            ${reviewed.plan.summary.specVersion},
            '${reviewed.plan.specDigest}', '${reviewed.plan.overlayDigest}',
            '${reviewed.renderDigest}', '${retained}'::jsonb
          )::text AS id
        `);
        assert.deepStrictEqual(yield* begin(), [{ id: ids.operation }]);
        assert.deepStrictEqual(yield* begin(), [{ id: ids.operation }]);

        const heldOutConflict = yield* Effect.flip(database.query(`
          SELECT agentos.begin_workload_runtime_operation(
            '${ids.operation}', '${ids.crew}', '${ids.assignment}',
            '${heldOut.plan.summary.namespace}',
            '${heldOut.plan.summary.workload}', 'recover',
            ${heldOut.plan.summary.specVersion},
            '${heldOut.plan.specDigest}', '${heldOut.plan.overlayDigest}',
            '${heldOut.renderDigest}', '${retained}'::jsonb
          )
        `));
        assert.include(
          heldOutConflict.detail,
          "conflicts with the existing workload runtime operation",
        );

        const transitions: ReadonlyArray<readonly [string, string | null]> = [
          ["recovery_required", "render_interrupted"],
          ["prepared", null],
          ["applied", null],
          ["recovery_required", "apply_interrupted"],
          ["applied", null],
          ["recovery_required", "rollout_failed"],
          ["applied", null],
          ["workload_ready", null],
          ["recovery_required", "herdr_launch_failed"],
          ["workload_ready", null],
          ["harness_ready", null],
          ["recovery_required", "locator_update_failed"],
          ["harness_ready", null],
        ];
        yield* Effect.forEach(transitions, ([phase, decision]) =>
          database.query(`
            SELECT agentos.observe_runtime_operation(
              '${ids.operation}', '${phase}',
              ${decision === null ? "NULL" : `'${decision}'`}
            )
          `), { discard: true });
        yield* database.query(`
          SELECT agentos.complete_runtime_operation('${ids.operation}')
        `);
      }));

      assert.deepStrictEqual(yield* durableIdentityCounts(), countsBefore);
      const provenance = yield* database.query<{
        readonly render_digest: string;
        readonly workload_overlay_digest: string;
        readonly workload_spec_digest: string;
        readonly workload_spec_version: number;
      }>(`
        SELECT workload_spec_version, workload_spec_digest,
               workload_overlay_digest, render_digest
          FROM agentos.runtime_operations
         WHERE id = '${ids.operation}'
      `);
      assert.deepStrictEqual(provenance, [{
        render_digest: reviewed.renderDigest,
        workload_overlay_digest: reviewed.plan.overlayDigest,
        workload_spec_digest: reviewed.plan.specDigest,
        workload_spec_version: 1,
      }]);

      const [planObservation, journalObservation] = yield* Effect.all([
        projectAgentWorkloadPlan({
          action: "recover",
          operationId: ids.operation,
          summary: reviewed.plan.summary,
        }),
        projectRuntimeJournalObservation({
          version: 1,
          action: "recover",
          phase: "recovery_required",
          attempt: 2,
          cause: "reconciliation",
          recovery: "repair_forward",
          agentId: ids.crew,
          assignmentId: ids.assignment,
          operationId: ids.operation,
          renderedManifestDigest: reviewed.renderDigest,
          podUid: null,
          pvcUid: null,
          sessionId: "codex:workload-recovery",
        }),
      ]);
      assert.strictEqual(
        planObservation.protected.operationId,
        journalObservation.protected.operationId,
      );
      assert.deepInclude(resilienceProtectedAttributes(planObservation), {
        "agentos.resilience.operation.id": ids.operation,
        "agentos.resilience.workload.spec_digest": reviewed.plan.specDigest,
        "agentos.resilience.workload.overlay_digest":
          reviewed.plan.overlayDigest,
      });
      assert.deepInclude(resilienceProtectedAttributes(journalObservation), {
        "agentos.resilience.operation.id": ids.operation,
        "agentos.resilience.workload.render_digest": reviewed.renderDigest,
      });
      const metricPayload = JSON.stringify([
        resilienceMetricAttributes(planObservation),
        resilienceMetricAttributes(journalObservation),
      ]);
      for (const digest of [
        reviewed.plan.specDigest,
        reviewed.plan.overlayDigest,
        reviewed.renderDigest,
      ]) assert.notInclude(metricPayload, digest);
    }), 30_000);
});
