import { describe, expect, test } from "bun:test";

type Resource = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec?: Record<string, any>;
};

const aiGatewayDirectory = new URL("..", import.meta.url).pathname;

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

describe("optional Fleet AI gateway", () => {
  test("renders one private non-root service with retained state and selected-client ingress", async () => {
    const resources = await render(aiGatewayDirectory);
    expect(resources.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort()).toEqual([
      "NetworkPolicy/ai-gateway",
      "Service/ai-gateway",
      "ServiceAccount/ai-gateway",
      "StatefulSet/ai-gateway",
    ]);

    const service = resource(resources, "Service", "ai-gateway");
    expect(service.spec).toEqual({
      ports: [{ name: "http", port: 8787, protocol: "TCP", targetPort: "http" }],
      selector: { "app.kubernetes.io/name": "ai-gateway" },
      type: "ClusterIP",
    });

    const statefulSet = resource(resources, "StatefulSet", "ai-gateway");
    const spec = statefulSet.spec!;
    expect(spec.replicas).toBe(1);
    expect(spec.serviceName).toBe("ai-gateway");
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
    expect(pod.initContainers).toEqual([
      {
        name: "state-permissions",
        image: "agentos:dev",
        imagePullPolicy: "Never",
        command: ["bun"],
        args: [
          "-e",
          'const { chmod, chown } = await import("node:fs/promises"); const path = "/var/lib/ai-gateway"; await chown(path, 0, 0); await chmod(path, 0o700); await chown(path, 1000, 1000);',
        ],
        volumeMounts: [{ mountPath: "/var/lib/ai-gateway", name: "state" }],
        securityContext: {
          allowPrivilegeEscalation: false,
          capabilities: { add: ["CHOWN"], drop: ["ALL"] },
          readOnlyRootFilesystem: true,
          runAsGroup: 0,
          runAsNonRoot: false,
          runAsUser: 0,
        },
      },
    ]);
    expect(pod.containers).toHaveLength(1);
    const container = pod.containers[0];
    expect(container.command).toEqual(["ai-gateway"]);
    expect(container.args).toEqual(["serve"]);
    expect(container.workingDir).toBeUndefined();
    expect(container.ports).toEqual([{ containerPort: 8787, name: "http", protocol: "TCP" }]);
    expect(container.volumeMounts).toEqual([{ mountPath: "/var/lib/ai-gateway", name: "state" }]);
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
    expect(environment.AI_GATEWAY_STATE_DIR).toBe("/var/lib/ai-gateway");
    expect(environment.AI_GATEWAY_TOKEN).toEqual({
      secretKeyRef: { key: "token", name: "ai-gateway-client" },
    });
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.AI_GATEWAY_ALLOW_API_KEY_FALLBACK).toBeUndefined();

    const policy = resource(resources, "NetworkPolicy", "ai-gateway");
    expect(policy.spec).toEqual({
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "agentos" },
              },
              podSelector: {
                matchLabels: { "agentos.akua.dev/ai-gateway-client": "true" },
              },
            },
          ],
          ports: [{ port: 8787, protocol: "TCP" }],
        },
      ],
      podSelector: { matchLabels: { "app.kubernetes.io/name": "ai-gateway" } },
      policyTypes: ["Ingress"],
    });
    expect(resources.filter(({ kind }) => ["Ingress", "Secret"].includes(kind))).toEqual([]);
  });
});
