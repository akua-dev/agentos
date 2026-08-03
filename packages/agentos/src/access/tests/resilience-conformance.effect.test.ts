import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer, Path } from "effect";

import {
  ACCESS_RESILIENCE_REGRESSION_SOURCES,
  ACCESS_RESILIENCE_SCENARIOS,
  AccessResilienceGateError,
  AccessResilienceRegressionSourceError,
  accessResilienceScenarioDefinition,
  compileAccessResilienceVerdict,
  verifyAccessResilienceRegressionSources,
  type AccessResilienceObservationV1,
  type AccessResilienceRunV1,
  type AccessResilienceScenarioId,
} from "../resilience-conformance.ts";

const revision = "a".repeat(40);
const environment: AccessResilienceRunV1["environment"] = {
  isolation: "disposable",
  context: "kind-agentos-resilience-84",
  approvalReference: `approval:issue-92-${revision}`,
  productionEndpointContacted: false,
  destroyedAfterRun: true,
};
const images: AccessResilienceRunV1["images"] = [
  { name: "agentos", digest: `sha256:${"a".repeat(64)}` },
  { name: "agentgateway", digest: `sha256:${"b".repeat(64)}` },
  { name: "openfga", digest: `sha256:${"c".repeat(64)}` },
  { name: "postgresql", digest: `sha256:${"d".repeat(64)}` },
  { name: "kubernetes-node", digest: `sha256:${"e".repeat(64)}` },
];

function observation(
  scenario: AccessResilienceScenarioId,
  overrides: Partial<AccessResilienceObservationV1> = {},
): AccessResilienceObservationV1 {
  const expected = accessResilienceScenarioDefinition(scenario);
  const nativeClient = expected.nativeClient;
  const attempts = expected.requiresLoad ? 32 : 1;
  const allowed = ["allowed", "completed", "bypassed"].includes(
    expected.outcome,
  );
  return {
    version: 1,
    scenario,
    source: expected.minimumSource,
    status: "observed",
    outcome: expected.outcome,
    failureClass: expected.failureClass,
    recovery: expected.recovery,
    elapsedMillis: 25,
    revocationMillis: expected.requiresRevocationSlo ? 1_250 : null,
    hotReloadMillis: expected.requiresHotReloadSlo ? 900 : null,
    load: {
      attempts,
      allowed: allowed ? attempts : 0,
      denied: allowed ? 0 : attempts,
      providerForwards: expected.providerForwardExpected ? attempts : 0,
      settlements: expected.settlementExpected ? attempts : 0,
    },
    enforcement: {
      providerAdapterReached: expected.providerForwardExpected,
      credentialReleased: expected.credentialReleaseExpected,
      unrelatedSubjectAllowed: expected.requiresUnrelatedContinuity
        ? true
        : null,
      ordinaryInternetAllowed: expected.requiresInternetContinuity
        ? true
        : null,
    },
    native: {
      client: nativeClient,
      projectedTokenReread: nativeClient === "none" ? null : true,
      persistedLogin: nativeClient === "none" ? null : false,
      statusPreserved: expected.requiresNativeSemantics ? true : null,
      streamPreserved: expected.requiresNativeSemantics ? true : null,
      stderrPreserved: expected.requiresNativeSemantics ? true : null,
      exitCodePreserved: expected.requiresNativeSemantics ? true : null,
    },
    audit: {
      complete: true,
      protected: true,
      eventCount: 1,
      metricDimensions: [
        "operation",
        "outcome",
        "failure_class",
        "dependency",
        "credential_outcome",
      ],
      observedContent: [],
    },
    ...overrides,
  };
}

function run(): AccessResilienceRunV1 {
  return {
    version: 1,
    revision,
    environment,
    images,
    observations: ACCESS_RESILIENCE_SCENARIOS.map((scenario) =>
      observation(scenario)
    ),
  };
}

function withObservations(
  transform: (
    observations: AccessResilienceRunV1["observations"],
  ) => AccessResilienceRunV1["observations"],
): AccessResilienceRunV1 {
  const current = run();
  return { ...current, observations: transform(current.observations) };
}

function rejected(candidate: AccessResilienceRunV1) {
  return compileAccessResilienceVerdict(candidate).pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => assert.instanceOf(failure, AccessResilienceGateError))
    ),
  );
}

