import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { PGlite } from "@electric-sql/pglite";
import { assert, layer } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Path } from "effect";
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
    yield* database.exec(`
      UPDATE agentos.provider_budget_reservations SET attempted_at_millis = ${input.atMillis ?? now}
       WHERE decision_ref = '${input.decision}'
         AND workload_principal IS NOT NULL AND state = 'active'
    `);
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

const renewProviderAttempt = Effect.fn("test.providerBudget.renewProviderAttempt")(
  function*(decision: string, provider: string, credentialDomain: string, atMillis: number) {
    const database = yield* TestDatabase;
    return yield* database.query<{
      readonly outcome: string;
      readonly leaseExpiresAtMillis: number;
    }>(`
      SELECT * FROM agentos.renew_workload_provider_attempt(
        '${decision}', '${provider}', '${credentialDomain}', ${atMillis}
      )
    `);
  },
);

const workloadPrincipal = {
  kind: "kubernetes_workload",
  namespace: "hermes-workers",
  serviceAccountName: "hermes-codex",
  serviceAccountUid: "11111111-1111-4111-8111-111111111111",
  podName: "hermes-0",
  podUid: "22222222-2222-4222-8222-222222222222",
  policyRevision: 7,
  policyResourceVersion: "18422",
  hermesProfile: "fleet-codex",
};
const workloadLimits = {
  requestWindowMillis: 60_000,
  maximumRequests: 2,
  maximumConcurrent: 1,
  tokenWindowMillis: 60_000,
  maximumTokens: 1_000,
  spendWindowMillis: 3_600_000,
  maximumSpendMicros: 100_000,
};
const workloadPricing = {
  version: 1,
  inputMicrosPerMillionTokens: 1_000_000,
  outputMicrosPerMillionTokens: 1_000_000,
};
const reserveWorkload = Effect.fn("test.providerBudget.reserveWorkload")(
  function*(input: {
    readonly decision: string;
    readonly budgetKey?: string;
    readonly principal?: object;
    readonly limits?: object;
    readonly rateClass?: string;
    readonly requestedTokens?: number;
    readonly requestedSpendMicros?: number;
    readonly atMillis?: number;
  }) {
    const database = yield* TestDatabase;
    const rows = yield* database.query<ReservationRow>(`
      SELECT * FROM agentos.reserve_workload_provider_budget(
        '${input.decision}', '${input.budgetKey ?? `budget_${"9".repeat(64)}`}',
        'corr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '${JSON.stringify(input.principal ?? workloadPrincipal)}'::jsonb,
        'openai', 'openai-responses', 'openai.responses.create',
        '{"kind":"provider_service","provider":"openai","service":"responses"}'::jsonb,
        'production', 'gpt-5.6-sol', '${input.rateClass ?? "low"}',
        '${JSON.stringify(input.limits ?? workloadLimits)}'::jsonb,
        '${JSON.stringify(workloadPricing)}'::jsonb,
        ${(input.atMillis ?? now) + 15_000},
        ${input.requestedTokens ?? 1_000}, ${input.requestedSpendMicros ?? 100_000},
        ${input.atMillis ?? now}
      )
    `);
    return rows[0]!;
  },
);

const claimWorkload = Effect.fn("test.providerBudget.claimWorkload")(
  function*(input: { readonly decision: string; readonly atMillis?: number; readonly requestedTokens?: number; readonly requestedSpendMicros?: number }) {
    const database = yield* TestDatabase;
    const principal = {
      kind: workloadPrincipal.kind,
      namespace: workloadPrincipal.namespace,
      serviceAccountName: workloadPrincipal.serviceAccountName,
      policyRevision: workloadPrincipal.policyRevision,
      policyResourceVersion: workloadPrincipal.policyResourceVersion,
      hermesProfile: workloadPrincipal.hermesProfile,
    };
    return yield* database.query<{ readonly outcome: string }>(`
      SELECT * FROM agentos.validate_workload_provider_budget(
        '${input.decision}', 'corr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '${JSON.stringify(principal)}'::jsonb, 'openai', 'openai-responses',
        'openai.responses.create',
        '{"kind":"provider_service","provider":"openai","service":"responses"}'::jsonb,
        'gpt-5.6-sol', 'low', '${JSON.stringify(workloadLimits)}'::jsonb,
        '${JSON.stringify(workloadPricing)}'::jsonb, ${input.requestedTokens ?? 1000}, ${input.requestedSpendMicros ?? 100000},
        ${(input.atMillis ?? now) + 15_000}, ${input.atMillis ?? now}
      )
    `).pipe(Effect.map((rows) => rows[0]!));
  },
);

