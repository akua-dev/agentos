import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  PGliteTestDatabase,
  asLogin,
  firstRow,
  makePGliteTestLayer,
} from "./pglite-test.ts";

const ids = {
  secondMate: "51000000-0000-4000-8000-000000000002",
  crewmate: "51000000-0000-4000-8000-000000000003",
  operationProfile: "61000000-0000-4000-8000-000000000001",
  operationConflict: "61000000-0000-4000-8000-000000000002",
  operationBinding: "61000000-0000-4000-8000-000000000003",
  operationAssignment: "61000000-0000-4000-8000-000000000004",
  operationRevoke: "61000000-0000-4000-8000-000000000005",
  operationCeiling: "61000000-0000-4000-8000-000000000006",
  binding: "binding_0123456789abcdef0123456789abcdef",
  assignmentBinding: "binding_2123456789abcdef0123456789abcdef",
  serviceAccount: "71000000-0000-4000-8000-000000000001",
  task: "81000000-0000-4000-8000-000000000001",
  assignment: "91000000-0000-4000-8000-000000000001",
};
const ceilingId = "ceiling_0123456789abcdef0123456789abcdef";
const repository = {
  kind: "github_repository",
  owner: "akua-dev",
  repository: "agentos",
};
const permission = {
  capability: "github.issue.write",
  resource: repository,
  environment: "production",
  expiresAtMillis: 1785628800000,
  rateClass: "standard",
};
const scope = { kind: "domain", fleet: "agentos", domain: "platform" };
const subject = {
  kind: "mate",
  fleet: "agentos",
  domain: "platform",
  agentId: ids.crewmate,
};
const mutationUser =
  `mate:fleet%3Aagentos%2Fdomain%3Aplatform%2Fmate%3A${ids.crewmate}`;
const mutationRelation = "allow_github_issue_write";
const mutationObject =
  "authorization_target:fleet%3Aagentos%7Cgithub%3Arepository%3Aakua-dev%2Fagentos%7Cenvironment%3Aproduction";
const mutation = {
  writes: [{
    user: mutationUser,
    relation: mutationRelation,
    object: mutationObject,
    condition: {
      name: "active_window",
      context: {
        effective_at: "2026-08-01T00:00:00.000Z",
        expires_at: "2026-08-02T00:00:00.000Z",
      },
    },
  }],
  deletes: [],
};
const verificationRequest = {
  storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  authorizationModelId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  user: mutationUser,
  relation: mutationRelation,
  object: mutationObject,
  context: { current_time: "2026-08-01T12:00:00.000Z" },
  consistency: "HIGHER_CONSISTENCY",
};
const verifications = [{ request: verificationRequest, expectedAllowed: true }];

const fleetRootId = Effect.fn("test.accessControl.fleetRootId")(function*() {
  const database = yield* PGliteTestDatabase;
  const roots = yield* database.query<{ readonly id: string }>(`
    SELECT id::text AS id FROM agentos.agents WHERE role = 'first_mate'
  `);
  return (yield* firstRow(roots, "test Fleet has no First Mate")).id;
});

const publishProfile = Effect.fn("test.accessControl.publishProfile")(function*(
  input: {
    readonly operationId: string;
    readonly expectedPreviousVersion: number | null;
    readonly requestDigest: string;
    readonly permissions: ReadonlyArray<unknown>;
  },
) {
  const database = yield* PGliteTestDatabase;
  return yield* database.query<{ readonly profile_version: number }>(`
    SELECT agentos.publish_access_profile(
      '${input.operationId}', 'github-maintainer',
      ${input.expectedPreviousVersion ?? "NULL"}, '${ceilingId}', 1,
      '${JSON.stringify(input.permissions)}'::jsonb,
      'least_privilege', 'corr_0123456789abcdef0123456789abcdef',
      '${input.requestDigest}', '${ids.serviceAccount}'
    ) AS profile_version
  `);
});

const beginBindingWith = Effect.fn("test.accessControl.beginBinding")(function*(
  operationId: string,
  bindingId: string,
  tupleMutation: unknown,
  bindingSubject: unknown = subject,
  bindingVerifications: unknown = verifications,
) {
  const database = yield* PGliteTestDatabase;
  return yield* database.query<{ readonly phase: string }>(`
    SELECT agentos.begin_access_binding_operation(
      '${operationId}', 'binding_created', '${bindingId}',
      'github-maintainer', 1, '${JSON.stringify(bindingSubject)}'::jsonb,
      1785542400000, 1785628800000, '${ceilingId}', 1,
      '${JSON.stringify(tupleMutation)}'::jsonb,
      '${JSON.stringify(bindingVerifications)}'::jsonb,
      'assignment_requirement',
      'corr_1123456789abcdef0123456789abcdef',
      '${"e".repeat(64)}', '${ids.serviceAccount}'
    ) AS phase
  `);
});

