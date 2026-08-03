import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import {
  Clock,
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Path,
  Random,
  Schema,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

const collectorImage =
  "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6";
const busyboxImage =
  "docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const kindNodeImage =
  "kindest/node@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5";
const repositoryUrl = new URL("../../..", import.meta.url);

const platform = Layer.mergeAll(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

class KubernetesSmokeError extends Schema.TaggedErrorClass<KubernetesSmokeError>()(
  "KubernetesSmokeError",
  {
    operation: Schema.Literals(["docker", "kind", "kubectl"]),
    command: Schema.String,
    detail: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
  },
) {}

const commandError = (
  operation: typeof KubernetesSmokeError.fields.operation.Type,
  command: string,
  exitCode?: number,
  detail?: string,
) => KubernetesSmokeError.make({ operation, command, detail, exitCode });

const run = Effect.fn("test.otelKubernetes.command")(function*(
  operation: typeof KubernetesSmokeError.fields.operation.Type,
  executable: string,
  arguments_: ReadonlyArray<string>,
  input?: string,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(executable, Array.from(arguments_), {
      stdin: input === undefined
        ? "ignore"
        : Stream.make(new TextEncoder().encode(input)),
      stderr: "pipe",
      stdout: "pipe",
    }).pipe(
      Effect.mapError(() => commandError(operation, executable)),
    );
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  }));
});

const requireCommand = Effect.fn("test.otelKubernetes.requireCommand")(
  function*(
    operation: typeof KubernetesSmokeError.fields.operation.Type,
    executable: string,
    arguments_: ReadonlyArray<string>,
    input?: string,
  ) {
    const result = yield* run(operation, executable, arguments_, input);
    if (result.exitCode !== 0) {
      return yield* commandError(
        operation,
        `${executable} ${arguments_.join(" ")}`,
        result.exitCode,
        [result.stderr, result.stdout].filter((value) => value.length > 0).join("\n"),
      );
    }
    return result.stdout;
  },
);

function tracePayload(runtime: "ai_gateway" | "codex" | "pi") {
  return JSON.stringify({
    resourceSpans: [{
      resource: {
        attributes: [{
          key: "service.name",
          value: { stringValue: `agentos-${runtime}-smoke` },
        }],
      },
      scopeSpans: [{
        scope: { name: "agentos-kubernetes-smoke" },
        spans: [{
          traceId: "00000000000000000000000000000001",
          spanId: "0000000000000001",
          name: "agentos.ai.inference",
          kind: 1,
          startTimeUnixNano: "1000000000",
          endTimeUnixNano: "2000000000",
          attributes: [{
            key: "agentos.ai.runtime",
            value: { stringValue: runtime },
          }],
          status: { code: 1 },
        }],
      }],
    }],
  });
}

function metricPayload(runtime: "ai_gateway" | "codex" | "pi") {
  return JSON.stringify({
    resourceMetrics: [{
      resource: {
        attributes: [{
          key: "service.name",
          value: { stringValue: `agentos-${runtime}-smoke` },
        }],
      },
      scopeMetrics: [{
        scope: { name: "agentos-kubernetes-smoke" },
        metrics: [{
          name: "agentos.ai.operations",
          unit: "{operation}",
          gauge: {
            dataPoints: [{
              attributes: [{
                key: "agentos.ai.runtime",
                value: { stringValue: runtime },
              }],
              timeUnixNano: "2000000000",
              asDouble: 1,
            }],
          },
        }],
      }],
    }],
  });
}

function logPayload(runtime: "ai_gateway" | "codex" | "pi") {
  return JSON.stringify({
    resourceLogs: [{
      resource: {
        attributes: [{
          key: "service.name",
          value: { stringValue: `agentos-${runtime}-smoke` },
        }],
      },
      scopeLogs: [{
        scope: { name: "agentos-kubernetes-smoke" },
        logRecords: [{
          timeUnixNano: "2000000000",
          observedTimeUnixNano: "2000000000",
          severityNumber: 9,
          severityText: "INFO",
          traceId: "00000000000000000000000000000001",
          spanId: "0000000000000001",
          eventName: "ai_gateway_failure",
          body: { stringValue: "" },
          attributes: [{
            key: "agentos.ai.runtime",
            value: { stringValue: runtime },
          }],
        }],
      }],
    }],
  });
}

