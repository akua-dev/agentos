import { assert, describe, it } from "@effect/vitest";
import { Effect, Metric, Tracer } from "effect";

import {
  AGENTOS_ACCESS_METRICS,
  AGENTOS_TELEMETRY_SPANS,
  makeProviderAccessTelemetry,
} from "../../index.ts";
import type { ProviderAuthorizationGrantV1 } from "../../access/http-authorizer.ts";

const grant: ProviderAuthorizationGrantV1 = {
  schemaVersion: 1,
  correlationId: "corr_44444444444444444444444444444444",
  decisionRef: "decision_22222222222222222222222222222222",
  expiresAtMillis: 1_785_586_015_000,
  credentialDomain: "github",
  identity: {
    agentId: "10000000-0000-4000-8000-000000000001",
    role: "crewmate",
    fleet: "agentos",
    domain: "engineering",
    assignmentId: "20000000-0000-4000-8000-000000000001",
  },
  capability: "github.issue.read",
  resource: {
    kind: "github_repository",
    owner: "akua-dev",
    repository: "agentos",
  },
  profile: { profileId: "github-maintainer", profileVersion: 7 },
  ceiling: {
    ceilingId: "ceiling_33333333333333333333333333333333",
    revision: 9,
  },
  rateClass: "standard",
};

describe("Effect provider-access telemetry", () => {
  it.effect("correlates the bounded adapter lifecycle without metric identity labels", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    return Effect.gen(function*() {
      const telemetry = yield* makeProviderAccessTelemetry();
      const operation = yield* telemetry.start({
        request: new Request("http://github-broker.test/api/v3/repos/akua-dev/agentos", {
          headers: {
            authorization: "Bearer must-never-be-observed",
            traceparent:
              "00-11111111111111111111111111111111-2222222222222222-01",
          },
        }),
        operation: "credential",
        route: "github_rest",
        adapter: "github_broker",
        provider: "github",
      });
      yield* operation.correlate(grant);
      yield* operation.credential("released");
      yield* operation.end({
        decision: "allow",
        reason: "allowed",
        dependency: "provider",
        providerOutcome: "completed",
        status: 200,
      });
      yield* operation.end({
        decision: "error",
        reason: "unknown",
        dependency: "provider",
        providerOutcome: "transport_failed",
        status: 502,
      });

      const accessSpans = spans.filter(({ name }) =>
        name === AGENTOS_TELEMETRY_SPANS.accessProviderAdapter
      );
      assert.lengthOf(accessSpans, 1);
      const span = accessSpans[0]!;
      assert.strictEqual(span.name, AGENTOS_TELEMETRY_SPANS.accessProviderAdapter);
      assert.strictEqual(span.traceId, "11111111111111111111111111111111");
      assert.strictEqual(
        span.attributes.get("agentos.identity.agent_id"),
        grant.identity.agentId,
      );
      assert.strictEqual(
        span.attributes.get("agentos.identity.assignment_id"),
        grant.identity.assignmentId,
      );
      assert.strictEqual(
        span.attributes.get("agentos.authz.profile_version"),
        7,
      );
      assert.strictEqual(
        span.attributes.get("agentos.access.provider.outcome"),
        "completed",
      );
      assert.notInclude(JSON.stringify([...span.attributes]), "must-never-be-observed");

      const metrics = yield* Metric.snapshot;
      const provider = metrics.filter(({ id }) =>
        id === AGENTOS_ACCESS_METRICS.providerOperations
      );
      const releases = metrics.filter(({ id }) =>
        id === AGENTOS_ACCESS_METRICS.credentialReleases
      );
      assert.lengthOf(provider, 1);
      assert.lengthOf(releases, 1);
      const serializedMetrics = JSON.stringify(metrics);
      assert.notInclude(serializedMetrics, grant.identity.agentId);
      assert.notInclude(serializedMetrics, grant.identity.assignmentId ?? "impossible");
      assert.notInclude(serializedMetrics, grant.decisionRef);
      assert.notInclude(serializedMetrics, grant.profile.profileId);
    }).pipe(Effect.withTracer(tracer));
  });

  it.effect("contains tracer defects and returns an inert lifecycle", () =>
    Effect.gen(function*() {
      const telemetry = yield* makeProviderAccessTelemetry();
      const defective = Tracer.make({
        span(options) {
          const revoked = Proxy.revocable<Tracer.Span>(
            new Tracer.NativeSpan(options),
            {},
          );
          revoked.revoke();
          return revoked.proxy;
        },
      });
      const operation = yield* telemetry.start({
        request: new Request("http://egress-authz.test/authorize"),
        operation: "authorization",
        route: "unknown",
        adapter: "egress_authz",
        provider: "unknown",
      }).pipe(Effect.withTracer(defective));
      yield* operation.correlate(grant);
      yield* operation.credential("withheld");
      yield* operation.end({
        decision: "deny",
        reason: "identity_invalid",
        dependency: "none",
        providerOutcome: "not_forwarded",
        status: 401,
      });
    }));
});
