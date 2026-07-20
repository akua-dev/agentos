import { describe, expect, test } from "bun:test";

type Resource = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec?: Record<string, any>;
};

const quotaRouterDirectory = new URL("..", import.meta.url).pathname;

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

function resource(resources: Resource[], kind: string, name: string): Resource {
  const value = resources.find(
    (candidate) => candidate.kind === kind && candidate.metadata.name === name,
  );
  if (!value) throw new Error(`Missing ${kind}/${name}`);
  return value;
}

describe("optional Fleet quota router", () => {
  test("renders one private non-root service with retained state and selected-client ingress", async () => {
    const resources = await render(quotaRouterDirectory);
    expect(resources.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort()).toEqual([
      "NetworkPolicy/quota-router",
      "Service/quota-router",
      "ServiceAccount/quota-router",
      "StatefulSet/quota-router",
    ]);

    const service = resource(resources, "Service", "quota-router");
    expect(service.spec).toEqual({
      ports: [{ name: "http", port: 8787, protocol: "TCP", targetPort: "http" }],
      selector: { "app.kubernetes.io/name": "quota-router" },
      type: "ClusterIP",
    });

    const statefulSet = resource(resources, "StatefulSet", "quota-router");
    const spec = statefulSet.spec!;
    expect(spec.replicas).toBe(1);
    expect(spec.serviceName).toBe("quota-router");
    expect(spec.persistentVolumeClaimRetentionPolicy).toEqual({
      whenDeleted: "Retain",
      whenScaled: "Retain",
    });
    expect(spec.volumeClaimTemplates).toEqual([
      {
        metadata: { name: "state" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "1Gi" } },
        },
      },
    ]);

    const pod = spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toEqual({
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.containers).toHaveLength(1);
    const container = pod.containers[0];
    expect(container.command).toEqual(["mise"]);
    expect(container.args).toEqual([
      "run",
      "--skip-tools",
      "quota-router:serve",
      "--",
      "serve",
    ]);
    expect(container.ports).toEqual([{ containerPort: 8787, name: "http", protocol: "TCP" }]);
    expect(container.volumeMounts).toEqual([{ mountPath: "/var/lib/quota-router", name: "state" }]);
    expect(container.livenessProbe.httpGet).toEqual({ path: "/healthz", port: "http" });
    expect(container.readinessProbe.httpGet).toEqual({ path: "/readyz", port: "http" });
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      readOnlyRootFilesystem: true,
    });
    const environment = Object.fromEntries(
      container.env.map((entry: { name: string; value?: string; valueFrom?: unknown }) => [
        entry.name,
        entry.value ?? entry.valueFrom,
      ]),
    );
    expect(environment.QUOTA_ROUTER_STATE_DIR).toBe("/var/lib/quota-router");
    expect(environment.QUOTA_ROUTER_TOKEN).toEqual({
      secretKeyRef: { key: "token", name: "quota-router-client" },
    });
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.QUOTA_ROUTER_ALLOW_API_KEY_FALLBACK).toBeUndefined();

    const policy = resource(resources, "NetworkPolicy", "quota-router");
    expect(policy.spec).toEqual({
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "agentos" },
              },
              podSelector: {
                matchLabels: { "agentos.akua.dev/quota-router-client": "true" },
              },
            },
          ],
          ports: [{ port: 8787, protocol: "TCP" }],
        },
      ],
      podSelector: { matchLabels: { "app.kubernetes.io/name": "quota-router" } },
      policyTypes: ["Ingress"],
    });
    expect(resources.filter(({ kind }) => ["Ingress", "Secret"].includes(kind))).toEqual([]);
  });
});