function senderJob(
  name: string,
  runtime: "ai_gateway" | "codex" | "pi",
) {
  const endpoint = "http://agentos-otel-collector:4318/v1";
  const send = (signal: string, payload: string) =>
    `wget -qO- --header='Content-Type: application/json' --post-data=${
      JSON.stringify(payload)
    } '${endpoint}/${signal}' >/dev/null`;
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: "agentos" },
    spec: {
      backoffLimit: 1,
      template: {
        metadata: {
          labels: { "agentos.akua.dev/otel-client": "true" },
        },
        spec: {
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65534,
            runAsGroup: 65534,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [{
            name: "sender",
            image: busyboxImage,
            imagePullPolicy: "IfNotPresent",
            command: ["sh", "-ec"],
            args: [[
              send("traces", tracePayload(runtime)),
              send("metrics", metricPayload(runtime)),
              send("logs", logPayload(runtime)),
            ].join("\n")],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
          }],
        },
      },
    },
  };
}

function smokeResources() {
  return {
    apiVersion: "v1",
    kind: "List",
    items: [{
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "agentos-inference-smoke", namespace: "agentos" },
      data: { "index.html": "inference-ok\n" },
    }, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "agentos-inference-smoke", namespace: "agentos" },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "agentos-inference-smoke" } },
        template: {
          metadata: { labels: { app: "agentos-inference-smoke" } },
          spec: {
            automountServiceAccountToken: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 65534,
              runAsGroup: 65534,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [{
              name: "inference",
              image: busyboxImage,
              imagePullPolicy: "IfNotPresent",
              command: ["httpd", "-f", "-p", "8080", "-h", "/www"],
              ports: [{ name: "http", containerPort: 8080 }],
              readinessProbe: {
                httpGet: { path: "/", port: "http" },
                periodSeconds: 1,
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              volumeMounts: [{
                name: "content",
                mountPath: "/www",
                readOnly: true,
              }],
            }],
            volumes: [{
              name: "content",
              configMap: { name: "agentos-inference-smoke" },
            }],
          },
        },
      },
    }, senderJob("agentos-pi-otel-smoke", "pi"),
    senderJob("agentos-codex-otel-smoke", "codex"),
    senderJob("agentos-ai-gateway-otel-smoke", "ai_gateway"), {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: "agentos-otel-admin-smoke", namespace: "agentos" },
      spec: {
        backoffLimit: 1,
        template: {
          metadata: {
            labels: { "agentos.akua.dev/observability-admin": "true" },
          },
          spec: {
            automountServiceAccountToken: false,
            restartPolicy: "Never",
            containers: [{
              name: "admin",
              image: busyboxImage,
              imagePullPolicy: "IfNotPresent",
              command: ["sh", "-ec"],
              args: [
                "test \"$(wget -qO- http://agentos-otel-collector:13133/healthz)\" = '{\"status\":\"ok\"}'\nwget -qO- http://agentos-otel-collector:8888/metrics | grep -q otelcol_process_uptime",
              ],
            }],
          },
        },
      },
    }],
  };
}