describe("access-plane resilience conformance", () => {
  it.effect("accepts the complete identity, policy, failure, native-client, and privacy matrix", () =>
    Effect.gen(function*() {
      assert.strictEqual(ACCESS_RESILIENCE_SCENARIOS.length, 38);
      const verdict = yield* compileAccessResilienceVerdict(run());
      assert.deepStrictEqual(verdict, {
        version: 1,
        eligible: true,
        scenarioCount: 38,
        effectFixtureCount: 19,
        pgliteCount: 9,
        disposableKubernetesCount: 10,
        revocationSloMillis: 60_000,
        hotReloadSloMillis: 15_000,
        minimumLoadAttempts: 16,
        providerCredentialAuthority: "provider_adapter",
        ordinaryInternetPath: "direct",
      });
    }));

  it.effect("rejects missing, duplicate, unobserved, mismatched, and weak evidence", () =>
    Effect.gen(function*() {
      const missing = withObservations((observations) => observations.slice(1));
      assert.strictEqual((yield* rejected(missing)).code, "scenario_missing");

      const duplicateRun = run();
      let duplicate = duplicateRun;
      const first = duplicateRun.observations[0];
      assert.isDefined(first);
      if (first !== undefined) {
        duplicate = {
          ...duplicateRun,
          observations: [...duplicateRun.observations, first],
        };
      }
      assert.strictEqual((yield* rejected(duplicate)).code, "scenario_duplicate");

      const unobserved = withObservations((observations) =>
        observations.map<AccessResilienceObservationV1>((item) =>
        item.scenario === "identity.wrong_audience"
          ? { ...item, status: "unobserved" }
          : item
        ));
      assert.strictEqual((yield* rejected(unobserved)).code, "scenario_unobserved");

      const mismatched = withObservations((observations) =>
        observations.map<AccessResilienceObservationV1>((item) =>
        item.scenario === "identity.impersonation_denied"
          ? { ...item, failureClass: "audience_mismatch" }
          : item
        ));
      assert.strictEqual((yield* rejected(mismatched)).code, "outcome_mismatch");

      const weak = withObservations((observations) =>
        observations.map<AccessResilienceObservationV1>((item) =>
        item.scenario === "identity.deleted_pod"
          ? { ...item, source: "effect_fixture" }
          : item
        ));
      assert.strictEqual((yield* rejected(weak)).code, "evidence_too_weak");
    }));

  it.effect("requires revocation and hot reload to meet their SLOs under load", () =>
    Effect.gen(function*() {
      const slow = withObservations((observations) => observations.map((item) =>
        item.scenario === "identity.deleted_pod"
          ? { ...item, revocationMillis: 60_001 }
          : item
      ));
      assert.strictEqual((yield* rejected(slow)).code, "revocation_slo_exceeded");

      const stale = withObservations((observations) => observations.map((item) =>
        item.scenario === "authorization.profile_rebind"
          ? { ...item, hotReloadMillis: 15_001 }
          : item
      ));
      assert.strictEqual((yield* rejected(stale)).code, "hot_reload_slo_exceeded");

      const unloaded = withObservations((observations) => observations.map((item) =>
        item.scenario === "authorization.binding_revocation"
          ? { ...item, load: { ...item.load, attempts: 1, denied: 1 } }
          : item
      ));
      assert.strictEqual((yield* rejected(unloaded)).code, "load_evidence_missing");
    }));

  it.effect("rejects any denied adapter reach or credential release and enforces exactly-once settlement", () =>
    Effect.gen(function*() {
      const reached = withObservations((observations) => observations.map((item) =>
        item.scenario === "authorization.scope_mismatch"
          ? {
            ...item,
            enforcement: { ...item.enforcement, providerAdapterReached: true },
            load: { ...item.load, providerForwards: 1 },
          }
          : item
      ));
      assert.strictEqual((yield* rejected(reached)).code, "denial_reached_adapter");

      const released = withObservations((observations) => observations.map((item) =>
        item.scenario === "authorization.budget_kill_switch"
          ? { ...item, enforcement: { ...item.enforcement, credentialReleased: true } }
          : item
      ));
      assert.strictEqual((yield* rejected(released)).code, "denial_released_credential");

      const duplicateSettlement = withObservations((observations) => observations.map((item) =>
        item.scenario === "settlement.exactly_once"
          ? { ...item, load: { ...item.load, settlements: item.load.attempts + 1 } }
          : item
      ));
      assert.strictEqual((yield* rejected(duplicateSettlement)).code, "settlement_mismatch");
    }));

  it.effect("requires complete protected content-free audit with bounded metric dimensions", () =>
    Effect.gen(function*() {
      const incomplete = withObservations((observations) => observations.map((item) =>
        item.scenario === "dependency.openfga_outage"
          ? { ...item, audit: { ...item.audit, complete: false } }
          : item
      ));
      assert.strictEqual((yield* rejected(incomplete)).code, "audit_incomplete");

      const leak = withObservations((observations) => observations.map((item) =>
        item.scenario === "native.github_graphql"
          ? { ...item, audit: { ...item.audit, observedContent: ["request_body"] } }
          : item
      ));
      assert.strictEqual((yield* rejected(leak)).code, "content_leak");

      const cardinality = withObservations((observations) => observations.map((item) =>
        item.scenario === "native.github_rest"
          ? { ...item, audit: { ...item.audit, metricDimensions: ["assignment_id"] } }
          : item
      ));
      assert.strictEqual((yield* rejected(cardinality)).code, "metric_cardinality_violation");
    }));

  it.effect("requires direct Internet continuity and native clients without persisted login", () =>
    Effect.gen(function*() {
      const outage = withObservations((observations) => observations.map((item) =>
        item.scenario === "internet.ordinary_continuity"
          ? { ...item, enforcement: { ...item.enforcement, ordinaryInternetAllowed: false } }
          : item
      ));
      assert.strictEqual((yield* rejected(outage)).code, "internet_independence_missing");

      const persisted = withObservations((observations) => observations.map((item) =>
        item.scenario === "native.gh_projected_identity"
          ? { ...item, native: { ...item.native, persistedLogin: true } }
          : item
      ));
      assert.strictEqual((yield* rejected(persisted)).code, "native_client_violation");

      const staleToken = withObservations((observations) => observations.map((item) =>
        item.scenario === "native.gh_axi_projected_identity"
          ? { ...item, native: { ...item.native, projectedTokenReread: false } }
          : item
      ));
      assert.strictEqual((yield* rejected(staleToken)).code, "native_client_violation");
    }));
});

