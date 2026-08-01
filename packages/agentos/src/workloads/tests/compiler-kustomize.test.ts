import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { parseAllDocuments } from "yaml";

import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
} from "../../access/identity.ts";
import { compileAgentWorkloadSpec } from "../compiler.ts";

const roots: string[] = [];
const workloadImage =
  `ghcr.io/akua-dev/agentos@sha256:${"a".repeat(64)}`;
const packageRoot = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    force: true,
    recursive: true,
  })));
});

function workloadSpec(
  profile: "persistent-mate" | "interactive-crewmate",
  overlayRoot: string,
) {
  const persistent = profile === "persistent-mate";
  const namespace = persistent
    ? "agentos-domain-platform"
    : "agentos-domain-alpha";
  const workload = persistent
    ? "agentos-platform-mate"
    : "agentos-crewmate-api";
  const databaseIdentity = persistent
    ? "runtime_platform_mate"
    : "runtime_crewmate_api";
  return {
    version: 1,
    distributionRoot: packageRoot,
    overlayRoot,
    profile: { name: profile, version: 1 },
    fleet: "default",
    namespace,
    identity: {
      agentId: persistent
        ? "00000000-0000-4000-8000-000000000002"
        : "00000000-0000-4000-8000-000000000003",
      ownerAgentId: persistent
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000002",
      taskId: persistent
        ? null
        : "00000000-0000-4000-8000-000000000004",
      assignmentId: persistent
        ? null
        : "00000000-0000-4000-8000-000000000005",
      role: persistent ? "second_mate" : "crewmate",
      agentName: persistent ? "platform-mate" : "crewmate-api",
    },
    names: {
      workload,
      service: workload,
      serviceAccount: workload,
      herdrSession: workload,
    },
    ownerServiceAccount: {
      name: persistent ? "agentos-firstmate" : "agentos-secondmate",
      namespace: persistent ? "agentos" : namespace,
    },
    image: {
      reference: workloadImage,
      pullPolicy: "IfNotPresent",
    },
    harness: persistent ? "pi" : "codex",
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
      identity: databaseIdentity,
      url:
        `postgresql://${databaseIdentity}@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos?sslmode=require`,
      secret: { key: "pgpass", name: `${workload}-postgres` },
    },
    providerAccessProfiles: ["openai-responses@v1"],
    brief: persistent
      ? null
      : {
          path: "/home/agent/brief.md",
          sha256: "b".repeat(64),
        },
    readiness: { contract: "semantic-v1" },
    protocols: { a2a: persistent ? "v1" : null, acp: null },
  };
}

