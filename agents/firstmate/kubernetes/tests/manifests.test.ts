import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Resource = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    annotations?: Record<string, string>;
    labels?: Record<string, string>;
  };
  spec?: Record<string, any>;
  roleRef?: Record<string, any>;
  subjects?: Array<Record<string, any>>;
};

const runtime = new URL("..", import.meta.url).pathname;

async function render(directory: string): Promise<Resource[]> {
  const child = Bun.spawn(
    ["kubectl", "kustomize", "--load-restrictor", "LoadRestrictionsNone", directory],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  return Bun.YAML.parse(stdout) as Resource[];
}

function resource(resources: Resource[], kind: string, name: string) {
  const match = resources.find(
    (candidate) => candidate.kind === kind && candidate.metadata.name === name,
  );
  if (!match) throw new Error(`Missing ${kind}/${name}`);
  return match;
}

async function applyStrategicPatch(
  target: Resource,
  patchFile: string,
): Promise<Resource> {
  const directory = await mkdtemp(join(tmpdir(), "agentos-kubectl-patch-"));
  const targetFile = join(directory, "target.yaml");
  await writeFile(targetFile, Bun.YAML.stringify(target), "utf8");
  try {
    const child = Bun.spawn(
      [
        "kubectl",
        "patch",
        "--local",
        "--filename",
        targetFile,
        "--type",
        "strategic",
        "--patch-file",
        patchFile,
        "--output",
        "yaml",
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    return Bun.YAML.parse(stdout) as Resource;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe("First Mate Kubernetes resources", () => {
  test("renders one retained, non-root home with no public endpoint", async () => {
    const resources = await render(join(runtime, "base"));
    expect(resources.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort()).toEqual([
      "Namespace/agentos",
      "RoleBinding/agentos-firstmate-admin",
      "Service/agentos-firstmate",
      "ServiceAccount/agentos-firstmate",
      "StatefulSet/agentos-firstmate",
    ]);

    const service = resource(resources, "Service", "agentos-firstmate");
    expect(service.spec).toEqual({
      clusterIP: "None",
      selector: { "app.kubernetes.io/name": "agentos-firstmate" },
    });

    const roleBinding = resource(resources, "RoleBinding", "agentos-firstmate-admin");
    expect(roleBinding.roleRef).toEqual({
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "admin",
    });
    expect(roleBinding.subjects).toEqual([
      { kind: "ServiceAccount", name: "agentos-firstmate", namespace: "agentos" },
    ]);

    const statefulSet = resource(resources, "StatefulSet", "agentos-firstmate");
    const spec = statefulSet.spec!;
    expect(spec.replicas).toBe(1);
    expect(spec.serviceName).toBe("agentos-firstmate");
    expect(spec.persistentVolumeClaimRetentionPolicy).toEqual({
      whenDeleted: "Retain",
      whenScaled: "Retain",
    });
    expect(spec.volumeClaimTemplates).toEqual([
      {
        metadata: { name: "home" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "20Gi" } },
        },
      },
    ]);

    const pod = spec.template.spec;
    expect(spec.template.metadata).toEqual({
      annotations: {
        "agentos.akua.dev/container": "agentos",
        "agentos.akua.dev/herdr-session": "agentos-firstmate",
      },
      labels: {
        "agentos.akua.dev/agent": "firstmate",
        "app.kubernetes.io/name": "agentos-firstmate",
        "app.kubernetes.io/part-of": "agentos",
      },
    });
    expect(pod.securityContext).toEqual({
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.initContainers).toHaveLength(2);
    expect(pod.containers).toHaveLength(1);
    const install = pod.initContainers[0];
    const prepare = pod.initContainers[1];
    const firstmate = pod.containers[0];
    const environment = Object.fromEntries(
      firstmate.env.map(({ name, value }: { name: string; value: string }) => [
        name,
        value,
      ]),
    );
    expect(install.image).toBe("agentos:dev");
    expect(prepare.image).toBe(install.image);
    expect(firstmate.image).toBe(install.image);
    expect(
      [install, prepare, firstmate].map(
        ({ workingDir }: { workingDir: string }) => workingDir,
      ),
    ).toEqual([
      "/opt/agentos/agents/firstmate",
      "/opt/agentos/agents/firstmate",
      "/opt/agentos/agents/firstmate",
    ]);
    expect(install.volumeMounts).toEqual([{ mountPath: "/home/agent", name: "home" }]);
    expect(prepare.volumeMounts).toEqual(install.volumeMounts);
    expect(firstmate.volumeMounts).toEqual(install.volumeMounts);
    expect(install.command).toEqual(["mise"]);
    expect(install.args).toEqual([
      "install",
      "--locked",
      "node",
      "kubectl",
      "github:ogulcancelik/herdr",
      "npm:@earendil-works/pi-coding-agent",
    ]);
    expect(prepare.command).toEqual(["mise"]);
    expect(prepare.args).toEqual(["run", "--skip-tools", "firstmate:prepare"]);
    expect(firstmate.command).toEqual(["mise"]);
    expect(firstmate.args).toEqual(["run", "--skip-tools", "firstmate:run"]);
    expect(environment.AGENTOS_AGENT_CWD).toBe(
      "/home/agent/projects/agentos/agents/firstmate",
    );
    expect(environment.AGENTOS_AGENT_NAME).toBe("firstmate");
    expect(environment.AGENTOS_AGENT_ROLE).toBe("first_mate");
    expect(environment.AGENTOS_MODEL).toBeUndefined();
    expect(environment.AGENTOS_THINKING).toBeUndefined();
    expect(environment.PI_OAUTH_CALLBACK_HOST).toBe("0.0.0.0");
    expect(firstmate.livenessProbe.exec.command).toEqual([
      "mise",
      "run",
      "--skip-tools",
      "firstmate:health",
      "--",
      "live",
    ]);
    expect(firstmate.readinessProbe.exec.command).toEqual([
      "mise",
      "run",
      "--skip-tools",
      "firstmate:health",
      "--",
      "ready",
    ]);
    expect(firstmate.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    });
    expect(
      resources.filter(({ kind }) =>
        ["Ingress", "LoadBalancer", "NodePort", "ClusterRoleBinding"].includes(kind),
      ),
    ).toEqual([]);
  });

  test("adds cluster-admin only through the dedicated-cluster overlay", async () => {
    const resources = await render(join(runtime, "overlays", "cluster-admin"));
    const binding = resource(
      resources,
      "ClusterRoleBinding",
      "agentos-firstmate-cluster-admin",
    );

    expect(binding.roleRef).toEqual({
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "cluster-admin",
    });
    expect(binding.subjects).toEqual([
      { kind: "ServiceAccount", name: "agentos-firstmate", namespace: "agentos" },
    ]);
  });

  test("adds CNPG client identity without replacing live First Mate state", async () => {
    const resources = await render(join(runtime, "base"));
    const original = resource(resources, "StatefulSet", "agentos-firstmate");
    const live = structuredClone(original);
    const livePod = live.spec!.template.spec;
    const liveImage = `ghcr.io/akua-dev/agentos@sha256:${"a".repeat(64)}`;
    for (const container of [...livePod.initContainers, ...livePod.containers]) {
      container.image = liveImage;
      container.imagePullPolicy = "IfNotPresent";
    }
    livePod.containers[0].env.push({
      name: "EXISTING_RUNTIME_SETTING",
      value: "preserve-me",
    });
    livePod.containers[0].volumeMounts.push({
      mountPath: "/var/run/existing",
      name: "existing-runtime",
      readOnly: true,
    });
    livePod.volumes = [
      {
        name: "existing-runtime",
        configMap: { name: "existing-runtime" },
      },
    ];
    const statefulSet = await applyStrategicPatch(
      live,
      join(runtime, "patches", "cloudnative-pg.yaml"),
    );
    const pod = statefulSet.spec!.template.spec;
    const install = pod.initContainers[0];
    const prepare = pod.initContainers[1];
    const firstmate = pod.containers[0];
    expect(
      [install, prepare, firstmate].map(({ image }: { image: string }) => image),
    ).toEqual([liveImage, liveImage, liveImage]);
    expect(
      [install, prepare, firstmate].map(
        ({ imagePullPolicy }: { imagePullPolicy: string }) => imagePullPolicy,
      ),
    ).toEqual(["IfNotPresent", "IfNotPresent", "IfNotPresent"]);
    expect(pod.serviceAccountName).toBe("agentos-firstmate");
    expect(firstmate.volumeMounts).toContainEqual({
      mountPath: "/home/agent",
      name: "home",
    });
    expect(firstmate.volumeMounts).toContainEqual({
      mountPath: "/var/run/existing",
      name: "existing-runtime",
      readOnly: true,
    });
    expect(install.volumeMounts).not.toContainEqual(expect.objectContaining({ name: "postgres-ca" }));
    expect(install.volumeMounts).not.toContainEqual(expect.objectContaining({ name: "postgres-pgpass" }));
    expect(prepare.volumeMounts).toContainEqual({
      mountPath: "/var/run/agentos/postgres-credentials",
      name: "postgres-pgpass",
      readOnly: true,
    });
    expect(firstmate.volumeMounts).toContainEqual({
      mountPath: "/var/run/agentos/postgres",
      name: "postgres-ca",
      readOnly: true,
    });

    const environment = Object.fromEntries(
      firstmate.env.map(({ name, value }: { name: string; value: string }) => [
        name,
        value,
      ]),
    );
    expect(environment).toMatchObject({
      DATABASE_URL:
        "postgresql://agentos@agentos-postgres-rw:5432/agentos?sslmode=verify-full",
      EXISTING_RUNTIME_SETTING: "preserve-me",
      NODE_EXTRA_CA_CERTS: "/var/run/agentos/postgres/ca.crt",
      PGPASSFILE: "/home/agent/.pgpass",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "/var/run/agentos/postgres/ca.crt",
    });
    expect(environment.PGPASSWORD).toBeUndefined();
    expect(
      Object.fromEntries(
        prepare.env.map(({ name, value }: { name: string; value: string }) => [name, value]),
      ).AGENTOS_PGPASS_SOURCE,
    ).toBe("/var/run/agentos/postgres-credentials/pgpass");
    expect(pod.volumes).toContainEqual({
      name: "postgres-ca",
      secret: {
        defaultMode: 288,
        items: [{ key: "ca.crt", path: "ca.crt" }],
        secretName: "agentos-postgres-ca",
      },
    });
    expect(pod.volumes).toContainEqual({
      name: "postgres-pgpass",
      secret: {
        defaultMode: 288,
        items: [{ key: "pgpass", path: "pgpass" }],
        secretName: "agentos-postgres-app",
      },
    });
    expect(pod.volumes).toContainEqual({
      name: "existing-runtime",
      configMap: { name: "existing-runtime" },
    });
  });

  test("keeps tool installation ahead of home preparation when CNPG is composed with Kustomize", async () => {
    const resources = await render(
      join(runtime, "tests", "fixtures", "cloudnative-pg"),
    );
    const statefulSet = resource(resources, "StatefulSet", "agentos-firstmate");

    expect(
      statefulSet.spec!.template.spec.initContainers.map(
        ({ name }: { name: string }) => name,
      ),
    ).toEqual(["install-tools", "prepare-home"]);
  });

  test("mounts GitHub App identity only into the First Mate runtime", async () => {
    const resources = await render(join(runtime, "base"));
    const original = resource(resources, "StatefulSet", "agentos-firstmate");
    const live = structuredClone(original);
    const livePod = live.spec!.template.spec;
    livePod.volumes = [
      { name: "existing-runtime", configMap: { name: "existing-runtime" } },
    ];

    const statefulSet = await applyStrategicPatch(
      live,
      join(runtime, "patches", "github-app.yaml"),
    );
    const pod = statefulSet.spec!.template.spec;
    const firstmate = pod.containers[0];
    const environment = Object.fromEntries(
      firstmate.env.map(
        ({ name, value, valueFrom }: Record<string, unknown>) => [
          name,
          value ?? valueFrom,
        ],
      ),
    );

    expect(pod.initContainers.every((container: Record<string, any>) =>
      !(container.volumeMounts ?? []).some(
        (mount: Record<string, string>) => mount.name === "github-app",
      ),
    )).toBe(true);
    expect(firstmate.volumeMounts).toContainEqual({
      mountPath: "/var/run/secrets/agentos/github",
      name: "github-app",
      readOnly: true,
    });
    expect(environment).toMatchObject({
      GITHUB_APP_ID: {
        secretKeyRef: { key: "app-id", name: "agentos-github-app" },
      },
      GITHUB_APP_INSTALLATION_ID: {
        secretKeyRef: {
          key: "installation-id",
          name: "agentos-github-app",
        },
      },
      GITHUB_APP_PRIVATE_KEY_FILE:
        "/var/run/secrets/agentos/github/private-key.pem",
    });
    expect(pod.volumes).toContainEqual({
      name: "github-app",
      secret: {
        defaultMode: 288,
        items: [{ key: "private-key.pem", path: "private-key.pem" }],
        secretName: "agentos-github-app",
      },
    });
    expect(pod.volumes).toContainEqual({
      name: "existing-runtime",
      configMap: { name: "existing-runtime" },
    });
  });
});
