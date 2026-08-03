import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { parse } from "yaml";

import {
  AgentWorkloadSpecError,
  compileAgentWorkloadSpec,
} from "../compiler.ts";

const digest = "a".repeat(64);
const briefDigest = "b".repeat(64);

function interactiveSpec(options?: {
  readonly cpuLimit?: string;
  readonly cpuRequest?: string;
  readonly image?: string;
  readonly ownerAgentId?: string;
  readonly profileName?: string;
  readonly providerAccessProfiles?: ReadonlyArray<string>;
}) {
  return {
    version: 1,
    distributionRoot: "/opt/agentos/packages/agentos",
    overlayRoot: "/home/agent/.local/state/agentos/workloads/crewmate-api",
    profile: {
      name: options?.profileName ?? "interactive-crewmate",
      version: 1,
    },
    fleet: "default",
    namespace: "agentos-domain-alpha",
    identity: {
      agentId: "00000000-0000-4000-8000-000000000003",
      ownerAgentId:
        options?.ownerAgentId ?? "00000000-0000-4000-8000-000000000002",
      taskId: "00000000-0000-4000-8000-000000000004",
      assignmentId: "00000000-0000-4000-8000-000000000005",
      role: "crewmate",
      agentName: "crewmate-api",
    },
    names: {
      workload: "agentos-crewmate-api",
      service: "agentos-crewmate-api",
      serviceAccount: "agentos-crewmate-api",
      herdrSession: "agentos-crewmate-api",
    },
    ownerServiceAccount: {
      name: "agentos-secondmate",
      namespace: "agentos-domain-alpha",
    },
    image: {
      reference:
        options?.image ?? `ghcr.io/akua-dev/agentos@sha256:${digest}`,
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
        requests: { cpu: options?.cpuRequest ?? "250m", memory: "512Mi" },
        limits: { cpu: options?.cpuLimit ?? "2", memory: "4Gi" },
      },
      init: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "2", memory: "2Gi" },
      },
    },
    scheduling: {
      nodeSelector: {
        "topology.kubernetes.io/zone": "zone-a",
        "kubernetes.io/os": "linux",
      },
      tolerations: [
        {
          effect: "NoSchedule",
          key: "workload.agentos.akua.dev/dedicated",
          operator: "Equal",
          value: "agents",
        },
      ],
    },
    database: {
      identity: "runtime_crewmate_api",
      url: "postgresql://runtime_crewmate_api@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos?sslmode=require",
      secret: { key: "pgpass", name: "agentos-crewmate-api-postgres" },
    },
    providerAccessProfiles:
      options?.providerAccessProfiles ?? [
        "openai-responses@v1",
        "github-maintainer@v1",
      ],
    brief: {
      path: "/home/agent/brief.md",
      sha256: briefDigest,
    },
    readiness: { contract: "semantic-v1" },
    protocols: { a2a: null, acp: null },
  };
}

function persistentSpec() {
  const interactive = interactiveSpec();
  return {
    ...interactive,
    profile: { name: "persistent-mate", version: 1 },
    namespace: "agentos-domain-platform",
    identity: {
      agentId: "00000000-0000-4000-8000-000000000002",
      ownerAgentId: "00000000-0000-4000-8000-000000000001",
      taskId: null,
      assignmentId: null,
      role: "second_mate",
      agentName: "platform-mate",
    },
    names: {
      workload: "agentos-platform-mate",
      service: "agentos-platform-mate",
      serviceAccount: "agentos-platform-mate",
      herdrSession: "agentos-platform-mate",
    },
    ownerServiceAccount: {
      name: "agentos-firstmate",
      namespace: "agentos",
    },
    harness: "pi",
    database: {
      identity: "runtime_platform_mate",
      url: "postgresql://runtime_platform_mate@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos?sslmode=require",
      secret: { key: "pgpass", name: "agentos-platform-mate-postgres" },
    },
    providerAccessProfiles: ["openai-responses@v1"],
    brief: null,
    protocols: { a2a: "v1", acp: null },
  };
}

const KustomizationSchema = Schema.Struct({
  apiVersion: Schema.Literal("kustomize.config.k8s.io/v1beta1"),
  kind: Schema.Literal("Kustomization"),
  namespace: Schema.String,
  resources: Schema.Array(Schema.String),
  patches: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      target: Schema.Struct({
        group: Schema.optional(Schema.String),
        version: Schema.String,
        kind: Schema.String,
        name: Schema.String,
      }),
    }),
  ),
});

