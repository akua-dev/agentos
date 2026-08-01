import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { PGlite } from "@electric-sql/pglite";
import { assert, layer } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { fileURLToPath } from "node:url";

const migrationsDirectory = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);
const now = Date.parse("2026-08-01T12:00:00.000Z");
const ids = {
  crewmate: "51000000-0000-4000-8000-000000000003",
  task: "81000000-0000-4000-8000-000000000001",
  assignment: "91000000-0000-4000-8000-000000000001",
  ceiling: "ceiling_0123456789abcdef0123456789abcdef",
  binding: "binding_0123456789abcdef0123456789abcdef",
  assignmentBinding: "binding_2123456789abcdef0123456789abcdef",
  serviceAccount: "71000000-0000-4000-8000-000000000001",
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
const resource = {
  kind: "github_repository",
  owner: "akua-dev",
  repository: "agentos",
};
const permission = {
  capability: "github.issue.write",
  resource,
  environment: "production",
  expiresAtMillis: now + 86_400_000,
  rateClass: "low",
};
const permissions = [permission, { ...permission, environment: null }];

function databaseFailure(operation: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : "unknown failure";
  return new Error(`${operation}: ${detail}`);
}

class TestDatabase extends Context.Service<TestDatabase, {
  readonly exec: (statement: string) => Effect.Effect<void, Error>;
  readonly query: <Row extends object>(
    statement: string,
  ) => Effect.Effect<ReadonlyArray<Row>, Error>;
}>()("agentos/test/ProviderBudgetDatabase") {}

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
    const exec = Effect.fn("test.providerBudgetDatabase.exec")(
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
    const firstMates = yield* query<{ readonly id: string }>(`
      SELECT id::text AS id FROM agentos.agents WHERE role = 'first_mate'
    `);
    const firstMate = firstMates[0]?.id;
    if (firstMate === undefined) {
      return yield* Effect.fail(new Error("test Fleet has no First Mate"));
    }
    yield* exec(`
      INSERT INTO agentos.agents (
        id, handle, role, parent_agent_id, harness, lifecycle_status,
        status_text
      ) VALUES (
        '${ids.crewmate}', 'budget-crew', 'crewmate', '${firstMate}', 'codex',
        'active', 'Provider budget test Crewmate'
      );
      INSERT INTO agentos.tasks (
        id, created_by_agent_id, title, status, status_text
      ) VALUES (
        '${ids.task}', '${firstMate}', 'Provider budget test', 'active',
        'Exercise durable provider budget enforcement'
      );
      INSERT INTO agentos.task_assignments (
        id, task_id, agent_id, assigned_by_agent_id, assignment_role,
        status, status_text, started_at, brief
      ) VALUES (
        '${ids.assignment}', '${ids.task}', '${ids.crewmate}', '${firstMate}',
        'ship', 'active', 'Provider budget assignment is active',
        transaction_timestamp(), 'Exercise Assignment-scoped counters'
      );
      INSERT INTO agentos.access_ceilings (
        ceiling_id, revision, supersedes_revision, scope, effective_at_millis,
        permissions, document_digest, state
      ) VALUES (
        '${ids.ceiling}', 1, NULL, '${JSON.stringify(scope)}'::jsonb,
        ${now - 60_000}, '${JSON.stringify(permissions)}'::jsonb,
        '${"f".repeat(64)}', 'active'
      );
      INSERT INTO agentos.access_profiles (
        profile_id, profile_version, previous_profile_version, ceiling_id,
        ceiling_revision, target_scope, permissions, published_by_agent_id
      ) VALUES (
        'budget-low', 1, NULL, '${ids.ceiling}', 1,
        '${JSON.stringify(scope)}'::jsonb,
        '${JSON.stringify(permissions)}'::jsonb, '${firstMate}'
      );
      INSERT INTO agentos.access_profile_heads (profile_id, profile_version)
      VALUES ('budget-low', 1);
      INSERT INTO agentos.access_bindings (
        binding_id, profile_id, profile_version, subject, created_at_millis,
        expires_at_millis, ceiling_id, ceiling_revision, state,
        created_by_agent_id
      ) VALUES (
        '${ids.binding}', 'budget-low', 1,
        '${JSON.stringify(subject)}'::jsonb, ${now - 60_000},
        ${now + 86_400_000}, '${ids.ceiling}', 1, 'active', '${firstMate}'
      ), (
        '${ids.assignmentBinding}', 'budget-low', 1,
        '${JSON.stringify(assignmentSubject)}'::jsonb, ${now - 60_000},
        ${now + 86_400_000}, '${ids.ceiling}', 1, 'active', '${firstMate}'
      );
    `);
    return TestDatabase.of({ exec, query });
  }),
).pipe(Layer.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)));

