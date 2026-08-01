import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AgentWorkloadProfileError,
  agentWorkloadProfilesV1,
  resolveAgentWorkloadProfile,
} from "../profiles.ts";

type RequirementName =
  | "persistence"
  | "nativeAttach"
  | "resume"
  | "followUp"
  | "retainedWorktree"
  | "retainedDeliveryState"
  | "longLivedServiceIdentity";

const requirementNames: ReadonlyArray<RequirementName> = [
  "persistence",
  "nativeAttach",
  "resume",
  "followUp",
  "retainedWorktree",
  "retainedDeliveryState",
  "longLivedServiceIdentity",
];

function requirements(enabled?: RequirementName) {
  return {
    persistence: enabled === "persistence",
    nativeAttach: enabled === "nativeAttach",
    resume: enabled === "resume",
    followUp: enabled === "followUp",
    retainedWorktree: enabled === "retainedWorktree",
    retainedDeliveryState: enabled === "retainedDeliveryState",
    longLivedServiceIdentity: enabled === "longLivedServiceIdentity",
  };
}

function selection(
  profileId:
    | "persistent-mate@v1"
    | "interactive-crewmate@v1"
    | "stateless-job@v1" = "interactive-crewmate@v1",
) {
  return {
    version: 1,
    profileId,
    requirements: requirements(),
    domainDefaults: null,
  };
}

