import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { readdir } from "node:fs/promises";

const database = await PGlite.create();
const migrationsDirectory = new URL("../migrations/", import.meta.url);
const ids = {
  firstMate: "",
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
const mutation = {
  writes: [{
    user: `mate:fleet%3Aagentos%2Fdomain%3Aplatform%2Fmate%3A${ids.crewmate}`,
    relation: "allow_github_issue_write",
    object: "authorization_target:fleet%3Aagentos%7Cgithub%3Arepository%3Aakua-dev%2Fagentos%7Cenvironment%3Aproduction",
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
const verifications = [{
  request: {
    storeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    authorizationModelId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    user: mutation.writes[0]!.user,
    relation: mutation.writes[0]!.relation,
    object: mutation.writes[0]!.object,
    context: { current_time: "2026-08-01T12:00:00.000Z" },
    consistency: "HIGHER_CONSISTENCY",
  },
  expectedAllowed: true,
}];

beforeAll(async () => {
  for (const file of (await readdir(migrationsDirectory))
    .filter((entry) => /^\d+_.+\.sql$/.test(entry))
    .sort()) {
    const migration = await import(new URL(file, migrationsDirectory).href, {
      with: { type: "text" },
    });
    await database.exec(migration.default);
  }
  const root = await database.query<{ id: string }>(`
    SELECT id::text AS id FROM agentos.agents WHERE role = 'first_mate'
  `);
  ids.firstMate = root.rows[0]!.id;
  await database.exec(`
    CREATE ROLE access_second LOGIN;
    CREATE ROLE access_crew LOGIN;
    INSERT INTO agentos.agents (
      id, handle, role, parent_agent_id, harness, lifecycle_status, status_text
    ) VALUES
      (
        '${ids.secondMate}', 'access-second', 'second_mate',
        '${ids.firstMate}', 'pi', 'active', 'Access test Second Mate'
      ),
      (
        '${ids.crewmate}', 'access-crew', 'crewmate',
        '${ids.secondMate}', 'codex', 'active', 'Access test Crewmate'
      );
    INSERT INTO agentos.tasks (
      id, created_by_agent_id, title, status, status_text
    ) VALUES (
      '${ids.task}', '${ids.firstMate}', 'Access assignment',
      'active', 'Assignment remains active for access binding'
    );
    INSERT INTO agentos.task_assignments (
      id, task_id, agent_id, assigned_by_agent_id, assignment_role,
      status, status_text, started_at, brief
    ) VALUES (
      '${ids.assignment}', '${ids.task}', '${ids.crewmate}', '${ids.firstMate}',
      'ship', 'active', 'Access-bound assignment is active',
      transaction_timestamp(), 'Exercise assignment-bound provider access'
    );
    SELECT agentos.register_agent_principal('${ids.secondMate}', 'access_second');
    SELECT agentos.register_agent_principal('${ids.crewmate}', 'access_crew');
  `);
  await recordCeiling();
});

afterAll(async () => {
  await database.close();
});

describe.serial("SQL-backed access control plane", () => {
  test("publishes one immutable profile version idempotently", async () => {
    const first = await publishProfile({
      operationId: ids.operationProfile,
      expectedPreviousVersion: null,
      requestDigest: "a".repeat(64),
      permissions: [permission],
    });
    expect(first.rows).toEqual([{ profile_version: 1 }]);

    const retry = await publishProfile({
      operationId: ids.operationProfile,
      expectedPreviousVersion: null,
      requestDigest: "a".repeat(64),
      permissions: [permission],
    });
    expect(retry.rows).toEqual([{ profile_version: 1 }]);

    const durable = await database.query<{
      profiles: number;
      operations: number;
      audits: number;
      events: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM agentos.access_profiles) AS profiles,
        (SELECT count(*)::int FROM agentos.access_control_operations) AS operations,
        (SELECT count(*)::int FROM agentos.access_control_audit) AS audits,
        (SELECT count(*)::int FROM agentos.access_control_operation_events) AS events
    `);
    expect(durable.rows).toEqual([{
      profiles: 1,
      operations: 1,
      audits: 1,
      events: 2,
    }]);
  });

  test("detects concurrent edits and conflicting retries", async () => {
    await expect(publishProfile({
      operationId: ids.operationConflict,
      expectedPreviousVersion: null,
      requestDigest: "b".repeat(64),
      permissions: [permission],
    })).rejects.toThrow("profile version conflict");

    await expect(publishProfile({
      operationId: ids.operationProfile,
      expectedPreviousVersion: null,
      requestDigest: "c".repeat(64),
      permissions: [permission],
    })).rejects.toThrow("conflicts with existing access-control operation");
  });

  test("rejects capability, rate, and expiry widening beyond the ceiling", async () => {
    const denied = [
      [{ ...permission, capability: "github.contents.write" }],
      [{ ...permission, rateClass: "high" }],
      [{ ...permission, expiresAtMillis: null }],
    ];
    for (const [index, permissions] of denied.entries()) {
      await expect(publishProfile({
        operationId: `61000000-0000-4000-8000-00000000001${index + 3}`,
        expectedPreviousVersion: 1,
        requestDigest: `${index + 3}`.repeat(64),
        permissions,
      })).rejects.toThrow("permission exceeds current Captain ceiling");
    }
  });

  test("keeps mutation authority with First Mate", async () => {
    await asLogin("access_second", async () => {
      await expect(publishProfile({
        operationId: "61000000-0000-4000-8000-000000000020",
        expectedPreviousVersion: 1,
        requestDigest: "d".repeat(64),
        permissions: [permission],
      })).rejects.toThrow();
      const visible = await database.query<{ profile_version: number }>(`
        SELECT profile_version FROM agentos.access_profiles
      `);
      expect(visible.rows).toEqual([{ profile_version: 1 }]);
    });
  });

  test("reconciles a prepared binding exactly once before activation", async () => {
    const prepared = await beginBinding();
    expect(prepared.rows).toEqual([{ phase: "prepared" }]);
    const before = await database.query<{ state: string }>(`
      SELECT state FROM agentos.access_bindings WHERE binding_id = '${ids.binding}'
    `);
    expect(before.rows).toEqual([{ state: "pending" }]);

    await expect(
      database.query(`SELECT agentos.complete_access_control_operation(
        '${ids.operationBinding}'
      )`),
    ).rejects.toThrow("must be verified before completion");

    const verified = await database.query<{ phase: string }>(`
      SELECT agentos.advance_access_control_operation(
        '${ids.operationBinding}', 0
      ) AS phase
    `);
    expect(verified.rows).toEqual([{ phase: "verified" }]);
    const completed = await database.query<{ phase: string }>(`
      SELECT agentos.complete_access_control_operation(
        '${ids.operationBinding}'
      ) AS phase
    `);
    expect(completed.rows).toEqual([{ phase: "completed" }]);

    const retry = await beginBinding();
    expect(retry.rows).toEqual([{ phase: "completed" }]);
    const durable = await database.query<{
      state: string;
      audit_count: number;
      event_count: number;
    }>(`
      SELECT binding.state,
             (SELECT count(*)::int
                FROM agentos.access_control_audit
               WHERE operation_id = '${ids.operationBinding}') AS audit_count,
             (SELECT count(*)::int
                FROM agentos.access_control_operation_events
               WHERE operation_id = '${ids.operationBinding}') AS event_count
        FROM agentos.access_bindings AS binding
       WHERE binding.binding_id = '${ids.binding}'
    `);
    expect(durable.rows).toEqual([{
      state: "active",
      audit_count: 1,
      event_count: 3,
    }]);
  });

  test("keeps audit append-only and privacy-bounded", async () => {
    const records = await database.query<{
      actor_agent_id: string;
      target_id: string;
      previous_version: number | null;
      new_version: number | null;
      reason_code: string;
      decision: string;
      correlation_id: string;
    }>(`
      SELECT actor_agent_id::text, target_id, previous_version, new_version,
             reason_code, decision, correlation_id
        FROM agentos.access_control_audit
       WHERE operation_id = '${ids.operationProfile}'
    `);
    expect(records.rows).toEqual([{
      actor_agent_id: ids.firstMate,
      target_id: "github-maintainer",
      previous_version: null,
      new_version: 1,
      reason_code: "least_privilege",
      decision: "recorded",
      correlation_id: "corr_0123456789abcdef0123456789abcdef",
    }]);
    await expect(database.exec(`
      DELETE FROM agentos.access_control_audit
       WHERE operation_id = '${ids.operationProfile}'
    `)).rejects.toThrow("access-control audit is append-only");
  });

  test("keeps a binding active until strongly verified revocation completes", async () => {
    const revokeMutation = {
      writes: [],
      deletes: mutation.writes.map(({ user, relation, object }) => ({
        user,
        relation,
        object,
      })),
    };
    const revokeChecks = verifications.map(({ request }) => ({
      request,
      expectedAllowed: false,
    }));
    const prepared = await database.query<{ phase: string }>(`
      SELECT agentos.begin_access_binding_operation(
        '${ids.operationRevoke}', 'binding_revoked', '${ids.binding}',
        'github-maintainer', 1, '${JSON.stringify(subject)}'::jsonb,
        1785542400000, 1785628800000, '${ceilingId}', 1,
        '${JSON.stringify(revokeMutation)}'::jsonb,
        '${JSON.stringify(revokeChecks)}'::jsonb,
        'assignment_ended', 'corr_2123456789abcdef0123456789abcdef',
        '${"9".repeat(64)}', '${ids.serviceAccount}'
      ) AS phase
    `);
    expect(prepared.rows).toEqual([{ phase: "prepared" }]);
    const before = await database.query<{ state: string }>(`
      SELECT state FROM agentos.access_bindings WHERE binding_id = '${ids.binding}'
    `);
    expect(before.rows).toEqual([{ state: "active" }]);
    await database.query(`SELECT agentos.advance_access_control_operation(
      '${ids.operationRevoke}', 0
    )`);
    await database.query(`SELECT agentos.complete_access_control_operation(
      '${ids.operationRevoke}'
    )`);
    const after = await database.query<{ state: string; audits: number }>(`
      SELECT state,
             (SELECT count(*)::int FROM agentos.access_control_audit
               WHERE operation_id = '${ids.operationRevoke}') AS audits
        FROM agentos.access_bindings WHERE binding_id = '${ids.binding}'
    `);
    expect(after.rows).toEqual([{ state: "revoked", audits: 1 }]);
  });

  test("supports an exact active Assignment subject", async () => {
    const assignmentSubject = {
      kind: "assignment",
      fleet: "agentos",
      domain: "platform",
      assignmentId: ids.assignment,
    };
    const assignmentMutation = structuredClone(mutation);
    assignmentMutation.writes[0]!.user =
      `assignment:fleet%3Aagentos%2Fdomain%3Aplatform%2Fassignment%3A${ids.assignment}`;
    const assignmentVerifications = structuredClone(verifications);
    assignmentVerifications[0]!.request.user =
      assignmentMutation.writes[0]!.user;
    const prepared = await beginBindingWith(
      ids.operationAssignment,
      ids.assignmentBinding,
      assignmentMutation,
      assignmentSubject,
      assignmentVerifications,
    );
    expect(prepared.rows).toEqual([{ phase: "prepared" }]);
    await database.query(`SELECT agentos.advance_access_control_operation(
      '${ids.operationAssignment}', 0
    )`);
    await database.query(`SELECT agentos.complete_access_control_operation(
      '${ids.operationAssignment}'
    )`);
    const durable = await database.query<{ state: string }>(`
      SELECT state FROM agentos.access_bindings
       WHERE binding_id = '${ids.assignmentBinding}'
    `);
    expect(durable.rows).toEqual([{ state: "active" }]);
  });

  test("activates a ceiling shrink only after every stage is strongly verified", async () => {
    const readPermission = {
      ...permission,
      capability: "github.issue.read",
    };
    await database.query(`
      SELECT agentos.record_access_ceiling(
        '${ceilingId}', 2, 1, '${JSON.stringify(scope)}'::jsonb,
        1785542401000, '${JSON.stringify([readPermission])}'::jsonb,
        '${"8".repeat(64)}'
      )
    `);
    const before = await database.query<{ revision: number; state: string }>(`
      SELECT revision, state FROM agentos.access_ceilings
       WHERE ceiling_id = '${ceilingId}' ORDER BY revision
    `);
    expect(before.rows).toEqual([
      { revision: 1, state: "active" },
      { revision: 2, state: "pending" },
    ]);

    const assignmentSubject = {
      kind: "assignment",
      fleet: "agentos",
      domain: "platform",
      assignmentId: ids.assignment,
    };
    const assignmentUser =
      `assignment:fleet%3Aagentos%2Fdomain%3Aplatform%2Fassignment%3A${ids.assignment}`;
    const ceilingMutation = {
      writes: [],
      deletes: mutation.writes.map(({ relation, object }) => ({
        user: assignmentUser,
        relation,
        object,
      })),
    };
    const ceilingChecks = verifications.map(({ request }) => ({
      request: { ...request, user: assignmentUser },
      expectedAllowed: false,
    }));
    const stages = [{
      mutation: ceilingMutation,
      verifications: ceilingChecks,
    }];
    const begin = () => database.query<{ phase: string }>(`
      SELECT agentos.begin_access_ceiling_reconciliation(
        '${ids.operationCeiling}', '${ceilingId}', 2,
        '${JSON.stringify([assignmentSubject])}'::jsonb,
        '${JSON.stringify(stages)}'::jsonb,
        'ceiling_changed', 'corr_3123456789abcdef0123456789abcdef',
        '${"7".repeat(64)}', '${ids.serviceAccount}'
      ) AS phase
    `);
    expect((await begin()).rows).toEqual([{ phase: "prepared" }]);
    await expect(database.query(`
      SELECT agentos.complete_access_control_operation(
        '${ids.operationCeiling}'
      )
    `)).rejects.toThrow("must be verified before completion");
    const advanced = await database.query<{ phase: string }>(`
      SELECT agentos.advance_access_control_operation(
        '${ids.operationCeiling}', 0
      ) AS phase
    `);
    expect(advanced.rows).toEqual([{ phase: "verified" }]);
    await expect(database.query(`
      SELECT agentos.advance_access_control_operation(
        '${ids.operationCeiling}', 0
      )
    `)).resolves.toBeDefined();
    await database.query(`
      SELECT agentos.complete_access_control_operation(
        '${ids.operationCeiling}'
      )
    `);
    expect((await begin()).rows).toEqual([{ phase: "completed" }]);

    const after = await database.query<{
      revision: number;
      state: string;
      audits: number;
    }>(`
      SELECT revision, state,
             (SELECT count(*)::int FROM agentos.access_control_audit
               WHERE operation_id = '${ids.operationCeiling}') AS audits
        FROM agentos.access_ceilings
       WHERE ceiling_id = '${ceilingId}' ORDER BY revision
    `);
    expect(after.rows).toEqual([
      { revision: 1, state: "superseded", audits: 1 },
      { revision: 2, state: "active", audits: 1 },
    ]);
  });

  test("rejects secret-shaped plan fields and protects operation identity", async () => {
    const unsafeMutation = structuredClone(mutation) as typeof mutation & {
      writes: Array<(typeof mutation.writes)[number] & { credential?: string }>;
    };
    unsafeMutation.writes[0]!.credential = "must-not-enter-journal";
    await expect(beginBindingWith(
      "61000000-0000-4000-8000-000000000030",
      "binding_1123456789abcdef0123456789abcdef",
      unsafeMutation,
    )).rejects.toThrow("invalid access-binding operation request");

    await expect(database.exec(`
      UPDATE agentos.access_control_operations
         SET target_id = 'binding_ffffffffffffffffffffffffffffffff'
       WHERE operation_id = '${ids.operationBinding}'
    `)).rejects.toThrow("access-control operation identity is immutable");
  });
});

async function recordCeiling() {
  return await database.query(`
    SELECT agentos.record_access_ceiling(
      '${ceilingId}', 1, NULL, '${JSON.stringify(scope)}'::jsonb,
      1785542400000, '${JSON.stringify([permission])}'::jsonb,
      '${"f".repeat(64)}'
    )
  `);
}

async function publishProfile(input: {
  operationId: string;
  expectedPreviousVersion: number | null;
  requestDigest: string;
  permissions: Array<Record<string, unknown>> | readonly AccessPermission[];
}) {
  return await database.query<{ profile_version: number }>(`
    SELECT agentos.publish_access_profile(
      '${input.operationId}', 'github-maintainer',
      ${input.expectedPreviousVersion ?? "NULL"}, '${ceilingId}', 1,
      '${JSON.stringify(input.permissions)}'::jsonb,
      'least_privilege', 'corr_0123456789abcdef0123456789abcdef',
      '${input.requestDigest}', '${ids.serviceAccount}'
    ) AS profile_version
  `);
}

async function beginBinding() {
  return await beginBindingWith(
    ids.operationBinding,
    ids.binding,
    mutation,
  );
}

async function beginBindingWith(
  operationId: string,
  bindingId: string,
  tupleMutation: unknown,
  bindingSubject: unknown = subject,
  bindingVerifications: unknown = verifications,
) {
  return await database.query<{ phase: string }>(`
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
}

type AccessPermission = typeof permission;

async function asLogin<T>(role: string, operation: () => Promise<T>) {
  await database.exec(`SET SESSION AUTHORIZATION ${role}`);
  try {
    return await operation();
  } finally {
    await database.exec("SET SESSION AUTHORIZATION postgres");
  }
}