layer(databaseLayer)("durable provider budgets", (it) => {
  it.effect("renews only an active attempted reservation bound to the provider domain", () =>
    Effect.gen(function*() {
      const decision = `decision_${"e1".repeat(16)}`;
      yield* reserveWorkload({
        decision,
        budgetKey: `budget_${"e1".repeat(32)}`,
        atMillis: now,
      });
      yield* claimWorkload({ decision, atMillis: now });
      const renewed = yield* renewProviderAttempt(
        decision,
        "openai",
        "openai-responses",
        now + 1_000,
      );
      assert.strictEqual(renewed[0]?.outcome, "renewed");
      assert.strictEqual(renewed[0]?.leaseExpiresAtMillis, now + 61_000);
      const mismatch = yield* Effect.flip(
        renewProviderAttempt(decision, "openai", "other-domain", now + 2_000),
      );
      assert.match(mismatch.message, /attempt lease unavailable/);
    }));

  it.effect("claims one provider attempt and rejects replay while retaining expired attempted liability", () =>
    Effect.gen(function*() {
      const budgetKey = `budget_${"a1".repeat(32)}`;
      const decision = `decision_${"a1".repeat(16)}`;
      assert.strictEqual((yield* reserveWorkload({ decision, budgetKey })).outcome, "reserved");
      assert.strictEqual((yield* claimWorkload({ decision })).outcome, "attempted");
      const replay = yield* Effect.flip(claimWorkload({ decision }));
      assert.match(replay.message, /reservation unavailable/);
      const denied = yield* reserveWorkload({
        decision: `decision_${"a2".repeat(16)}`,
        budgetKey,
        atMillis: now + 15_001,
        requestedTokens: 1,
        requestedSpendMicros: 1,
      });
      assert.strictEqual(denied.outcome, "budget_exhausted");
    }));

  it.effect("charges settlement to the reservation windows across a boundary", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      const budgetKey = `budget_${"b1".repeat(32)}`;
      const oldDecision = `decision_${"b1".repeat(16)}`;
      const newDecision = `decision_${"b2".repeat(16)}`;
      const limits = { ...workloadLimits, maximumConcurrent: 2 };
      yield* reserveWorkload({ decision: oldDecision, budgetKey, limits, atMillis: now + 59_000, requestedTokens: 50, requestedSpendMicros: 50 });
      yield* reserveWorkload({ decision: newDecision, budgetKey, limits, atMillis: now + 61_000, requestedTokens: 50, requestedSpendMicros: 50 });
      yield* settleProvider({ decision: oldDecision, provider: "openai", credentialDomain: "openai-responses", inputTokens: 50, spendMicros: 50, atMillis: now + 62_000 });
      const counters = yield* database.query<{ readonly window: number; readonly consumed: number }>(`
        SELECT window_started_at_millis::double precision AS window,
               consumed::double precision AS consumed
          FROM agentos.provider_budget_counters
         WHERE budget_key = '${budgetKey}' AND dimension = 'token'
         ORDER BY window_started_at_millis
      `);
      assert.deepStrictEqual(counters.map(({ consumed }) => consumed), [50, 0]);
    }));

  it.effect("rejects zero and over-maximum exact reservation quantities", () =>
    Effect.gen(function*() {
      for (const [requestedTokens, requestedSpendMicros] of [[0, 1], [1, 0], [1_001, 1], [1, 100_001]]) {
        const failure = yield* Effect.flip(reserveWorkload({
          decision: `decision_${String(requestedTokens).padStart(16, "0")}${String(requestedSpendMicros).padStart(16, "0")}`,
          budgetKey: `budget_${"c1".repeat(32)}`,
          requestedTokens,
          requestedSpendMicros,
        }));
        assert.match(failure.message, /invalid workload provider budget reservation/);
      }
    }));

  it.effect("reserves only an exact modern workload decision and reclaims expired concurrency", () =>
    Effect.gen(function*() {
      const decision = `decision_${"ab".repeat(16)}`;
      assert.strictEqual((yield* reserveWorkload({ decision })).outcome, "reserved");
      assert.strictEqual((yield* reserveWorkload({ decision })).outcome, "reserved");
      const conflict = yield* Effect.flip(reserveWorkload({
        decision,
        principal: { ...workloadPrincipal, podUid: "different-pod-uid" },
      }));
      assert.match(conflict.message, /decision reference conflicts/);
      assert.strictEqual((yield* reserveWorkload({
        decision: `decision_${"bc".repeat(16)}`,
      })).outcome, "budget_exhausted");
      assert.strictEqual((yield* reserveWorkload({
        decision: `decision_${"cd".repeat(16)}`,
        atMillis: now + 15_001,
      })).outcome, "reserved");
    }));

  it.effect("settles modern usage exactly once and rejects a conflict", () =>
    Effect.gen(function*() {
      const decision = `decision_${"de".repeat(16)}`;
      yield* reserveWorkload({ decision, budgetKey: `budget_${"8".repeat(64)}` });
      const first = yield* settleProvider({
        decision,
        provider: "openai",
        credentialDomain: "openai-responses",
        inputTokens: 80,
        outputTokens: 20,
        cachedInputTokens: 10,
        spendMicros: 100,
      });
      assert.deepStrictEqual(
        [first.outcome, first.inputTokens, first.outputTokens, first.spendMicros],
        ["settled", 80, 20, 100],
      );
      assert.strictEqual((yield* settleProvider({
        decision,
        provider: "openai",
        credentialDomain: "openai-responses",
        inputTokens: 80,
        outputTokens: 20,
        cachedInputTokens: 10,
        spendMicros: 100,
      })).outcome, "settled");
      const conflict = yield* Effect.flip(settleProvider({
        decision,
        provider: "openai",
        credentialDomain: "openai-responses",
        inputTokens: 81,
        outputTokens: 20,
        spendMicros: 101,
      }));
      assert.match(conflict.message, /settlement conflicts/);
    }));

  it.effect("returns the canonical committed settlement when an HTTP retry changes only transport time", () =>
    Effect.gen(function*() {
      const decision = `decision_${"d0".repeat(16)}`;
      yield* reserveWorkload({ decision, budgetKey: `budget_${"d0".repeat(32)}`, requestedTokens: 100, requestedSpendMicros: 100 });
      yield* claimWorkload({ decision, requestedTokens: 100, requestedSpendMicros: 100 });
      const first = yield* settleProvider({
        decision,
        provider: "openai",
        credentialDomain: "openai-responses",
        inputTokens: 50,
        outputTokens: 50,
        spendMicros: 100,
        atMillis: now + 1_000,
      });
      const replay = yield* settleProvider({
        decision,
        provider: "openai",
        credentialDomain: "openai-responses",
        inputTokens: 50,
        outputTokens: 50,
        spendMicros: 100,
        atMillis: now + 2_000,
      });
      assert.deepStrictEqual(replay, first);
    }));

  it.effect("recovers an expired claimed attempt conservatively and releases later-window concurrency", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      const budgetKey = `budget_${"d1".repeat(32)}`;
      const decision = `decision_${"d1".repeat(16)}`;
      yield* reserveWorkload({ decision, budgetKey, requestedTokens: 100, requestedSpendMicros: 100 });
      yield* claimWorkload({ decision, requestedTokens: 100, requestedSpendMicros: 100 });
      const recovered = yield* database.query<{ readonly outcome: string }>(`
        SELECT * FROM agentos.recover_expired_workload_provider_attempts(${now + 1_000_000}, 100)
      `);
      assert.deepStrictEqual(recovered, [{ outcome: "recovered" }]);
      const row = yield* database.query<{ readonly state: string; readonly tokens: number; readonly spend: number }>(`
        SELECT state, (input_tokens + output_tokens)::double precision AS tokens,
               spend_micros::double precision AS spend
          FROM agentos.provider_budget_reservations WHERE decision_ref = '${decision}'
      `);
      assert.deepStrictEqual(row, [{ state: "settled", tokens: 100, spend: 100 }]);
      assert.deepStrictEqual(
        yield* database.query<{ readonly dimension: string; readonly consumed: number }>(`
          SELECT dimension, consumed::double precision AS consumed
            FROM agentos.provider_budget_counters
           WHERE budget_key = '${budgetKey}' AND dimension IN ('token', 'spend')
           ORDER BY dimension
        `),
        [{ dimension: "spend", consumed: 100 }, { dimension: "token", consumed: 100 }],
      );
      assert.deepStrictEqual(
        yield* database.query<{ readonly outcome: string }>(`
          SELECT * FROM agentos.recover_expired_workload_provider_attempts(${now + 1_000_001}, 100)
        `),
        [{ outcome: "unchanged" }],
      );
      const later = yield* reserveWorkload({
        decision: `decision_${"d2".repeat(16)}`,
        budgetKey,
        requestedTokens: 1,
        requestedSpendMicros: 1,
        atMillis: now + 1_000_000,
      });
      assert.strictEqual(later.outcome, "reserved");
    }));

  it.effect("conservatively recovers a legacy attempted row with a null attempt lease", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      const decision = `decision_${"d3".repeat(16)}`;
      yield* reserveWorkload({
        decision,
        budgetKey: `budget_${"d3".repeat(32)}`,
        requestedTokens: 100,
        requestedSpendMicros: 100,
      });
      yield* claimWorkload({ decision, requestedTokens: 100, requestedSpendMicros: 100 });
      yield* database.query(`
        UPDATE agentos.provider_budget_reservations
           SET attempt_lease_expires_at_millis = NULL
         WHERE decision_ref = '${decision}'
      `);
      assert.deepStrictEqual(
        yield* database.query<{ readonly outcome: string }>(`
          SELECT * FROM agentos.recover_expired_workload_provider_attempts(${now + 1_000_000}, 100)
        `),
        [{ outcome: "recovered" }],
      );
      assert.deepStrictEqual(
        yield* database.query<{ readonly state: string; readonly tokens: number; readonly spend: number }>(`
          SELECT state, (input_tokens + output_tokens)::double precision AS tokens,
                 spend_micros::double precision AS spend
            FROM agentos.provider_budget_reservations WHERE decision_ref = '${decision}'
        `),
        [{ state: "settled", tokens: 100, spend: 100 }],
      );
    }));

  it.effect("linearizes concurrent attempt renewal and expiry recovery without double charge", () =>
    Effect.gen(function*() {
      const database = yield* TestDatabase;
      let renewWins = 0;
      let recoveryWins = 0;
      for (let repetition = 0; repetition < 12; repetition += 1) {
        const suffix = `f${repetition.toString(16).padStart(3, "0")}`;
        const decision = `decision_${suffix.repeat(8)}`;
        const budgetKey = `budget_${suffix.repeat(16)}`;
        const expiryAt = now + 899_999;
        const renewAt = expiryAt - 1;
        yield* reserveWorkload({
          decision,
          budgetKey,
          requestedTokens: 100,
          requestedSpendMicros: 100,
        });
        yield* claimWorkload({
          decision,
          requestedTokens: 100,
          requestedSpendMicros: 100,
        });
        yield* database.query(`
          UPDATE agentos.provider_budget_reservations
             SET attempt_lease_expires_at_millis = ${expiryAt}
           WHERE decision_ref = '${decision}'
        `);
        const renew = Effect.exit(renewProviderAttempt(
          decision,
          "openai",
          "openai-responses",
          renewAt,
        ));
        const recover = Effect.exit(database.query<{ readonly outcome: string }>(`
          SELECT * FROM agentos.recover_expired_workload_provider_attempts(${expiryAt}, 100)
        `));
        const [first, second] = yield* Effect.all(
          repetition % 2 === 0 ? [renew, recover] : [recover, renew],
          { concurrency: "unbounded" },
        );
        const [renewResult, recoverResult] = repetition % 2 === 0
          ? [first, second]
          : [second, first];
        const row = (yield* database.query<{
          readonly state: string;
          readonly lease: number | null;
          readonly tokenWindow: number;
          readonly spendWindow: number;
          readonly tokens: number;
          readonly spend: number;
        }>(`
          SELECT state, attempt_lease_expires_at_millis::double precision AS lease,
                 token_window_started_at_millis::double precision AS "tokenWindow",
                 spend_window_started_at_millis::double precision AS "spendWindow",
                 (input_tokens + output_tokens)::double precision AS tokens,
                 spend_micros::double precision AS spend
            FROM agentos.provider_budget_reservations
           WHERE decision_ref = '${decision}'
        `))[0];
        assert.isDefined(row);
        const renewed = Exit.isSuccess(renewResult);
        assert.strictEqual(row?.state, renewed ? "active" : "settled");
        assert.deepStrictEqual(
          { tokens: row?.tokens, spend: row?.spend },
          renewed ? { tokens: null, spend: null } : { tokens: 100, spend: 100 },
        );
        if (renewed) {
          renewWins += 1;
          assert.strictEqual(renewResult.value[0]?.outcome, "renewed");
          assert.strictEqual(row?.lease, now + 900_000);
          assert.isAbove(row?.lease ?? 0, expiryAt);
          assert.isTrue(Exit.isSuccess(recoverResult));
          if (Exit.isSuccess(recoverResult)) {
            assert.strictEqual(recoverResult.value[0]?.outcome, "unchanged");
          }
        } else {
          recoveryWins += 1;
          assert.isTrue(Exit.isSuccess(recoverResult));
          if (Exit.isSuccess(recoverResult)) {
            assert.strictEqual(recoverResult.value[0]?.outcome, "recovered");
          }
          const laterRenew = yield* Effect.exit(renewProviderAttempt(
            decision,
            "openai",
            "openai-responses",
            renewAt,
          ));
          assert.isTrue(Exit.isFailure(laterRenew));
        }
        const counters = yield* database.query<{
          readonly dimension: string;
          readonly consumed: number;
          readonly window: number;
        }>(`
          SELECT dimension, consumed::double precision AS consumed,
                 window_started_at_millis::double precision AS window
            FROM agentos.provider_budget_counters
           WHERE budget_key = '${budgetKey}' AND dimension IN ('token', 'spend')
           ORDER BY dimension
        `);
        assert.deepStrictEqual(
          counters.map(({ dimension, consumed }) => ({ dimension, consumed })),
          renewed
            ? [{ dimension: "spend", consumed: 0 }, { dimension: "token", consumed: 0 }]
            : [{ dimension: "spend", consumed: 100 }, { dimension: "token", consumed: 100 }],
        );
        assert.isTrue(counters.every(({ window, dimension }) =>
          window === (dimension === "token" ? row?.tokenWindow : row?.spendWindow)
        ));
        assert.deepStrictEqual(
          yield* database.query<{ readonly outcome: string }>(`
            SELECT * FROM agentos.recover_expired_workload_provider_attempts(${expiryAt}, 100)
          `),
          [{ outcome: "unchanged" }],
        );
        if (renewed) {
          const blocked = yield* reserveWorkload({
            decision: `decision_${suffix.repeat(7)}eeee`,
            budgetKey,
            requestedTokens: 1,
            requestedSpendMicros: 1,
            atMillis: expiryAt,
          });
          assert.strictEqual(blocked.outcome, "rate_limited");
          assert.deepStrictEqual(
            yield* database.query<{ readonly outcome: string }>(`
              SELECT * FROM agentos.recover_expired_workload_provider_attempts(${now + 900_000}, 100)
            `),
            [{ outcome: "recovered" }],
          );
        }
        const later = yield* reserveWorkload({
          decision: `decision_${suffix.repeat(7)}ffff`,
          budgetKey,
          requestedTokens: 1,
          requestedSpendMicros: 1,
          atMillis: now + 1_000_000,
        });
        assert.strictEqual(later.outcome, "reserved");
      }
      assert.strictEqual(renewWins, 6);
      assert.strictEqual(recoveryWins, 6);
    }));

  it.effect("atomically fits exact concurrent reservations and releases only unused capacity", () =>
    Effect.gen(function*() {
      const budgetKey = `budget_${"7".repeat(64)}`;
      const limits = { ...workloadLimits, maximumRequests: 4, maximumConcurrent: 2, maximumTokens: 100, maximumSpendMicros: 100 };
      const firstDecision = `decision_${"71".repeat(16)}`;
      const secondDecision = `decision_${"72".repeat(16)}`;
      assert.strictEqual((yield* reserveWorkload({ decision: firstDecision, budgetKey, limits, requestedTokens: 60, requestedSpendMicros: 60 })).outcome, "reserved");
      assert.strictEqual((yield* reserveWorkload({ decision: secondDecision, budgetKey, limits, requestedTokens: 40, requestedSpendMicros: 40 })).outcome, "reserved");
      assert.strictEqual((yield* reserveWorkload({ decision: `decision_${"73".repeat(16)}`, budgetKey, limits, requestedTokens: 1, requestedSpendMicros: 1 })).outcome, "budget_exhausted");
      yield* settleProvider({ decision: firstDecision, provider: "openai", credentialDomain: "openai-responses", inputTokens: 10, spendMicros: 10 });
      assert.strictEqual((yield* reserveWorkload({ decision: `decision_${"74".repeat(16)}`, budgetKey, limits, requestedTokens: 50, requestedSpendMicros: 50 })).outcome, "reserved");
      const replay = yield* Effect.flip(reserveWorkload({ decision: firstDecision, budgetKey, limits, requestedTokens: 60, requestedSpendMicros: 60 }));
      assert.match(replay.message, /reservation is not active/);
    }));

  it.effect("rejects settlement larger than the exact token or spend reservation", () =>
    Effect.gen(function*() {
      const budgetKey = `budget_${"6".repeat(64)}`;
      const limits = { ...workloadLimits, maximumTokens: 100, maximumSpendMicros: 100 };
      const decision = `decision_${"61".repeat(16)}`;
      yield* reserveWorkload({ decision, budgetKey, limits, requestedTokens: 100, requestedSpendMicros: 100 });
      const tokenOverage = yield* Effect.flip(settleProvider({ decision, provider: "openai", credentialDomain: "openai-responses", inputTokens: 101, spendMicros: 101 }));
      assert.match(tokenOverage.message, /exceeds reservation/);
      const spendOverage = yield* Effect.flip(settleProvider({ decision, provider: "openai", credentialDomain: "openai-responses", outputTokens: 101, spendMicros: 101 }));
      assert.match(spendOverage.message, /exceeds reservation/);
    }));

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
        CREATE ROLE provider_budget_unprivileged LOGIN;
        GRANT USAGE ON SCHEMA agentos TO provider_budget_egress;
        GRANT USAGE ON SCHEMA agentos TO provider_budget_unprivileged;
        GRANT SELECT ON ALL TABLES IN SCHEMA agentos TO provider_budget_egress;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA agentos
          TO provider_budget_egress;
        SELECT agentos.configure_egress_authorizer_privileges(
          'provider_budget_egress'
        );
      `);
      const privileges = yield* database.query<{
        readonly unprivilegedReserveExecute: boolean;
        readonly unprivilegedProviderSettleExecute: boolean;
        readonly countersSelect: boolean;
        readonly reserveExecute: boolean;
        readonly providerSettleExecute: boolean;
        readonly subjectSettleExecute: boolean;
        readonly overrideExecute: boolean;
      }>(`
        SELECT
          has_function_privilege(
            'provider_budget_unprivileged',
            'agentos.reserve_workload_provider_budget(text,text,text,jsonb,text,text,text,jsonb,text,text,text,jsonb,jsonb,bigint,bigint,bigint,bigint)',
            'EXECUTE'
          ) AS "unprivilegedReserveExecute",
          has_function_privilege(
            'provider_budget_unprivileged',
            'agentos.settle_provider_budget_for_provider(text,text,text,text,bigint,bigint,bigint,bigint,bigint)',
            'EXECUTE'
          ) AS "unprivilegedProviderSettleExecute",
          has_table_privilege(
            'provider_budget_egress',
            'agentos.provider_budget_counters', 'SELECT'
          ) AS "countersSelect",
          has_function_privilege(
            'provider_budget_egress',
            'agentos.reserve_workload_provider_budget(text,text,text,jsonb,text,text,text,jsonb,text,text,text,jsonb,jsonb,bigint,bigint,bigint,bigint)',
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
      yield* database.exec("SET ROLE provider_budget_unprivileged");
      const unprivilegedReserve = yield* Effect.exit(database.exec(`
        SELECT * FROM agentos.reserve_workload_provider_budget(
          'decision_${"ef".repeat(16)}', 'budget_${"ef".repeat(32)}',
          'corr_efefefefefefefefefefefefefefefef',
          '${JSON.stringify(workloadPrincipal)}'::jsonb,
          'openai', 'openai-responses', 'openai.responses.create',
          '{"kind":"provider_service","provider":"openai","service":"responses"}'::jsonb,
          'production', 'gpt-5.6-sol', 'low',
          '${JSON.stringify(workloadLimits)}'::jsonb,
          '${JSON.stringify(workloadPricing)}'::jsonb,
          ${now + 15_000}, 1, 1, ${now}
        )
      `));
      const unprivilegedSettlement = yield* Effect.exit(database.exec(`
        SELECT * FROM agentos.settle_provider_budget_for_provider(
          'decision_${"f".repeat(32)}', 'openai', 'openai-responses',
          'transport_failed', 0, 0, 0, 0, ${now}
        )
      `));
      yield* database.exec("RESET ROLE");
      assert.isTrue(Exit.isFailure(unprivilegedReserve));
      assert.deepStrictEqual(privileges, [{
        unprivilegedReserveExecute: false,
        unprivilegedProviderSettleExecute: false,
        countersSelect: false,
        reserveExecute: true,
        providerSettleExecute: true,
        subjectSettleExecute: false,
        overrideExecute: false,
      }]);
      if (Exit.isFailure(unprivilegedReserve)) {
        assert.include(
          String(unprivilegedReserve.cause),
          "permission denied for function reserve_workload_provider_budget",
        );
      }
      assert.isTrue(Exit.isFailure(unprivilegedSettlement));
      if (Exit.isFailure(unprivilegedSettlement)) {
        assert.include(
          String(unprivilegedSettlement.cause),
          "permission denied for function settle_provider_budget_for_provider",
        );
      }
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
