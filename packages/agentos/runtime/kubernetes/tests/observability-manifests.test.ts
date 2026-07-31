import { describe, expect, test } from "bun:test";

type Environment = {
  name: string;
  value?: string;
  valueFrom?: {
    fieldRef?: {
      fieldPath: string;
    };
  };
};

type Resource = {
  kind: string;
  metadata: { name: string };
  spec?: {
    template: {
      metadata: { labels: Record<string, string> };
      spec: {
        containers: Array<{
          name: string;
          env?: Environment[];
          livenessProbe?: unknown;
          readinessProbe?: unknown;
        }>;
      };
    };
  };
};

const repository = new URL("../../../../..", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

const workloads = [
  {
    directory:
      "packages/agentos/resources/roles/firstmate/kubernetes/base",
    name: "agentos-firstmate",
    serviceName: "agentos-$(AGENTOS_AGENT_NAME)",
    workloadName: "agentos-$(AGENTOS_AGENT_NAME)",
    runtime: "pi",
    runtimeVersion: "0.81.1",
  },
  {
    directory:
      "packages/agentos/resources/roles/secondmate/kubernetes/base",
    name: "agentos-secondmate",
    serviceName: "agentos-$(AGENTOS_AGENT_NAME)",
    workloadName: "agentos-$(AGENTOS_AGENT_NAME)",
    runtime: "pi",
    runtimeVersion: "0.81.1",
  },
  {
    directory:
      "packages/agentos/resources/crewmates/default/kubernetes/base",
    name: "agentos-crewmate",
    serviceName: "agentos-$(AGENTOS_AGENT_NAME)",
    workloadName: "agentos-$(AGENTOS_AGENT_NAME)",
    runtime: "codex",
    runtimeVersion: "0.144.5",
  },
  {
    directory: "services/ai-gateway/kubernetes",
    name: "ai-gateway",
    serviceName: "agentos-ai-gateway",
    workloadName: "ai-gateway",
  },
] as const;

async function render(directory: string): Promise<Resource[]> {
  const child = Bun.spawn(["kubectl", "kustomize", `${repository}/${directory}`], {
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

function statefulSet(resources: Resource[], name: string): Resource {
  const found = resources.find(
    (resource) =>
      resource.kind === "StatefulSet" && resource.metadata.name === name,
  );
  if (!found?.spec) throw new Error(`Missing StatefulSet/${name}`);
  return found;
}

function environment(
  values: Environment[],
): Record<string, Environment> {
  return Object.fromEntries(values.map((value) => [value.name, value]));
}

describe("Fleet OTEL workload contract", () => {
  for (const workload of workloads) {
    test(`configures ${workload.name} without coupling health to telemetry`, async () => {
      const resources = await render(workload.directory);
      const stateful = statefulSet(resources, workload.name);
      const pod = stateful.spec!.template;
      expect(pod.metadata.labels["agentos.akua.dev/otel-client"]).toBe(
        "true",
      );

      const container = pod.spec.containers[0]!;
      const env = environment(container.env ?? []);
      expect(env.OTEL_SERVICE_NAME?.value).toBe(workload.serviceName);
      expect(env.OTEL_EXPORTER_OTLP_ENDPOINT?.value).toBe(
        "http://agentos-otel-collector:4318",
      );
      expect(env.OTEL_EXPORTER_OTLP_PROTOCOL?.value).toBe("http/protobuf");
      expect(env.OTEL_EXPORTER_OTLP_COMPRESSION?.value).toBe("gzip");
      expect(env.OTEL_EXPORTER_OTLP_TIMEOUT?.value).toBe("5000");
      expect(env.OTEL_PROPAGATORS?.value).toBe("tracecontext,baggage");
      expect(env.OTEL_TRACES_SAMPLER?.value).toBe(
        "parentbased_traceidratio",
      );
      expect(env.OTEL_TRACES_SAMPLER_ARG?.value).toBe("1");
      expect(env.OTEL_TRACES_EXPORTER?.value).toBe("otlp");
      expect(env.OTEL_METRICS_EXPORTER?.value).toBe("otlp");
      expect(env.OTEL_LOGS_EXPORTER?.value).toBe("otlp");
      expect(env.OTEL_SDK_DISABLED?.value).toBe("false");
      expect(env.K8S_NAMESPACE?.valueFrom?.fieldRef?.fieldPath).toBe(
        "metadata.namespace",
      );
      expect(env.K8S_POD_NAME?.valueFrom?.fieldRef?.fieldPath).toBe(
        "metadata.name",
      );
      expect(env.AGENTOS_VERSION?.valueFrom?.fieldRef?.fieldPath).toBe(
        "metadata.labels['app.kubernetes.io/version']",
      );
      expect(env.K8S_CONTAINER_NAME?.value).toBe(container.name);
      expect(env.OTEL_RESOURCE_ATTRIBUTES?.value).toContain(
        "service.namespace=agentos",
      );
      expect(env.OTEL_RESOURCE_ATTRIBUTES?.value).toContain(
        "service.version=$(AGENTOS_VERSION)",
      );
      if ("runtime" in workload) {
        expect(env.OTEL_RESOURCE_ATTRIBUTES?.value).toContain(
          "agentos.ai.runtime=$(AGENTOS_AI_RUNTIME)",
        );
        expect(env.OTEL_RESOURCE_ATTRIBUTES?.value).toContain(
          "agentos.ai.runtime.version=$(AGENTOS_AI_RUNTIME_VERSION)",
        );
        expect(env.AGENTOS_AI_RUNTIME?.value).toBe(workload.runtime);
        expect(env.AGENTOS_AI_RUNTIME_VERSION?.value).toBe(
          workload.runtimeVersion,
        );
      }
      expect(env.OTEL_RESOURCE_ATTRIBUTES?.value).toContain(
        "k8s.namespace.name=$(K8S_NAMESPACE)",
      );
      expect(env.OTEL_RESOURCE_ATTRIBUTES?.value).toContain(
        "k8s.pod.name=$(K8S_POD_NAME)",
      );
      expect(env.OTEL_RESOURCE_ATTRIBUTES?.value).toContain(
        "k8s.container.name=$(K8S_CONTAINER_NAME)",
      );
      expect(env.OTEL_RESOURCE_ATTRIBUTES?.value).toContain(
        `k8s.workload.name=${workload.workloadName}`,
      );

      expect(JSON.stringify(container.livenessProbe)).not.toContain(
        "agentos-otel-collector",
      );
      expect(JSON.stringify(container.readinessProbe)).not.toContain(
        "agentos-otel-collector",
      );
    });
  }
});