interface ReservationRow {
  readonly outcome: string;
  readonly effectiveRateClass: string;
  readonly retryAtMillis: number | null;
  readonly leaseExpiresAtMillis: number | null;
}

const reserve = Effect.fn("test.providerBudget.reserve")(function*(input: {
  readonly decision: string;
  readonly budgetKey: string;
  readonly bindingId?: string;
  readonly subject?: object;
  readonly environment?: string | null;
  readonly atMillis?: number;
}) {
  const database = yield* TestDatabase;
  const atMillis = input.atMillis ?? now;
  const rows = yield* database.query<ReservationRow>(`
    SELECT * FROM agentos.reserve_provider_budget(
      '${input.decision}', '${input.budgetKey}',
      '${input.bindingId ?? ids.binding}',
      '${JSON.stringify(input.subject ?? subject)}'::jsonb,
      'github', 'github', 'github.issue.write',
      '${JSON.stringify(resource)}'::jsonb,
      ${input.environment === null ? "NULL" : "'production'"}, 'low',
      'corr_22222222222222222222222222222222', ${atMillis}
    )
  `);
  const row = rows[0];
  if (row === undefined) return yield* Effect.fail(new Error("no reservation row"));
  return row;
});

const settle = Effect.fn("test.providerBudget.settle")(function*(input: {
  readonly decision: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly spendMicros?: number;
  readonly atMillis?: number;
}) {
  const database = yield* TestDatabase;
  return yield* database.query<{
    readonly outcome: string;
    readonly forwardOutcome: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly spendMicros: number;
    readonly settledAtMillis: number;
  }>(`
    SELECT * FROM agentos.settle_provider_budget(
      '${input.decision}', '${JSON.stringify(subject)}'::jsonb, 'completed',
      ${input.inputTokens ?? 0}, ${input.outputTokens ?? 0},
      ${input.cachedInputTokens ?? 0}, ${input.spendMicros ?? 0},
      ${input.atMillis ?? now + 1_000}
    )
  `).pipe(Effect.map((rows) => rows[0]!));
});

const settleProvider = Effect.fn("test.providerBudget.settleProvider")(
  function*(input: {
    readonly decision: string;
    readonly provider?: string;
    readonly credentialDomain?: string;
    readonly forwardOutcome?: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly spendMicros?: number;
    readonly atMillis?: number;
  }) {
    const database = yield* TestDatabase;
    return yield* database.query<{
      readonly outcome: string;
      readonly forwardOutcome: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedInputTokens: number;
      readonly spendMicros: number;
      readonly settledAtMillis: number;
    }>(`
      SELECT * FROM agentos.settle_provider_budget_for_provider(
        '${input.decision}', '${input.provider ?? "github"}',
        '${input.credentialDomain ?? "github"}',
        '${input.forwardOutcome ?? "completed"}',
        ${input.inputTokens ?? 0}, ${input.outputTokens ?? 0},
        ${input.cachedInputTokens ?? 0}, ${input.spendMicros ?? 0},
        ${input.atMillis ?? now + 1_000}
      )
    `).pipe(Effect.map((rows) => rows[0]!));
  },
);

