import { describe, expect, test } from "bun:test";

type Resource = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
  };
  rules?: Array<Record<string, unknown>>;
  roleRef?: Record<string, string>;
  subjects?: Array<Record<string, string>>;
  spec?: Record<string, any>;
};

const kubernetesDirectory = new URL("..", import.meta.url).pathname;
const baseDirectory = `${kubernetesDirectory}/base`;
const remoteDirectory = `${kubernetesDirectory}/overlays/remote`;
const localDirectory = `${kubernetesDirectory}/overlays/local-diagnostics`;

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

function resource(
  resources: Resource[],
  kind: string,
  name: string,
): Resource {
  const found = resources.find(
    (candidate) =>
      candidate.kind === kind && candidate.metadata.name === name,
  );
  if (!found) throw new Error(`Missing ${kind}/${name}`);
  return found;
}

function config(resources: Resource[]): string {
  const configMap = resource(
    resources,
    "ConfigMap",
    "agentos-otel-collector",
  );
  const value = (configMap as Resource & {
    data?: Record<string, string>;
  }).data?.["collector.yaml"];
  if (!value) throw new Error("Missing collector.yaml");
  return value;
}

describe("Fleet OpenTelemetry Collector", () => {
  test("renders a standalone private Collector with retained storage", async () => {
    const resources = await render(baseDirectory);
    expect(
      resources
        .map(({ kind, metadata }) => `${kind}/${metadata.name}`)
        .sort(),
    ).toEqual([
      "ClusterRole/agentos-otel-collector",
      "ClusterRoleBinding/agentos-otel-collector",
      "ConfigMap/agentos-otel-collector",
      "NetworkPolicy/agentos-otel-collector",
      "Service/agentos-otel-collector",
      "ServiceAccount/agentos-otel-collector",
      "StatefulSet/agentos-otel-collector",
    ]);

    const service = resource(
      resources,
      "Service",
      "agentos-otel-collector",
    ).spec!;
    expect(service.type).toBe("ClusterIP");
    expect(service.selector).toEqual({
      "app.kubernetes.io/name": "agentos-otel-collector",
    });
    expect(service.ports).toEqual([
      {
        name: "otlp-grpc",
        port: 4317,
        protocol: "TCP",
        targetPort: "otlp-grpc",
      },
      {
        name: "otlp-http",
        port: 4318,
        protocol: "TCP",
        targetPort: "otlp-http",
      },
    ]);

    const statefulSet = resource(
      resources,
      "StatefulSet",
      "agentos-otel-collector",
    ).spec!;
    expect(statefulSet.replicas).toBe(1);
    expect(statefulSet.serviceName).toBe("agentos-otel-collector");
    expect(statefulSet.persistentVolumeClaimRetentionPolicy).toEqual({
      whenDeleted: "Retain",
      whenScaled: "Retain",
    });
    expect(statefulSet.volumeClaimTemplates).toEqual([
      {
        metadata: { name: "storage" },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: "5Gi" } },
        },
      },
    ]);

    const pod = statefulSet.template.spec;
    expect(pod.serviceAccountName).toBe("agentos-otel-collector");
    expect(pod.automountServiceAccountToken).toBe(true);
    expect(pod.securityContext).toEqual({
      fsGroup: 10001,
      fsGroupChangePolicy: "OnRootMismatch",
      runAsGroup: 10001,
      runAsNonRoot: true,
      runAsUser: 10001,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.containers).toHaveLength(1);
    const collector = pod.containers[0];
    expect(collector.image).toBe(
      "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6",
    );
    expect(collector.args).toEqual([
      "--config=file:/etc/otelcol/collector.yaml",
    ]);
    expect(collector.ports).toEqual([
      { containerPort: 4317, name: "otlp-grpc", protocol: "TCP" },
      { containerPort: 4318, name: "otlp-http", protocol: "TCP" },
      { containerPort: 13133, name: "health", protocol: "TCP" },
    ]);
    expect(collector.livenessProbe.httpGet).toEqual({
      path: "/",
      port: "health",
    });
    expect(collector.readinessProbe.httpGet).toEqual({
      path: "/",
      port: "health",
    });
    expect(collector.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      readOnlyRootFilesystem: true,
    });
    expect(collector.volumeMounts).toEqual([
      {
        mountPath: "/etc/otelcol",
        name: "config",
        readOnly: true,
      },
      {
        mountPath: "/var/lib/otelcol",
        name: "storage",
      },
    ]);
    expect(pod.volumes).toEqual([
      {
        configMap: { name: "agentos-otel-collector" },
        name: "config",
      },
    ]);
  });

  test("limits metadata RBAC and OTLP ingress to labeled AgentOS clients", async () => {
    const resources = await render(baseDirectory);
    const role = resource(
      resources,
      "ClusterRole",
      "agentos-otel-collector",
    );
    expect(role.rules).toEqual([
      {
        apiGroups: [""],
        resources: ["namespaces", "pods"],
        verbs: ["get", "list", "watch"],
      },
      {
        apiGroups: ["apps"],
        resources: ["daemonsets", "deployments", "replicasets", "statefulsets"],
        verbs: ["get", "list", "watch"],
      },
    ]);

    const policy = resource(
      resources,
      "NetworkPolicy",
      "agentos-otel-collector",
    ).spec!;
    expect(policy.podSelector).toEqual({
      matchLabels: {
        "app.kubernetes.io/name": "agentos-otel-collector",
      },
    });
    expect(policy.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(policy.ingress).toEqual([
      {
        from: [
          {
            namespaceSelector: {
              matchLabels: {
                "agentos.akua.dev/fleet": "default",
              },
            },
            podSelector: {
              matchLabels: {
                "agentos.akua.dev/otel-client": "true",
              },
            },
          },
        ],
        ports: [
          { port: 4317, protocol: "TCP" },
          { port: 4318, protocol: "TCP" },
        ],
      },
    ]);
  });

  test("keeps remote credentials out of rendered manifests", async () => {
    const resources = await render(remoteDirectory);
    const rendered = JSON.stringify(resources);
    expect(rendered).toContain("agentos-otel-remote");
    expect(rendered).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(rendered).toContain("headers.yaml");
    expect(rendered).not.toContain("Bearer ");
    expect(rendered).not.toContain("api-key");
    expect(config(resources)).toContain("otlp_http/remote:");
    expect(config(resources)).toContain("storage: file_storage/queue");
    expect(config(resources)).not.toContain("file/local:");
    const statefulSet = resource(
      resources,
      "StatefulSet",
      "agentos-otel-collector",
    ).spec!;
    const collector = statefulSet.template.spec.containers[0];
    expect(collector.args).toEqual([
      "--config=file:/etc/otelcol/collector.yaml",
      "--config=file:/etc/otelcol-secret/headers.yaml",
    ]);
    expect(collector.volumeMounts).toContainEqual({
      mountPath: "/etc/otelcol-secret",
      name: "remote-headers",
      readOnly: true,
    });
  });

  test("enables a bounded local archive only in its explicit overlay", async () => {
    const base = await render(baseDirectory);
    const local = await render(localDirectory);
    expect(config(base)).not.toContain("file/local:");
    expect(config(local)).toContain("file/local:");
    expect(config(local)).toContain("max_megabytes: 32");
    expect(config(local)).toContain("max_backups: 8");
    expect(config(local)).toContain("max_days: 1");
  });
});