const WorkloadPatchSchema = Schema.Struct({
  apiVersion: Schema.Literal("apps/v1"),
  kind: Schema.Literal("StatefulSet"),
  metadata: Schema.Struct({
    name: Schema.String,
    labels: Schema.Record(Schema.String, Schema.String),
  }),
  spec: Schema.Struct({
    replicas: Schema.Literal(1),
    serviceName: Schema.String,
    template: Schema.Struct({
      metadata: Schema.Struct({
        annotations: Schema.Record(Schema.String, Schema.String),
        labels: Schema.Record(Schema.String, Schema.String),
      }),
      spec: Schema.Struct({
        automountServiceAccountToken: Schema.Boolean,
        serviceAccountName: Schema.String,
      }),
    }),
  }),
});

function parsedYaml(source: string) {
  return Effect.try({
    try: () => parse(source),
    catch: () => AgentWorkloadSpecError.make({
      code: "serialization_failed",
      field: "$",
      message: "Generated workload YAML could not be parsed",
    }),
  });
}

function planFile(
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
  path: string,
) {
  return Effect.fromOption(
    Option.fromUndefinedOr(files.find((file) => file.path === path)),
  ).pipe(
    Effect.mapError(() =>
      AgentWorkloadSpecError.make({
        code: "serialization_failed",
        field: "$.files",
        message: "Generated workload file is missing",
      }),
    ),
  );
}