const platform = Layer.merge(BunFileSystem.layer, BunPath.layer);
const repositoryRootUrl = new URL("../../../../../", import.meta.url);

layer(platform)("access conformance regression sources", (it) => {
  it.effect("binds every access scenario to two distinct existing Effect regressions", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const repositoryRoot = paths.resolve(
        yield* paths.fromFileUrl(repositoryRootUrl),
      );
      const result = yield* verifyAccessResilienceRegressionSources({
        repositoryRoot,
        references: ACCESS_RESILIENCE_REGRESSION_SOURCES,
      });
      assert.deepStrictEqual(result, {
        version: 1,
        scenarioCount: 38,
        referenceCount: 76,
        allEffectNative: true,
      });
    }));

  it.effect("rejects missing and reused access regression references", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const repositoryRoot = paths.resolve(
        yield* paths.fromFileUrl(repositoryRootUrl),
      );
      const missing = yield* verifyAccessResilienceRegressionSources({
        repositoryRoot,
        references: ACCESS_RESILIENCE_REGRESSION_SOURCES.slice(2),
      }).pipe(Effect.flip);
      assert.instanceOf(missing, AccessResilienceRegressionSourceError);
      assert.strictEqual(missing.code, "scenario_reference_missing");

      const original = ACCESS_RESILIENCE_REGRESSION_SOURCES[0];
      const heldOut = ACCESS_RESILIENCE_REGRESSION_SOURCES[1];
      assert.isDefined(original);
      assert.isDefined(heldOut);
      if (original === undefined || heldOut === undefined) return;
      const reused = yield* verifyAccessResilienceRegressionSources({
        repositoryRoot,
        references: ACCESS_RESILIENCE_REGRESSION_SOURCES.map((reference) =>
          reference === heldOut
            ? { ...reference, path: original.path, title: original.title }
            : reference
        ),
      }).pipe(Effect.flip);
      assert.strictEqual(reused.code, "original_held_out_reused");
    }));
});
