import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  SecondMateTopologyPlanError,
  compileSecondMateTopologyPlan,
} from "../second-mate.ts";

const FirstMateId = "10000000-0000-4000-8000-000000000001";
const PlatformMateId = "20000000-0000-4000-8000-000000000001";
const DeliveryMateId = "20000000-0000-4000-8000-000000000002";
const observedAtMillis = 1_785_600_000_000;

function charter(summary: string, scope: string) {
  return {
    version: 1,
    summary,
    scope,
    projectAccess: "non_exclusive",
    crossDomainRouting: "common_ancestor",
  };
}

const platformCharter = charter(
  "Own platform reliability outcomes",
  "Coordinate runtime, deployment, and operational reliability across products.",
);

const expandedPlatformCharter = charter(
  "Own platform and delivery reliability outcomes",
  "Coordinate runtime, deployment, delivery systems, and operational reliability across products.",
);

function source(agentId: string, expectedCharter = platformCharter) {
  return { agentId, expectedCharter };
}

function existingDestination(
  agentId: string,
  desiredCharter = expandedPlatformCharter,
) {
  return { kind: "existing", agentId, desiredCharter };
}

function newDestination() {
  return {
    kind: "new",
    handle: "delivery-mate",
    displayName: "Delivery Mate",
    desiredCharter: charter(
      "Own delivery-system outcomes",
      "Coordinate build, release, and delivery-system reliability across products.",
    ),
  };
}

function signals() {
  return [
    {
      authority: "postgresql",
      kind: "assignment_load",
      observation: "observed",
      trend: "rising",
    },
    {
      authority: "otel",
      kind: "delivery_health",
      observation: "observed",
      trend: "degrading",
    },
  ];
}

function plan(
  action: string,
  sources: ReadonlyArray<object>,
  destinations: ReadonlyArray<object>,
) {
  return {
    version: 1,
    proposalId: "30000000-0000-4000-8000-000000000001",
    proposedByAgentId: FirstMateId,
    action,
    observedAtMillis,
    validUntilMillis: observedAtMillis + 86_400_000,
    sources,
    destinations,
    reasons: ["persistent_load", "routing_ambiguity"],
    signals: signals(),
    invariants: {
      projectAccess: "non_exclusive",
      crossDomainRouting: "common_ancestor",
      lateralDelivery: "forbidden",
      automaticScheduling: "forbidden",
    },
  };
}

function expectPlanFailure(input: unknown) {
  return compileSecondMateTopologyPlan(input).pipe(
    Effect.flip,
    Effect.map((failure) => {
      assert.instanceOf(failure, SecondMateTopologyPlanError);
      return failure;
    }),
  );
}

layer(BunCrypto.layer)("Second Mate topology plans", (it) => {
  it.effect("accepts every bounded topology action shape", () =>
    Effect.gen(function*() {
      const cases = [
        plan("expand", [source(PlatformMateId)], [
          existingDestination(PlatformMateId),
        ]),
        plan("modify", [source(PlatformMateId)], [
          existingDestination(PlatformMateId),
        ]),
        plan("shrink", [source(PlatformMateId)], [
          existingDestination(PlatformMateId),
        ]),
        plan("split", [source(PlatformMateId)], [
          existingDestination(
            PlatformMateId,
            charter(
              "Own platform runtime outcomes",
              "Coordinate runtime and operational reliability across products.",
            ),
          ),
          newDestination(),
        ]),
        plan(
          "merge",
          [
            source(PlatformMateId),
            source(
              DeliveryMateId,
              charter(
                "Own delivery-system outcomes",
                "Coordinate build and release reliability across products.",
              ),
            ),
          ],
          [existingDestination(PlatformMateId)],
        ),
        plan("retire", [source(PlatformMateId)], []),
      ];

      const compiled = yield* Effect.forEach(
        cases,
        compileSecondMateTopologyPlan,
      );
      assert.deepStrictEqual(
        compiled.map(({ proposal }) => proposal.action),
        ["expand", "modify", "shrink", "split", "merge", "retire"],
      );
    }),
  );

  it.effect("canonicalizes equivalent evidence ordering into one digest", () =>
    Effect.gen(function*() {
      const input = plan("expand", [source(PlatformMateId)], [
        existingDestination(PlatformMateId),
      ]);
      const equivalent = {
        ...input,
        reasons: [...input.reasons].reverse(),
        signals: [...input.signals].reverse(),
      };
      const first = yield* compileSecondMateTopologyPlan(input);
      const second = yield* compileSecondMateTopologyPlan(equivalent);

      assert.strictEqual(first.digest, second.digest);
      assert.deepStrictEqual(first.proposal, second.proposal);
      assert.match(first.digest, /^[0-9a-f]{64}$/);
    }),
  );

  it.effect("rejects telemetry as the only observed authority", () =>
    Effect.gen(function*() {
      const input = plan("expand", [source(PlatformMateId)], [
        existingDestination(PlatformMateId),
      ]);
      const failure = yield* expectPlanFailure({
        ...input,
        signals: [input.signals[1]],
      });
      assert.strictEqual(failure.code, "telemetry_only_evidence");
    }),
  );

  it.effect("rejects action cardinality, duplicate agents, and no-op charter changes", () =>
    Effect.gen(function*() {
      const invalidShape = yield* expectPlanFailure(
        plan("split", [source(PlatformMateId)], [newDestination()]),
      );
      assert.strictEqual(invalidShape.code, "invalid_action_shape");

      const duplicateSource = yield* expectPlanFailure(
        plan(
          "merge",
          [source(PlatformMateId), source(PlatformMateId)],
          [existingDestination(PlatformMateId)],
        ),
      );
      assert.strictEqual(duplicateSource.code, "duplicate_reference");

      const noChange = yield* expectPlanFailure(
        plan("modify", [source(PlatformMateId)], [
          existingDestination(PlatformMateId, platformCharter),
        ]),
      );
      assert.strictEqual(noChange.code, "no_change");
    }),
  );

  it.effect("rejects stale reviews and any attempt to weaken anti-silo invariants", () =>
    Effect.gen(function*() {
      const input = plan("expand", [source(PlatformMateId)], [
        existingDestination(PlatformMateId),
      ]);
      const stale = yield* expectPlanFailure({
        ...input,
        validUntilMillis: observedAtMillis,
      });
      assert.strictEqual(stale.code, "invalid_timing");

      const silo = yield* expectPlanFailure({
        ...input,
        invariants: { ...input.invariants, projectAccess: "exclusive" },
      });
      assert.strictEqual(silo.code, "invalid_contract");

      const contentBearing = yield* expectPlanFailure({
        ...input,
        prompt: "private model reasoning",
      });
      assert.strictEqual(contentBearing.code, "invalid_contract");
    }),
  );
});