const beginBinding = () => beginBindingWith(
  ids.operationBinding,
  ids.binding,
  mutation,
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
      CREATE ROLE access_second LOGIN;
      CREATE ROLE access_crew LOGIN;
      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
      ) VALUES
        ('${ids.secondMate}', 'access-second', 'second_mate', '${firstMateId}', 'pi', 'active', 'Access test Second Mate'),
        ('${ids.crewmate}', 'access-crew', 'crewmate', '${ids.secondMate}', 'codex', 'active', 'Access test Crewmate');
      INSERT INTO agentos.tasks (
        id, created_by_agent_id, title, status, status_text
      ) VALUES (
        '${ids.task}', '${firstMateId}', 'Access assignment',
        'active', 'Assignment remains active for access binding'
      );
      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, started_at, brief
      ) VALUES (
        '${ids.assignment}', '${ids.task}', '${ids.crewmate}', '${firstMateId}',
        'ship', 'active', 'Access-bound assignment is active',
        transaction_timestamp(), 'Exercise assignment-bound provider access'
      );
      SELECT agentos.register_agent_principal('${ids.secondMate}', 'access_second');
      SELECT agentos.register_agent_principal('${ids.crewmate}', 'access_crew');
    `);
    yield* database.query(`
      SELECT agentos.record_access_ceiling(
        '${ceilingId}', 1, NULL, '${JSON.stringify(scope)}'::jsonb,
        1785542400000, '${JSON.stringify([permission])}'::jsonb,
        '${"f".repeat(64)}'
      )
    `);
  }),
});

layer(databaseLayer)("SQL-backed access control plane", (it) => {
  it.effect("publishes one immutable profile version idempotently", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const request = {
        operationId: ids.operationProfile,
        expectedPreviousVersion: null,
        requestDigest: "a".repeat(64),
        permissions: [permission],
      };
      assert.deepStrictEqual(yield* publishProfile(request), [
        { profile_version: 1 },
      ]);
      assert.deepStrictEqual(yield* publishProfile(request), [
        { profile_version: 1 },
      ]);
      const durable = yield* database.query<{
        readonly profiles: number;
        readonly operations: number;
        readonly audits: number;
        readonly events: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM agentos.access_profiles) AS profiles,
          (SELECT count(*)::int FROM agentos.access_control_operations) AS operations,
          (SELECT count(*)::int FROM agentos.access_control_audit) AS audits,
          (SELECT count(*)::int FROM agentos.access_control_operation_events) AS events
      `);
      assert.deepStrictEqual(durable, [{ profiles: 1, operations: 1, audits: 1, events: 2 }]);
    }));

  it.effect("detects concurrent edits and conflicting retries", () =>
    Effect.gen(function*() {
      const version = yield* Effect.flip(publishProfile({
        operationId: ids.operationConflict,
        expectedPreviousVersion: null,
        requestDigest: "b".repeat(64),
        permissions: [permission],
      }));
      assert.include(version.detail, "profile version conflict");
      const retry = yield* Effect.flip(publishProfile({
        operationId: ids.operationProfile,
        expectedPreviousVersion: null,
        requestDigest: "c".repeat(64),
        permissions: [permission],
      }));
      assert.include(retry.detail, "conflicts with existing access-control operation");
    }));

  it.effect("rejects widening beyond the Captain ceiling", () =>
    Effect.gen(function*() {
      const denied = [
        [{ ...permission, capability: "github.contents.write" }],
        [{ ...permission, rateClass: "high" }],
        [{ ...permission, expiresAtMillis: null }],
      ];
      yield* Effect.forEach(denied, (permissions, index) =>
        Effect.flip(publishProfile({
          operationId: `61000000-0000-4000-8000-00000000001${index + 3}`,
          expectedPreviousVersion: 1,
          requestDigest: `${index + 3}`.repeat(64),
          permissions,
        })).pipe(Effect.tap((error) => Effect.sync(() => {
          assert.include(error.detail, "permission exceeds current Captain ceiling");
        }))), { discard: true });
    }));

  it.effect("keeps mutation authority with First Mate", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      yield* asLogin("access_second", Effect.gen(function*() {
        const denied = yield* Effect.flip(publishProfile({
          operationId: "61000000-0000-4000-8000-000000000020",
          expectedPreviousVersion: 1,
          requestDigest: "d".repeat(64),
          permissions: [permission],
        }));
        assert.strictEqual(denied.operation, "query");
        assert.deepStrictEqual(
          yield* database.query(`SELECT profile_version FROM agentos.access_profiles`),
          [{ profile_version: 1 }],
        );
      }));
    }));

  it.effect("reconciles a prepared binding exactly once before activation", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      assert.deepStrictEqual(yield* beginBinding(), [{ phase: "prepared" }]);
      assert.deepStrictEqual(yield* database.query(`
        SELECT state FROM agentos.access_bindings WHERE binding_id = '${ids.binding}'
      `), [{ state: "pending" }]);
      const premature = yield* Effect.flip(database.query(`
        SELECT agentos.complete_access_control_operation('${ids.operationBinding}')
      `));
      assert.include(premature.detail, "must be verified before completion");
      assert.deepStrictEqual(yield* database.query(`
        SELECT agentos.advance_access_control_operation(
          '${ids.operationBinding}', 0
        ) AS phase
      `), [{ phase: "verified" }]);
      assert.deepStrictEqual(yield* database.query(`
        SELECT agentos.complete_access_control_operation(
          '${ids.operationBinding}'
        ) AS phase
      `), [{ phase: "completed" }]);
      assert.deepStrictEqual(yield* beginBinding(), [{ phase: "completed" }]);
      const durable = yield* database.query(`
        SELECT binding.state,
               (SELECT count(*)::int FROM agentos.access_control_audit
                 WHERE operation_id = '${ids.operationBinding}') AS audit_count,
               (SELECT count(*)::int FROM agentos.access_control_operation_events
                 WHERE operation_id = '${ids.operationBinding}') AS event_count
          FROM agentos.access_bindings AS binding
         WHERE binding.binding_id = '${ids.binding}'
      `);
      assert.deepStrictEqual(durable, [{ state: "active", audit_count: 1, event_count: 3 }]);
    }));

  it.effect("keeps audit append-only and privacy-bounded", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const records = yield* database.query(`
        SELECT actor_agent_id::text, target_id, previous_version, new_version,
               reason_code, decision, correlation_id
          FROM agentos.access_control_audit
         WHERE operation_id = '${ids.operationProfile}'
      `);
      assert.deepStrictEqual(records, [{
        actor_agent_id: yield* fleetRootId(),
        target_id: "github-maintainer",
        previous_version: null,
        new_version: 1,
        reason_code: "least_privilege",
        decision: "recorded",
        correlation_id: "corr_0123456789abcdef0123456789abcdef",
      }]);
      const deletion = yield* Effect.flip(database.exec(`
        DELETE FROM agentos.access_control_audit
         WHERE operation_id = '${ids.operationProfile}'
      `));
      assert.include(deletion.detail, "access-control audit is append-only");
    }));

  it.effect("keeps a binding active until verified revocation completes", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const revokeMutation = {
        writes: [],
        deletes: [{ user: mutationUser, relation: mutationRelation, object: mutationObject }],
      };
      const revokeChecks = [{ request: verificationRequest, expectedAllowed: false }];
      assert.deepStrictEqual(yield* database.query(`
        SELECT agentos.begin_access_binding_operation(
          '${ids.operationRevoke}', 'binding_revoked', '${ids.binding}',
          'github-maintainer', 1, '${JSON.stringify(subject)}'::jsonb,
          1785542400000, 1785628800000, '${ceilingId}', 1,
          '${JSON.stringify(revokeMutation)}'::jsonb,
          '${JSON.stringify(revokeChecks)}'::jsonb,
          'assignment_ended', 'corr_2123456789abcdef0123456789abcdef',
          '${"9".repeat(64)}', '${ids.serviceAccount}'
        ) AS phase
      `), [{ phase: "prepared" }]);
      assert.deepStrictEqual(yield* database.query(`
        SELECT state FROM agentos.access_bindings WHERE binding_id = '${ids.binding}'
      `), [{ state: "active" }]);
      yield* database.query(`SELECT agentos.advance_access_control_operation('${ids.operationRevoke}', 0)`);
      yield* database.query(`SELECT agentos.complete_access_control_operation('${ids.operationRevoke}')`);
      assert.deepStrictEqual(yield* database.query(`
        SELECT state,
               (SELECT count(*)::int FROM agentos.access_control_audit
                 WHERE operation_id = '${ids.operationRevoke}') AS audits
          FROM agentos.access_bindings WHERE binding_id = '${ids.binding}'
      `), [{ state: "revoked", audits: 1 }]);
    }));

  it.effect("supports an exact active Assignment subject", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const assignmentUser =
        `assignment:fleet%3Aagentos%2Fdomain%3Aplatform%2Fassignment%3A${ids.assignment}`;
      const assignmentSubject = {
        kind: "assignment",
        fleet: "agentos",
        domain: "platform",
        assignmentId: ids.assignment,
      };
      const assignmentMutation = {
        writes: mutation.writes.map((write) => ({ ...write, user: assignmentUser })),
        deletes: [],
      };
      const assignmentVerifications = [{
        request: { ...verificationRequest, user: assignmentUser },
        expectedAllowed: true,
      }];
      assert.deepStrictEqual(yield* beginBindingWith(
        ids.operationAssignment,
        ids.assignmentBinding,
        assignmentMutation,
        assignmentSubject,
        assignmentVerifications,
      ), [{ phase: "prepared" }]);
      yield* database.query(`SELECT agentos.advance_access_control_operation('${ids.operationAssignment}', 0)`);
      yield* database.query(`SELECT agentos.complete_access_control_operation('${ids.operationAssignment}')`);
      assert.deepStrictEqual(yield* database.query(`
        SELECT state FROM agentos.access_bindings
         WHERE binding_id = '${ids.assignmentBinding}'
      `), [{ state: "active" }]);
    }));

  it.effect("activates a ceiling shrink only after every stage is verified", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const readPermission = { ...permission, capability: "github.issue.read" };
      yield* database.query(`
        SELECT agentos.record_access_ceiling(
          '${ceilingId}', 2, 1, '${JSON.stringify(scope)}'::jsonb,
          1785542401000, '${JSON.stringify([readPermission])}'::jsonb,
          '${"8".repeat(64)}'
        )
      `);
      assert.deepStrictEqual(yield* database.query(`
        SELECT revision, state FROM agentos.access_ceilings
         WHERE ceiling_id = '${ceilingId}' ORDER BY revision
      `), [
        { revision: 1, state: "active" },
        { revision: 2, state: "pending" },
      ]);
      const assignmentUser =
        `assignment:fleet%3Aagentos%2Fdomain%3Aplatform%2Fassignment%3A${ids.assignment}`;
      const assignmentSubject = {
        kind: "assignment",
        fleet: "agentos",
        domain: "platform",
        assignmentId: ids.assignment,
      };
      const stages = [{
        mutation: {
          writes: [],
          deletes: [{ user: assignmentUser, relation: mutationRelation, object: mutationObject }],
        },
        verifications: [{
          request: { ...verificationRequest, user: assignmentUser },
          expectedAllowed: false,
        }],
      }];
      const begin = database.query(`
        SELECT agentos.begin_access_ceiling_reconciliation(
          '${ids.operationCeiling}', '${ceilingId}', 2,
          '${JSON.stringify([assignmentSubject])}'::jsonb,
          '${JSON.stringify(stages)}'::jsonb,
          'ceiling_changed', 'corr_3123456789abcdef0123456789abcdef',
          '${"7".repeat(64)}', '${ids.serviceAccount}'
        ) AS phase
      `);
      assert.deepStrictEqual(yield* begin, [{ phase: "prepared" }]);
      const premature = yield* Effect.flip(database.query(`
        SELECT agentos.complete_access_control_operation('${ids.operationCeiling}')
      `));
      assert.include(premature.detail, "must be verified before completion");
      assert.deepStrictEqual(yield* database.query(`
        SELECT agentos.advance_access_control_operation('${ids.operationCeiling}', 0) AS phase
      `), [{ phase: "verified" }]);
      yield* database.query(`
        SELECT agentos.advance_access_control_operation('${ids.operationCeiling}', 0)
      `);
      yield* database.query(`
        SELECT agentos.complete_access_control_operation('${ids.operationCeiling}')
      `);
      assert.deepStrictEqual(yield* begin, [{ phase: "completed" }]);
      assert.deepStrictEqual(yield* database.query(`
        SELECT revision, state,
               (SELECT count(*)::int FROM agentos.access_control_audit
                 WHERE operation_id = '${ids.operationCeiling}') AS audits
          FROM agentos.access_ceilings
         WHERE ceiling_id = '${ceilingId}' ORDER BY revision
      `), [
        { revision: 1, state: "superseded", audits: 1 },
        { revision: 2, state: "active", audits: 1 },
      ]);
    }));

  it.effect("rejects secret-shaped fields and protects operation identity", () =>
    Effect.gen(function*() {
      const database = yield* PGliteTestDatabase;
      const unsafeMutation = {
        writes: mutation.writes.map((write) => ({
          ...write,
          credential: "must-not-enter-journal",
        })),
        deletes: [],
      };
      const unsafe = yield* Effect.flip(beginBindingWith(
        "61000000-0000-4000-8000-000000000030",
        "binding_1123456789abcdef0123456789abcdef",
        unsafeMutation,
      ));
      assert.include(unsafe.detail, "invalid access-binding operation request");
      const identity = yield* Effect.flip(database.exec(`
        UPDATE agentos.access_control_operations
           SET target_id = 'binding_ffffffffffffffffffffffffffffffff'
         WHERE operation_id = '${ids.operationBinding}'
      `));
      assert.include(identity.detail, "access-control operation identity is immutable");
    }));
});
