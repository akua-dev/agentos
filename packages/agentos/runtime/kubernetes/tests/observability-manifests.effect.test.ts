import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { fileURLToPath } from "node:url";

import { renderKustomize } from "../../../../../tooling/testing/kubernetes.ts";

const Environment = Schema.Struct({
  name: Schema.String,
  value: Schema.optional(Schema.String),
  valueFrom: Schema.optional(Schema.Struct({
    fieldRef: Schema.optional(Schema.Struct({ fieldPath: Schema.String })),
  })),
});
type Environment = typeof Environment.Type;
const Workload = Schema.Struct({
  kind: Schema.Literal("StatefulSet"),
  metadata: Schema.Struct({ name: Schema.String }),
  spec: Schema.Struct({
    template: Schema.Struct({
      metadata: Schema.Struct({
        labels: Schema.Record(Schema.String, Schema.String),
      }),
      spec: Schema.Struct({
        containers: Schema.Array(Schema.Struct({
          name: Schema.String,
          env: Schema.optional(Schema.Array(Environment)),
          livenessProbe: Schema.optional(Schema.Unknown),
          readinessProbe: Schema.optional(Schema.Unknown),
        })),
      }),
    }),
  }),
});
const Resource = Schema.Struct({
  kind: Schema.String,
  metadata: Schema.Struct({ name: Schema.String }),
  spec: Schema.optional(Schema.Unknown),
});
const Resources = Schema.Array(Resource);

class ManifestFixtureError extends Schema.TaggedErrorClass<ManifestFixtureError>()(
  "ManifestFixtureError",
  { detail: Schema.String },
) {}

const required = Effect.fn("test.observabilityManifest.required")(
  function*<A>(value: A | undefined, detail: string) {
    if (value === undefined) return yield* ManifestFixtureError.make({ detail });
    return value;
  },
);

function environment(values: ReadonlyArray<Environment>) {
  return Object.fromEntries(values.map((value) => [value.name, value]));
}

function containsText(value: unknown, text: string): boolean {
  if (typeof value === "string") return value.includes(text);
  if (Array.isArray(value)) {
    return value.some((entry) => containsText(entry, text));
  }
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).some((entry) => containsText(entry, text));
}

const repository = fileURLToPath(new URL("../../../../..", import.meta.url));
const workloads = [
  {
    directory: "packages/agentos/resources/roles/firstmate/kubernetes/base",
    name: "agentos-firstmate",
    serviceName: "agentos-$(AGENTOS_AGENT_NAME)",
    workloadName: "agentos-$(AGENTOS_AGENT_NAME)",
    runtime: "pi",
    runtimeVersion: "0.81.1",
  },
  {
    directory: "packages/agentos/resources/roles/secondmate/kubernetes/base",
    name: "agentos-secondmate",
    serviceName: "agentos-$(AGENTOS_AGENT_NAME)",
    workloadName: "agentos-$(AGENTOS_AGENT_NAME)",
    runtime: "pi",
    runtimeVersion: "0.81.1",
  },
  {
    directory: "packages/agentos/resources/crewmates/default/kubernetes/base",
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
];

const render = Effect.fn("test.observabilityManifest.render")(function*(
  directory: string,
) {
  const documents = yield* renderKustomize(`${repository}/${directory}`);
  return yield* Schema.decodeUnknownEffect(Resources)(documents);
});

describe("Fleet OTEL workload contract", () => {
  for (const workload of workloads) {
    it.effect(`configures ${workload.name} without coupling health to telemetry`, () =>
      Effect.gen(function*() {
        const resources = yield* render(workload.directory);
        const stateful = yield* required(
          resources.find(({ kind, metadata }) =>
            kind === "StatefulSet" && metadata.name === workload.name
          ),
          `Missing StatefulSet/${workload.name}`,
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Workload)));
        const pod = stateful.spec.template;
        assert.strictEqual(
          pod.metadata.labels["agentos.akua.dev/otel-client"],
          "true",
        );

        const container = yield* required(
          pod.spec.containers[0],
          `Missing container for ${workload.name}`,
        );
        const variables = environment(container.env ?? []);
        assert.strictEqual(variables.OTEL_SERVICE_NAME?.value, workload.serviceName);
        assert.strictEqual(
          variables.OTEL_EXPORTER_OTLP_ENDPOINT?.value,
          "http://agentos-otel-collector.agentos.svc.cluster.local:4318",
        );
        assert.strictEqual(variables.OTEL_EXPORTER_OTLP_PROTOCOL?.value, "http/protobuf");
        assert.strictEqual(variables.OTEL_EXPORTER_OTLP_COMPRESSION?.value, "gzip");
        assert.strictEqual(variables.OTEL_EXPORTER_OTLP_TIMEOUT?.value, "5000");
        assert.strictEqual(variables.OTEL_PROPAGATORS?.value, "tracecontext,baggage");
        assert.strictEqual(
          variables.OTEL_TRACES_SAMPLER?.value,
          "parentbased_traceidratio",
        );
        assert.strictEqual(variables.OTEL_TRACES_SAMPLER_ARG?.value, "1");
        assert.strictEqual(variables.OTEL_TRACES_EXPORTER?.value, "otlp");
        assert.strictEqual(variables.OTEL_METRICS_EXPORTER?.value, "otlp");
        assert.strictEqual(variables.OTEL_LOGS_EXPORTER?.value, "otlp");
        assert.strictEqual(variables.OTEL_SDK_DISABLED?.value, "false");
        assert.strictEqual(
          variables.K8S_NAMESPACE?.valueFrom?.fieldRef?.fieldPath,
          "metadata.namespace",
        );
        assert.strictEqual(
          variables.K8S_POD_NAME?.valueFrom?.fieldRef?.fieldPath,
          "metadata.name",
        );
        assert.strictEqual(
          variables.AGENTOS_VERSION?.valueFrom?.fieldRef?.fieldPath,
          "metadata.labels['app.kubernetes.io/version']",
        );
        assert.strictEqual(variables.K8S_CONTAINER_NAME?.value, container.name);
        const attributes = variables.OTEL_RESOURCE_ATTRIBUTES?.value ?? "";
        assert.include(attributes, "service.namespace=agentos");
        assert.include(attributes, "service.version=$(AGENTOS_VERSION)");
        if ("runtime" in workload) {
          assert.include(attributes, "agentos.ai.runtime=$(AGENTOS_AI_RUNTIME)");
          assert.include(
            attributes,
            "agentos.ai.runtime.version=$(AGENTOS_AI_RUNTIME_VERSION)",
          );
          assert.strictEqual(variables.AGENTOS_AI_RUNTIME?.value, workload.runtime);
          assert.strictEqual(
            variables.AGENTOS_AI_RUNTIME_VERSION?.value,
            workload.runtimeVersion,
          );
        }
        assert.include(attributes, "k8s.namespace.name=$(K8S_NAMESPACE)");
        assert.include(attributes, "k8s.pod.name=$(K8S_POD_NAME)");
        assert.include(attributes, "k8s.container.name=$(K8S_CONTAINER_NAME)");
        assert.include(attributes, `k8s.workload.name=${workload.workloadName}`);
        assert.isFalse(
          containsText(container.livenessProbe, "agentos-otel-collector"),
        );
        assert.isFalse(
          containsText(container.readinessProbe, "agentos-otel-collector"),
        );
      }).pipe(Effect.provide(BunServices.layer)));
  }
});