layer(platform, { excludeTestServices: true })(
  "Fleet Collector Kubernetes smoke",
  (it) => {
    it.effect(
      "accepts every signal, preserves inference, and reattaches the retained PVC",
      () => Effect.gen(function*() {
        const enabled = yield* Config.boolean("AGENTOS_RUN_OTEL_K8S_E2E").pipe(
          Config.withDefault(false),
        );
        if (!enabled) return;
        const kind = yield* Config.string("AGENTOS_KIND_BIN").pipe(
          Config.withDefault("kind"),
        );
        const kubectl = yield* Config.string("AGENTOS_KUBECTL_BIN").pipe(
          Config.withDefault("kubectl"),
        );
        const suffix = `${(yield* Clock.currentTimeMillis).toString(36).slice(-5)}${
          Math.abs(yield* Random.nextInt).toString(36).slice(-3)
        }`;
        const cluster = `agentos-otel-${suffix}`;
        const context = `kind-${cluster}`;
        const collectorLoadImage =
          `ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib:agentos-kind-${suffix}`;
        const busyboxLoadImage = `busybox:agentos-kind-${suffix}`;
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const repositoryRoot = yield* paths.fromFileUrl(repositoryUrl);
        const collectorBase = paths.join(
          repositoryRoot,
          "services",
          "otel-collector",
          "kubernetes",
          "base",
        );
        const archiveDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "agentos-otel-kind-",
        });
        const imageArchive = paths.join(archiveDirectory, "images.tar");
        const kube = (arguments_: ReadonlyArray<string>, input?: string) =>
          requireCommand(
            "kubectl",
            kubectl,
            ["--context", context, ...arguments_],
            input,
          );
        const cleanup = Effect.gen(function*() {
          yield* requireCommand(
            "kind",
            kind,
            ["delete", "cluster", "--name", cluster],
          ).pipe(Effect.ignore);
          yield* requireCommand("docker", "docker", [
            "image",
            "rm",
            collectorLoadImage,
            busyboxLoadImage,
          ]).pipe(Effect.ignore);
        });

        const evidence = yield* Effect.gen(function*() {
          yield* requireCommand("docker", "docker", ["pull", "--quiet", collectorImage]);
          yield* requireCommand("docker", "docker", ["pull", "--quiet", busyboxImage]);
          yield* requireCommand("docker", "docker", [
            "tag",
            collectorImage,
            collectorLoadImage,
          ]);
          yield* requireCommand("docker", "docker", [
            "tag",
            busyboxImage,
            busyboxLoadImage,
          ]);
          const dockerArchitecture = (yield* requireCommand(
            "docker",
            "docker",
            ["info", "--format", "{{.Architecture}}"],
          )).trim();
          const imageArchitecture = dockerArchitecture === "aarch64"
            ? "arm64"
            : dockerArchitecture === "x86_64"
            ? "amd64"
            : dockerArchitecture;
          yield* requireCommand("docker", "docker", [
            "image",
            "save",
            "--platform",
            `linux/${imageArchitecture}`,
            "--output",
            imageArchive,
            collectorLoadImage,
            busyboxLoadImage,
          ]);
          yield* requireCommand("kind", kind, [
            "create",
            "cluster",
            "--name",
            cluster,
            "--image",
            kindNodeImage,
            "--wait",
            "180s",
          ]);
          yield* requireCommand("kind", kind, [
            "load",
            "image-archive",
            imageArchive,
            "--name",
            cluster,
          ]);
          yield* kube(["create", "namespace", "agentos"]);
          yield* kube([
            "label",
            "namespace",
            "agentos",
            "agentos.akua.dev/fleet=default",
            "--overwrite",
          ]);
          yield* kube(["apply", "-k", collectorBase]);
          yield* kube(["apply", "-f", "-"], JSON.stringify(smokeResources()));
          yield* kube([
            "--namespace",
            "agentos",
            "rollout",
            "status",
            "statefulset/agentos-otel-collector",
            "--timeout=180s",
          ]);
          yield* kube([
            "--namespace",
            "agentos",
            "rollout",
            "status",
            "deployment/agentos-inference-smoke",
            "--timeout=120s",
          ]);
          for (const job of [
            "agentos-pi-otel-smoke",
            "agentos-codex-otel-smoke",
            "agentos-ai-gateway-otel-smoke",
            "agentos-otel-admin-smoke",
          ]) {
            yield* kube([
              "--namespace",
              "agentos",
              "wait",
              "--for=condition=complete",
              `job/${job}`,
              "--timeout=120s",
            ]);
          }
          const pvcBefore = (yield* kube([
            "--namespace",
            "agentos",
            "get",
            "persistentvolumeclaim/storage-agentos-otel-collector-0",
            "--output=jsonpath={.metadata.uid}",
          ])).trim();
          assert.isNotEmpty(pvcBefore);
          yield* kube([
            "--namespace",
            "agentos",
            "scale",
            "statefulset/agentos-otel-collector",
            "--replicas=0",
          ]);
          yield* kube([
            "--namespace",
            "agentos",
            "wait",
            "--for=delete",
            "pod/agentos-otel-collector-0",
            "--timeout=120s",
          ]);
          const inferenceWhileCollectorIsAbsent = (yield* kube([
            "--namespace",
            "agentos",
            "exec",
            "deployment/agentos-inference-smoke",
            "--",
            "wget",
            "-qO-",
            "http://127.0.0.1:8080/",
          ])).trim();
          assert.strictEqual(inferenceWhileCollectorIsAbsent, "inference-ok");
          yield* kube([
            "--namespace",
            "agentos",
            "scale",
            "statefulset/agentos-otel-collector",
            "--replicas=1",
          ]);
          yield* kube([
            "--namespace",
            "agentos",
            "rollout",
            "status",
            "statefulset/agentos-otel-collector",
            "--timeout=180s",
          ]);
          const pvcAfter = (yield* kube([
            "--namespace",
            "agentos",
            "get",
            "persistentvolumeclaim/storage-agentos-otel-collector-0",
            "--output=jsonpath={.metadata.uid}",
          ])).trim();
          assert.strictEqual(pvcAfter, pvcBefore);
          const recovered = senderJob(
            "agentos-recovered-otel-smoke",
            "pi",
          );
          yield* kube(["apply", "-f", "-"], JSON.stringify(recovered));
          yield* kube([
            "--namespace",
            "agentos",
            "wait",
            "--for=condition=complete",
            "job/agentos-recovered-otel-smoke",
            "--timeout=120s",
          ]);
          return { context, pvcAfter, pvcBefore };
        }).pipe(Effect.ensuring(cleanup));

        assert.strictEqual(evidence.pvcAfter, evidence.pvcBefore);
        const clusters = yield* requireCommand("kind", kind, ["get", "clusters"]);
        assert.notInclude(clusters.split("\n"), cluster);
      }),
      360_000,
    );
  },
);