async function render(profile: "persistent-mate" | "interactive-crewmate") {
  const root = await mkdtemp(join(tmpdir(), "agentos-workload-plan-"));
  roots.push(root);
  const canonicalRoot = await realpath(root);
  const plan = await Effect.runPromise(
    compileAgentWorkloadSpec(workloadSpec(profile, canonicalRoot)),
  );
  await Promise.all(
    plan.files.map(({ path, content }) =>
      writeFile(join(root, path), content, "utf8"),
    ),
  );
  const child = Bun.spawn(
    [
      "kubectl",
      "kustomize",
      "--load-restrictor",
      "LoadRestrictionsNone",
      canonicalRoot,
    ],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  return {
    plan,
    resources: parseAllDocuments(stdout).map((document) => document.toJSON()),
  };
}

function resourceIdentity(resource: unknown): string {
  if (
    typeof resource !== "object" ||
    resource === null ||
    !("kind" in resource) ||
    typeof resource.kind !== "string" ||
    !("metadata" in resource) ||
    typeof resource.metadata !== "object" ||
    resource.metadata === null ||
    !("name" in resource.metadata) ||
    typeof resource.metadata.name !== "string"
  ) {
    return "invalid";
  }
  return `${resource.kind}/${resource.metadata.name}`;
}

function expectEgressIdentityProjection(pod: Record<string, any>) {
  expect(pod.volumes).toContainEqual({
    name: "agentos-egress-identity",
    projected: {
      defaultMode: 288,
      sources: [
        {
          serviceAccountToken: {
            audience: AGENTOS_EGRESS_TOKEN_AUDIENCE,
            expirationSeconds: AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
            path: "token",
          },
        },
      ],
    },
  });
  for (const container of pod.containers) {
    expect(container.volumeMounts).toContainEqual({
      mountPath: "/var/run/secrets/agentos-egress",
      name: "agentos-egress-identity",
      readOnly: true,
    });
  }
  for (const container of pod.initContainers) {
    expect(container.volumeMounts).not.toContainEqual({
      mountPath: "/var/run/secrets/agentos-egress",
      name: "agentos-egress-identity",
      readOnly: true,
    });
  }
}

describe("AgentWorkloadSpec native Kustomize output", () => {
  test("renders one isolated interactive Crewmate from ordinary native resources", async () => {
    const { plan, resources } = await render("interactive-crewmate");
    expect(resources.map(resourceIdentity).sort()).toEqual([
      "Service/agentos-crewmate-api",
      "ServiceAccount/agentos-crewmate-api",
      "StatefulSet/agentos-crewmate-api",
    ]);
    expect(
      resources.find((resource) =>
        resourceIdentity(resource) === "StatefulSet/agentos-crewmate-api"
      ),
    ).toMatchObject({
      spec: {
        replicas: 1,
        template: {
          metadata: {
            annotations: {
              "agentos.akua.dev/workload-profile-definition":
                plan.summary.profileDefinitionDigest,
            },
          },
          spec: {
            automountServiceAccountToken: false,
            containers: [{
              args: ["server", "--session", "agentos-crewmate-api"],
              name: "crewmate",
              image: workloadImage,
            }],
            initContainers: [
              { name: "install-tools", image: workloadImage },
              { name: "prepare-home", image: workloadImage },
              { name: "prepare-github-provider", image: workloadImage },
            ],
            serviceAccountName: "agentos-crewmate-api",
          },
        },
      },
    });
    expect(JSON.stringify(resources)).not.toContain("agentos-crewmate-postgres");
    expect(JSON.stringify(resources)).toContain(
      "agentos-crewmate-api-postgres",
    );
    const statefulSet = resources.find((resource) =>
      resourceIdentity(resource) === "StatefulSet/agentos-crewmate-api"
    ) as Record<string, any>;
    expectEgressIdentityProjection(statefulSet.spec.template.spec);
  });

  test("renders the persistent Mate and exact released domain controls", async () => {
    const { plan, resources } = await render("persistent-mate");
    expect(resources.map(resourceIdentity).sort()).toEqual([
      "LimitRange/agentos-domain-workload-limits",
      "Namespace/agentos-domain-platform",
      "NetworkPolicy/agentos-domain-ingress",
      "ResourceQuota/agentos-domain-capacity",
      "Role/agentos-firstmate-domain-supervisor",
      "Role/agentos-secondmate-workload-manager",
      "RoleBinding/agentos-firstmate-domain-supervisor-binding",
      "RoleBinding/agentos-secondmate-workload-manager-binding",
      "Service/agentos-platform-mate",
      "ServiceAccount/agentos-platform-mate",
      "StatefulSet/agentos-platform-mate",
    ]);
    expect(
      resources.find((resource) =>
        resourceIdentity(resource) === "StatefulSet/agentos-platform-mate"
      ),
    ).toMatchObject({
      spec: {
        replicas: 1,
        template: {
          metadata: {
            annotations: {
              "agentos.akua.dev/workload-profile-definition":
                plan.summary.profileDefinitionDigest,
            },
          },
          spec: {
            automountServiceAccountToken: true,
            containers: [{
              args: ["server", "--session", "agentos-platform-mate"],
              name: "agentos",
              image: workloadImage,
            }],
            initContainers: [
              { name: "install-tools", image: workloadImage },
              { name: "prepare-home", image: workloadImage },
              { name: "prepare-github-provider", image: workloadImage },
            ],
            serviceAccountName: "agentos-platform-mate",
          },
        },
      },
    });
    expect(JSON.stringify(resources)).not.toContain(
      "agentos-secondmate-postgres",
    );
    expect(JSON.stringify(resources)).toContain(
      "agentos-platform-mate-postgres",
    );
    const statefulSet = resources.find((resource) =>
      resourceIdentity(resource) === "StatefulSet/agentos-platform-mate"
    ) as Record<string, any>;
    expectEgressIdentityProjection(statefulSet.spec.template.spec);
  });
});