describe("AgentWorkloadSpec compiler", () => {
  it.effect("holds byte-identical plans across deterministic canonical-input permutations", () =>
    Effect.gen(function*() {
      const base = interactiveSpec();
      const tolerations = [
        ...base.scheduling.tolerations,
        {
          effect: "NoExecute",
          key: "workload.agentos.akua.dev/evictable",
          operator: "Exists",
          value: null,
        },
      ];
      const expected = yield* compileAgentWorkloadSpec({
        ...base,
        home: { ...base.home, size: "20Gi" },
        resources: {
          ...base.resources,
          agent: {
            requests: { cpu: "250m", memory: "512Mi" },
            limits: { cpu: "2", memory: "4Gi" },
          },
        },
        scheduling: { ...base.scheduling, tolerations },
      });

      yield* Effect.forEach(Array.from({ length: 16 }, (_, index) => index),
        (index) => {
          const reverseProfiles = (index & 1) !== 0;
          const reverseSelectors = (index & 2) !== 0;
          const reverseTolerations = (index & 4) !== 0;
          const alternateUnits = (index & 8) !== 0;
          const providerAccessProfiles = reverseProfiles
            ? [...base.providerAccessProfiles].reverse()
            : [...base.providerAccessProfiles];
          const nodeSelector = reverseSelectors
            ? {
                "kubernetes.io/os": "linux",
                "topology.kubernetes.io/zone": "zone-a",
              }
            : {
                "topology.kubernetes.io/zone": "zone-a",
                "kubernetes.io/os": "linux",
              };
          const candidateTolerations = reverseTolerations
            ? [...tolerations].reverse()
            : tolerations;
          return compileAgentWorkloadSpec({
            protocols: base.protocols,
            readiness: base.readiness,
            brief: base.brief,
            providerAccessProfiles,
            database: base.database,
            scheduling: {
              tolerations: candidateTolerations,
              nodeSelector,
            },
            resources: {
              ...base.resources,
              agent: {
                requests: { cpu: "250m", memory: "512Mi" },
                limits: {
                  cpu: alternateUnits ? "2000m" : "2",
                  memory: alternateUnits ? "4096Mi" : "4Gi",
                },
              },
            },
            home: {
              ...base.home,
              size: alternateUnits ? "20480Mi" : "20Gi",
            },
            harness: base.harness,
            image: base.image,
            ownerServiceAccount: base.ownerServiceAccount,
            names: base.names,
            identity: base.identity,
            namespace: base.namespace,
            fleet: base.fleet,
            profile: base.profile,
            overlayRoot: base.overlayRoot,
            distributionRoot: base.distributionRoot,
            version: base.version,
          }).pipe(Effect.tap((candidate) => Effect.sync(() => {
            assert.strictEqual(candidate.specDigest, expected.specDigest);
            assert.strictEqual(candidate.overlayDigest, expected.overlayDigest);
            assert.deepStrictEqual(candidate.files, expected.files);
          })));
        }, { concurrency: "unbounded", discard: true });
    }));

  it.effect("canonicalizes equivalent inputs into byte-identical overlays and digests", () =>
    Effect.gen(function*() {
      const first = yield* compileAgentWorkloadSpec(interactiveSpec());
      const equivalent = interactiveSpec({
        cpuLimit: "2000m",
        cpuRequest: "250m",
        providerAccessProfiles: [
          "github-maintainer@v1",
          "openai-responses@v1",
        ],
      });
      const second = yield* compileAgentWorkloadSpec({
        protocols: equivalent.protocols,
        readiness: equivalent.readiness,
        brief: equivalent.brief,
        providerAccessProfiles: equivalent.providerAccessProfiles,
        database: equivalent.database,
        scheduling: {
          tolerations: equivalent.scheduling.tolerations,
          nodeSelector: {
            "kubernetes.io/os": "linux",
            "topology.kubernetes.io/zone": "zone-a",
          },
        },
        resources: equivalent.resources,
        home: equivalent.home,
        harness: equivalent.harness,
        image: equivalent.image,
        ownerServiceAccount: equivalent.ownerServiceAccount,
        names: equivalent.names,
        identity: equivalent.identity,
        namespace: equivalent.namespace,
        fleet: equivalent.fleet,
        profile: equivalent.profile,
        overlayRoot: equivalent.overlayRoot,
        distributionRoot: equivalent.distributionRoot,
        version: equivalent.version,
      });

      assert.strictEqual(first.specDigest, second.specDigest);
      assert.strictEqual(first.overlayDigest, second.overlayDigest);
      assert.deepStrictEqual(first.files, second.files);
      assert.match(first.specDigest, /^[0-9a-f]{64}$/);
      assert.match(first.overlayDigest, /^[0-9a-f]{64}$/);
      assert.strictEqual(first.summary.profileId, "interactive-crewmate@v1");
      assert.match(first.summary.profileDefinitionDigest, /^[0-9a-f]{64}$/);
      const safeSummary = JSON.stringify(first.summary);
      assert.notInclude(safeSummary, first.spec.distributionRoot);
      assert.notInclude(safeSummary, first.spec.overlayRoot);
      assert.notInclude(safeSummary, first.spec.database.url);
      assert.notInclude(safeSummary, first.spec.brief?.path ?? "brief-path");

      const kustomizationFile = yield* planFile(
        first.files,
        "kustomization.yaml",
      );
      const kustomization = yield* parsedYaml(kustomizationFile.content).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(KustomizationSchema)),
      );
      assert.strictEqual(kustomization.namespace, "agentos-domain-alpha");
      assert.strictEqual(kustomization.resources.length, 1);
      assert.deepStrictEqual(
        [...new Set(kustomization.patches.map(({ target }) => target.kind))]
          .sort(),
        ["Service", "ServiceAccount", "StatefulSet"],
      );

      const workloadFile = yield* planFile(first.files, "workload.patch.yaml");
      const workload = yield* parsedYaml(workloadFile.content).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(WorkloadPatchSchema)),
      );
      assert.strictEqual(workload.spec.replicas, 1);
      assert.strictEqual(
        workload.spec.template.spec.automountServiceAccountToken,
        false,
      );
      assert.strictEqual(
        workload.spec.template.spec.serviceAccountName,
        "agentos-crewmate-api",
      );
      assert.strictEqual(
        workload.spec.template.metadata.annotations[
          "agentos.akua.dev/workload-profile-definition"
        ],
        first.summary.profileDefinitionDigest,
      );
      assert.deepStrictEqual(first.summary.resourceKinds, [
        "PersistentVolumeClaim",
        "Service",
        "ServiceAccount",
        "StatefulSet",
      ]);
    }));

  it.effect("emits the released persistent domain composition without inventing resource kinds", () =>
    Effect.gen(function*() {
      const plan = yield* compileAgentWorkloadSpec(persistentSpec());
      const kustomizationFile = yield* planFile(
        plan.files,
        "kustomization.yaml",
      );
      const kustomization = yield* parsedYaml(kustomizationFile.content).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(KustomizationSchema)),
      );
      assert.deepStrictEqual(plan.summary.resourceKinds, [
        "LimitRange",
        "Namespace",
        "NetworkPolicy",
        "PersistentVolumeClaim",
        "ResourceQuota",
        "Role",
        "RoleBinding",
        "Service",
        "ServiceAccount",
        "StatefulSet",
      ]);
      assert.deepStrictEqual(
        [...new Set(kustomization.patches.map(({ target }) => target.kind))]
          .sort(),
        ["Namespace", "RoleBinding", "Service", "ServiceAccount", "StatefulSet"],
      );
      assert.strictEqual(plan.summary.assignmentId, null);
      assert.strictEqual(plan.summary.profile.name, "persistent-mate");
      assert.strictEqual(plan.summary.profileId, "persistent-mate@v1");
      assert.match(plan.summary.profileDefinitionDigest, /^[0-9a-f]{64}$/);
    }));

  it.effect("rejects unknown literal Secret fields with an exact safe path", () =>
    Effect.gen(function*() {
      const base = interactiveSpec();
      const error = yield* compileAgentWorkloadSpec({
        ...base,
        database: {
          ...base.database,
          secret: {
            ...base.database.secret,
            value: "credential-must-not-leak",
          },
        },
      }).pipe(Effect.flip);

      assert.instanceOf(error, AgentWorkloadSpecError);
      assert.strictEqual(error.code, "invalid_field");
      assert.strictEqual(error.field, "$.database.secret.value");
      assert.notInclude(JSON.stringify(error), "credential-must-not-leak");
    }));

  it.effect("rejects mutable images and credential-bearing database URLs", () =>
    Effect.gen(function*() {
      const mutable = yield* compileAgentWorkloadSpec(
        interactiveSpec({ image: "ghcr.io/akua-dev/agentos:latest" }),
      ).pipe(Effect.flip);
      assert.strictEqual(mutable.code, "mutable_image");
      assert.strictEqual(mutable.field, "$.image.reference");
      assert.notInclude(JSON.stringify(mutable), "latest");

      const base = interactiveSpec();
      const credential = yield* compileAgentWorkloadSpec({
        ...base,
        database: {
          ...base.database,
          url: "postgresql://runtime_crewmate_api:credential-must-not-leak@database.example.test/agentos",
        },
      }).pipe(Effect.flip);
      assert.strictEqual(credential.code, "literal_credential");
      assert.strictEqual(credential.field, "$.database.url");
      assert.notInclude(JSON.stringify(credential), "credential-must-not-leak");
    }));

  it.effect("rejects unsupported profiles and inconsistent lifecycle ownership", () =>
    Effect.gen(function*() {
      const unsupported = yield* compileAgentWorkloadSpec(
        interactiveSpec({ profileName: "stateless-job" }),
      ).pipe(Effect.flip);
      assert.strictEqual(unsupported.code, "unsupported_profile");
      assert.strictEqual(unsupported.field, "$.profile.name");

      const sameOwner = interactiveSpec({
        ownerAgentId: "00000000-0000-4000-8000-000000000003",
      });
      const ownership = yield* compileAgentWorkloadSpec(sameOwner).pipe(
        Effect.flip,
      );
      assert.strictEqual(ownership.code, "invalid_relationship");
      assert.strictEqual(ownership.field, "$.identity.ownerAgentId");

      const persistent = persistentSpec();
      const lifecycle = yield* compileAgentWorkloadSpec({
        ...persistent,
        identity: {
          ...persistent.identity,
          assignmentId: "00000000-0000-4000-8000-000000000005",
        },
      }).pipe(Effect.flip);
      assert.strictEqual(lifecycle.code, "invalid_relationship");
      assert.strictEqual(lifecycle.field, "$.identity.assignmentId");
    }));

  it.effect("enforces workload resource ceilings and unique profile references", () =>
    Effect.gen(function*() {
      const resources = yield* compileAgentWorkloadSpec(
        interactiveSpec({ cpuLimit: "5" }),
      ).pipe(Effect.flip);
      assert.strictEqual(resources.code, "resource_limit");
      assert.strictEqual(resources.field, "$.resources.agent.limits.cpu");

      const duplicate = yield* compileAgentWorkloadSpec(
        interactiveSpec({
          providerAccessProfiles: [
            "github-maintainer@v1",
            "github-maintainer@v1",
          ],
        }),
      ).pipe(Effect.flip);
      assert.strictEqual(duplicate.code, "duplicate_reference");
      assert.strictEqual(duplicate.field, "$.providerAccessProfiles");
    }));

  it.effect("rejects storage, ServiceAccount, and protocol boundary violations at exact safe fields", () =>
    Effect.gen(function*() {
      const base = interactiveSpec();
      const cases: ReadonlyArray<{
        readonly code: AgentWorkloadSpecError["code"];
        readonly field: string;
        readonly input: unknown;
      }> = [
        {
          code: "resource_limit",
          field: "$.home.size",
          input: { ...base, home: { ...base.home, size: "512Mi" } },
        },
        {
          code: "invalid_relationship",
          field: "$.names.serviceAccount",
          input: {
            ...base,
            names: {
              ...base.names,
              serviceAccount: base.ownerServiceAccount.name,
            },
          },
        },
        {
          code: "invalid_field",
          field: "$.protocols.acp",
          input: {
            ...base,
            protocols: { ...base.protocols, acp: "v2" },
          },
        },
        {
          code: "invalid_field",
          field: "$.protocols.credential",
          input: {
            ...base,
            protocols: {
              ...base.protocols,
              credential: "must-not-leak",
            },
          },
        },
      ];

      yield* Effect.forEach(cases, ({ code, field, input }) =>
        compileAgentWorkloadSpec(input).pipe(
          Effect.flip,
          Effect.tap((error) => Effect.sync(() => {
            assert.strictEqual(error.code, code);
            assert.strictEqual(error.field, field);
            assert.notInclude(JSON.stringify(error), "must-not-leak");
          })),
        ), { discard: true });
    }));
});
