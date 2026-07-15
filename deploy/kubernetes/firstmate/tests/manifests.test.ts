import { describe, expect, test } from "bun:test";
import { join } from "node:path";

type Resource = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
  spec?: Record<string, any>;
  roleRef?: Record<string, any>;
  subjects?: Array<Record<string, any>>;
};

const runtime = new URL("..", import.meta.url).pathname;

async function render(directory: string): Promise<Resource[]> {
  const child = Bun.spawn(["kubectl", "kustomize", directory], {
    stderr: "pipe",
    stdout: "pipe",
  });
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
    expect(pod.securityContext).toEqual({
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.initContainers).toHaveLength(1);
    expect(pod.containers).toHaveLength(1);
    const init = pod.initContainers[0];
    const firstmate = pod.containers[0];
    expect(init.image).toBe("agentos-firstmate:dev");
    expect(firstmate.image).toBe(init.image);
    expect(init.volumeMounts).toEqual([{ mountPath: "/home/agent", name: "home" }]);
    expect(firstmate.volumeMounts).toEqual(init.volumeMounts);
    expect(init.command).toEqual([
      "/opt/agentos/deploy/kubernetes/firstmate/bin/prepare-home.sh",
    ]);
    expect(firstmate.command).toEqual([
      "/opt/agentos/deploy/kubernetes/firstmate/bin/run-firstmate.sh",
    ]);
    expect(firstmate.livenessProbe.exec.command).toEqual([
      "/opt/agentos/deploy/kubernetes/firstmate/bin/health.sh",
      "live",
    ]);
    expect(firstmate.readinessProbe.exec.command).toEqual([
      "/opt/agentos/deploy/kubernetes/firstmate/bin/health.sh",
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
});