layer(databaseLayer)("durable provider budgets", (it) => {
  it.effect("isolates request and concurrency capacity by durable subject", () =>
    Effect.gen(function*() {
      const first = yield* reserve({
        decision: `decision_${"1".repeat(32)}`,
        budgetKey: `budget_${"a".repeat(64)}`,
      });
      const second = yield* reserve({
        decision: `decision_${"2".repeat(32)}`,
        budgetKey: `budget_${"a".repeat(64)}`,
      });
      const concurrent = yield* reserve({
        decision: `decision_${"3".repeat(32)}`,
        budgetKey: `budget_${"a".repeat(64)}`,
      });
      const isolated = yield* reserve({
        decision: `decision_${"4".repeat(32)}`,
        budgetKey: `budget_${"b".repeat(64)}`,
        bindingId: ids.assignmentBinding,
        subject: assignmentSubject,
      });
      assert.deepStrictEqual(
        [first.outcome, second.outcome, concurrent.outcome, isolated.outcome],
        ["reserved", "reserved", "rate_limited", "reserved"],
      );
      yield* settle({ decision: `decision_${"1".repeat(32)}` });
      const released = yield* reserve({
        decision: `decision_${"5".repeat(32)}`,
        budgetKey: `budget_${"a".repeat(64)}`,
      });
      assert.strictEqual(released.outcome, "reserved");
    }));

  it.effect("persists token and spend exhaustion across process lifetimes and deterministic windows", () =>
    Effect.gen(function*() {
      const decision = `decision_${"6".repeat(32)}`;
      const budgetKey = `budget_${"c".repeat(64)}`;
      assert.strictEqual((yield* reserve({ decision, budgetKey })).outcome, "reserved");
      assert.deepStrictEqual(yield* settle({
        decision,
        inputTokens: 80_000,
        outputTokens: 20_000,
        cachedInputTokens: 10_000,
        spendMicros: 1_000_000,
      }), {
        outcome: "settled",
        forwardOutcome: "completed",
        inputTokens: 80_000,
        outputTokens: 20_000,
        cachedInputTokens: 10_000,
        spendMicros: 1_000_000,
        settledAtMillis: now + 1_000,
      });
      const denied = yield* reserve({
        decision: `decision_${"7".repeat(32)}`,
        budgetKey,
        atMillis: now + 2_000,
      });
      assert.deepStrictEqual(
        [denied.outcome, denied.retryAtMillis],
        ["budget_exhausted", now + 3_600_000],
      );
      const reset = yield* reserve({
        decision: `decision_${"8".repeat(32)}`,
        budgetKey,
        atMillis: now + 3_600_000,
      });
      assert.strictEqual(reset.outcome, "reserved");
      const database = yield* TestDatabase;
      const counters = yield* database.query<{ readonly consumed: number }>(`
        SELECT consumed::double precision AS consumed
          FROM agentos.provider_budget_counters
         WHERE budget_key = '${budgetKey}' AND dimension = 'spend'
         ORDER BY window_started_at_millis
      `);
      assert.deepStrictEqual(counters.map(({ consumed }) => consumed), [
        1_000_000,
        0,
      ]);
    }));

  it.effect("settles only the provider and credential domain bound to the reservation", () =>
    Effect.gen(function*() {
      const decision = `decision_${"e".repeat(32)}`;
      yield* reserve({
        decision,
        budgetKey: `budget_${"2".repeat(64)}`,
      });
      const settled = yield* settleProvider({
        decision,
        inputTokens: 40,
        outputTokens: 10,
        cachedInputTokens: 5,
        spendMicros: 700,
      });
      assert.deepStrictEqual(settled, {
        outcome: "settled",
        forwardOutcome: "completed",
        inputTokens: 40,
        outputTokens: 10,
        cachedInputTokens: 5,
        spendMicros: 700,
        settledAtMillis: now + 1_000,
      });

      const wrongProviderDecision = `decision_${"f".repeat(32)}`;
      yield* reserve({
        decision: wrongProviderDecision,
        budgetKey: `budget_${"3".repeat(64)}`,
      });
      const wrongProvider = yield* settleProvider({
        decision: wrongProviderDecision,
        provider: "openai",
      }).pipe(Effect.exit);
      assert.isTrue(wrongProvider._tag === "Failure");

      const wrongDomainDecision = `decision_${"0".repeat(32)}`;
      yield* reserve({
        decision: wrongDomainDecision,
        budgetKey: `budget_${"4".repeat(64)}`,
      });
      const wrongDomain = yield* settleProvider({
        decision: wrongDomainDecision,
        credentialDomain: "openai-responses",
      }).pipe(Effect.exit);
      assert.isTrue(wrongDomain._tag === "Failure");
    }));

  it.effect("makes provider settlement exactly idempotent and rejects conflicting usage", () =>
    Effect.gen(function*() {
      const decision = `decision_${"1".repeat(31)}e`;
      yield* reserve({
        decision,
        budgetKey: `budget_${"5".repeat(64)}`,
      });
      const input = {
        decision,
        forwardOutcome: "provider_rejected",
        inputTokens: 20,
        outputTokens: 3,
        cachedInputTokens: 2,
        spendMicros: 400,
        atMillis: now + 2_000,
      };
      const first = yield* settleProvider(input);
      const retry = yield* settleProvider(input);
      assert.deepStrictEqual(retry, first);
      const conflict = yield* settleProvider({
        ...input,
        outputTokens: input.outputTokens + 1,
      }).pipe(Effect.exit);
      assert.isTrue(conflict._tag === "Failure");
    }));

  it.effect("applies and removes one binding-local zero-rate kill switch", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      const overrideId = `override_${"d".repeat(32)}`;
      const target = { kind: "binding", bindingId: ids.binding };
      const set = yield* database.query<{ readonly state: string }>(`
        SELECT agentos.mutate_provider_budget_override(
          '61000000-0000-4000-8000-000000000031', 'set', '${overrideId}',
          '${JSON.stringify(target)}'::jsonb, 'disabled', NULL,
          'incident_response', 'corr_33333333333333333333333333333333',
          '${"d".repeat(64)}', '${ids.serviceAccount}'
        ) AS state
      `);
      assert.deepStrictEqual(set, [{ state: "active" }]);
      const denied = yield* reserve({
        decision: `decision_${"9".repeat(32)}`,
        budgetKey: `budget_${"d".repeat(64)}`,
      });
      const unrelated = yield* reserve({
        decision: `decision_${"a".repeat(32)}`,
        budgetKey: `budget_${"e".repeat(64)}`,
        bindingId: ids.assignmentBinding,
        subject: assignmentSubject,
      });
      assert.deepStrictEqual(
        [denied.outcome, denied.effectiveRateClass, unrelated.outcome],
        ["rate_class_disabled", "disabled", "reserved"],
      );
      const revoked = yield* database.query<{ readonly state: string }>(`
        SELECT agentos.mutate_provider_budget_override(
          '61000000-0000-4000-8000-000000000032', 'revoke', '${overrideId}',
          '${JSON.stringify(target)}'::jsonb, 'disabled', NULL,
          'operator_request', 'corr_44444444444444444444444444444444',
          '${"e".repeat(64)}', '${ids.serviceAccount}'
        ) AS state
      `);
      assert.deepStrictEqual(revoked, [{ state: "revoked" }]);
      const restored = yield* reserve({
        decision: `decision_${"b".repeat(32)}`,
        budgetKey: `budget_${"d".repeat(64)}`,
        atMillis: now + 1,
      });
      assert.strictEqual(restored.outcome, "reserved");
      const audits = yield* database.query<{
        readonly action: string;
        readonly reasonCode: string;
      }>(`
        SELECT action, reason_code AS "reasonCode"
          FROM agentos.provider_budget_control_audit
         WHERE override_id = '${overrideId}' ORDER BY audit_id
      `);
      assert.deepStrictEqual(audits, [
        { action: "set", reasonCode: "incident_response" },
        { action: "revoke", reasonCode: "operator_request" },
      ]);
    }));

  it.effect("grants the authorizer reserve and provider settlement but not subject settlement", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      yield* database.exec(`
        CREATE ROLE provider_budget_egress LOGIN;
        GRANT USAGE ON SCHEMA agentos TO provider_budget_egress;
        GRANT SELECT ON ALL TABLES IN SCHEMA agentos TO provider_budget_egress;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA agentos
          TO provider_budget_egress;
        SELECT agentos.configure_egress_authorizer_privileges(
          'provider_budget_egress'
        );
      `);
      const privileges = yield* database.query<{
        readonly countersSelect: boolean;
        readonly reserveExecute: boolean;
        readonly providerSettleExecute: boolean;
        readonly subjectSettleExecute: boolean;
        readonly overrideExecute: boolean;
      }>(`
        SELECT
          has_table_privilege(
            'provider_budget_egress',
            'agentos.provider_budget_counters', 'SELECT'
          ) AS "countersSelect",
          has_function_privilege(
            'provider_budget_egress',
            'agentos.reserve_provider_budget(text,text,text,jsonb,text,text,text,jsonb,text,text,text,bigint)',
            'EXECUTE'
          ) AS "reserveExecute",
          has_function_privilege(
            'provider_budget_egress',
            'agentos.settle_provider_budget_for_provider(text,text,text,text,bigint,bigint,bigint,bigint,bigint)',
            'EXECUTE'
          ) AS "providerSettleExecute",
          has_function_privilege(
            'provider_budget_egress',
            'agentos.settle_provider_budget(text,jsonb,text,bigint,bigint,bigint,bigint,bigint)',
            'EXECUTE'
          ) AS "subjectSettleExecute",
          has_function_privilege(
            'provider_budget_egress',
            'agentos.mutate_provider_budget_override(uuid,text,text,jsonb,text,bigint,text,text,text,uuid)',
            'EXECUTE'
          ) AS "overrideExecute"
      `);
      assert.deepStrictEqual(privileges, [{
        countersSelect: false,
        reserveExecute: true,
        providerSettleExecute: true,
        subjectSettleExecute: false,
        overrideExecute: false,
      }]);
    }));

  it.effect("authorizes the explicit null environment as its own route", () =>
    Effect.gen(function*() {
      const result = yield* reserve({
        decision: `decision_${"c".repeat(32)}`,
        budgetKey: `budget_${"f".repeat(64)}`,
        environment: null,
      });
      assert.strictEqual(result.outcome, "reserved");
    }));

  it.effect("returns identical deterministic windows for an exact retry", () =>
    Effect.gen(function*() {
      const request = {
        decision: `decision_${"d".repeat(32)}`,
        budgetKey: `budget_${"1".repeat(64)}`,
        atMillis: now + 1_000,
      };
      const first = yield* reserve(request);
      const retry = yield* reserve(request);
      assert.deepStrictEqual(retry, first);
    }));
});