describe("versioned Agent workload profiles", () => {
  it.effect("publishes the exact immutable v1 mechanics and released bases", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        agentWorkloadProfilesV1.map(({ id }) => id),
        [
          "persistent-mate@v1",
          "interactive-crewmate@v1",
          "stateless-job@v1",
        ],
      );
      assert.isTrue(agentWorkloadProfilesV1.every(Object.isFrozen));
      assert.isTrue(
        agentWorkloadProfilesV1.every(({ mechanics }) =>
          Object.isFrozen(mechanics)
        ),
      );

      const persistent = yield* resolveAgentWorkloadProfile(
        selection("persistent-mate@v1"),
      );
      assert.strictEqual(
        persistent.profile.kustomizeBase,
        "resources/roles/secondmate/kubernetes/domain",
      );
      assert.strictEqual(persistent.profile.compilerAvailability, "released");
      assert.deepStrictEqual(persistent.profile.mechanics, {
        dedicatedServiceAccount: true,
        retainedHome: true,
        podLocalHerdr: true,
        stableWorkload: true,
        oneWriter: true,
        projectedSupervisionIdentity: true,
        longLivedServiceIdentity: true,
      });

      const interactive = yield* resolveAgentWorkloadProfile(selection());
      assert.strictEqual(
        interactive.profile.kustomizeBase,
        "resources/crewmates/default/kubernetes/base",
      );
      assert.strictEqual(interactive.profile.compilerAvailability, "released");
      assert.deepStrictEqual(interactive.profile.mechanics, {
        dedicatedServiceAccount: true,
        retainedHome: true,
        podLocalHerdr: true,
        stableWorkload: true,
        oneWriter: true,
        projectedSupervisionIdentity: false,
        longLivedServiceIdentity: true,
      });
      assert.match(persistent.profile.definitionDigest, /^[0-9a-f]{64}$/);
      assert.match(interactive.profile.definitionDigest, /^[0-9a-f]{64}$/);

      const audited = yield* resolveAgentWorkloadProfile({
        ...selection(),
        requirements: {
          persistence: true,
          nativeAttach: true,
          resume: true,
          followUp: true,
          retainedWorktree: true,
          retainedDeliveryState: true,
          longLivedServiceIdentity: true,
        },
      });
      assert.deepStrictEqual(audited.satisfiedRequirements, requirementNames);
    }));

  it.effect("keeps stateless eligibility visible without claiming a released launcher", () =>
    Effect.gen(function*() {
      const resolution = yield* resolveAgentWorkloadProfile(
        selection("stateless-job@v1"),
      );
      assert.strictEqual(resolution.profile.compilerAvailability, "future");
      assert.strictEqual(resolution.profile.kustomizeBase, null);
      assert.deepStrictEqual(resolution.profile.mechanics, {
        dedicatedServiceAccount: true,
        retainedHome: false,
        podLocalHerdr: false,
        stableWorkload: false,
        oneWriter: false,
        projectedSupervisionIdentity: false,
        longLivedServiceIdentity: false,
      });
      assert.deepStrictEqual(resolution.satisfiedRequirements, []);
      assert.strictEqual(resolution.selectionAuthority, "assignment-dispatch");
    }));

  it.effect("rejects every persistent lifecycle requirement for a stateless job", () =>
    Effect.gen(function*() {
      yield* Effect.forEach(requirementNames, (requirement) =>
        resolveAgentWorkloadProfile({
          ...selection("stateless-job@v1"),
          requirements: requirements(requirement),
        }).pipe(
          Effect.flip,
          Effect.map((error) => {
            assert.instanceOf(error, AgentWorkloadProfileError);
            assert.strictEqual(error.code, "incompatible_requirement");
            assert.strictEqual(error.field, `$.requirements.${requirement}`);
          }),
        ));
    }));

  it.effect("normalizes deterministic domain defaults that only tighten the profile", () =>
    Effect.gen(function*() {
      const input = {
        ...selection("persistent-mate@v1"),
        domainDefaults: {
          homeSize: "10240Mi",
          resources: {
            agent: {
              requests: { cpu: "100m", memory: "256Mi" },
              limits: { cpu: "1000m", memory: "2048Mi" },
            },
            init: {
              requests: { cpu: "100m", memory: "256Mi" },
              limits: { cpu: "1000m", memory: "1024Mi" },
            },
          },
        },
      };
      const first = yield* resolveAgentWorkloadProfile(input);
      const second = yield* resolveAgentWorkloadProfile({
        domainDefaults: input.domainDefaults,
        requirements: input.requirements,
        profileId: input.profileId,
        version: input.version,
      });
      assert.deepStrictEqual(first, second);
      assert.strictEqual(first.defaults.homeSize, "10Gi");
      assert.deepStrictEqual(first.defaults.resources.agent, {
        requests: { cpu: "100m", memory: "256Mi" },
        limits: { cpu: "1", memory: "2Gi" },
      });
      assert.strictEqual(first.domainDefaultsApplied, true);
    }));

  it.effect("rejects widened, inverted, and globally unsafe domain defaults", () =>
    Effect.gen(function*() {
      const baseline = selection("persistent-mate@v1");
      const defaults = {
        homeSize: "10Gi",
        resources: {
          agent: {
            requests: { cpu: "100m", memory: "256Mi" },
            limits: { cpu: "1", memory: "2Gi" },
          },
          init: {
            requests: { cpu: "100m", memory: "256Mi" },
            limits: { cpu: "1", memory: "1Gi" },
          },
        },
      };

      const widened = yield* resolveAgentWorkloadProfile({
        ...baseline,
        domainDefaults: {
          ...defaults,
          resources: {
            ...defaults.resources,
            agent: {
              ...defaults.resources.agent,
              limits: { cpu: "3", memory: "2Gi" },
            },
          },
        },
      }).pipe(Effect.flip);
      assert.strictEqual(widened.code, "defaults_widened");
      assert.strictEqual(widened.field, "$.domainDefaults.resources.agent.limits.cpu");

      const inverted = yield* resolveAgentWorkloadProfile({
        ...baseline,
        domainDefaults: {
          ...defaults,
          resources: {
            ...defaults.resources,
            agent: {
              requests: { cpu: "2", memory: "256Mi" },
              limits: { cpu: "1", memory: "2Gi" },
            },
          },
        },
      }).pipe(Effect.flip);
      assert.strictEqual(inverted.code, "invalid_defaults");
      assert.strictEqual(inverted.field, "$.domainDefaults.resources.agent.limits.cpu");

      const unsafe = yield* resolveAgentWorkloadProfile({
        ...baseline,
        domainDefaults: {
          ...defaults,
          resources: {
            ...defaults.resources,
            agent: {
              ...defaults.resources.agent,
              requests: { cpu: "10m", memory: "256Mi" },
            },
          },
        },
      }).pipe(Effect.flip);
      assert.strictEqual(unsafe.code, "resource_limit");
      assert.strictEqual(unsafe.field, "$.domainDefaults.resources.agent.requests.cpu");
    }));

  it.effect("rejects persistent storage defaults for the future stateless profile", () =>
    Effect.gen(function*() {
      const error = yield* resolveAgentWorkloadProfile({
        ...selection("stateless-job@v1"),
        domainDefaults: {
          homeSize: "1Gi",
          resources: {
            agent: {
              requests: { cpu: "100m", memory: "128Mi" },
              limits: { cpu: "1", memory: "1Gi" },
            },
            init: {
              requests: { cpu: "100m", memory: "128Mi" },
              limits: { cpu: "1", memory: "512Mi" },
            },
          },
        },
      }).pipe(Effect.flip);
      assert.strictEqual(error.code, "invalid_defaults");
      assert.strictEqual(error.field, "$.domainDefaults.homeSize");
    }));

  it.effect("rejects unknown versions and fields with exact value-safe errors", () =>
    Effect.gen(function*() {
      const unsupported = yield* resolveAgentWorkloadProfile({
        ...selection(),
        profileId: "interactive-crewmate@v2",
      }).pipe(Effect.flip);
      assert.strictEqual(unsupported.code, "unsupported_profile");
      assert.strictEqual(unsupported.field, "$.profileId");

      const unknown = yield* resolveAgentWorkloadProfile({
        ...selection(),
        terminalContent: "must-not-leak",
      }).pipe(Effect.flip);
      assert.strictEqual(unknown.code, "invalid_field");
      assert.strictEqual(unknown.field, "$.terminalContent");
      assert.notInclude(JSON.stringify(unknown), "must-not-leak");
    }));
});
