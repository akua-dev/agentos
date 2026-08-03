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
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import {
  acquireBunTestServer,
  readWebRequestText,
} from "../../../tooling/testing/bun-http.ts";
import { acquireOtlpTestSink } from "./otlp-sink.ts";

const collectorImage =
  "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6";
const busyboxImage =
  "docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const kindNodeImage =
  "kindest/node@sha256:3489c7674813ba5d8b1a9977baea8a6e553784dab7b84759d1014dbd78f7ebd5";
const repositoryUrl = new URL("../../..", import.meta.url);
const codexVersion = "0.144.5";
const codexPromptMarker = "AGENTOS_CODEX_K8S_PROMPT_MUST_NOT_REACH_OTLP";
const codexResponseMarker = "AGENTOS_CODEX_K8S_RESPONSE_MUST_NOT_REACH_OTLP";
const codexCredentialMarker =
  "AGENTOS_CODEX_K8S_PROVIDER_CREDENTIAL_MUST_NOT_REACH_OTLP";
const codexExporterHeaderMarker =
  "AGENTOS_CODEX_K8S_EXPORTER_HEADER_MUST_NOT_REACH_OTLP";
const codexRequestId = "req_agentos_codex_k8s_61";

const platform = Layer.mergeAll(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

class KubernetesSmokeError extends Schema.TaggedErrorClass<KubernetesSmokeError>()(
  "KubernetesSmokeError",
  {
    operation: Schema.Literals(["docker", "git", "kind", "kubectl"]),
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

const waitFor = Effect.fn("test.otelKubernetes.waitFor")(function*<R>(
  operation: string,
  check: Effect.Effect<boolean, never, R>,
) {
  yield* check.pipe(
    Effect.flatMap((ready) =>
      ready
        ? Effect.void
        : Effect.fail(commandError("kubectl", operation, undefined, "timeout"))
    ),
    Effect.retry(Schedule.addDelay(
      Schedule.recurs(300),
      () => Effect.succeed("100 millis"),
    )),
  );
});

const codexSseResponse = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-agentos-k8s-61"}}\n',
  `event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","id":"msg-agentos-k8s-61","content":[{"type":"output_text","text":"${codexResponseMarker}"}]} }\n`,
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-agentos-k8s-61","usage":{"input_tokens":1,"input_tokens_details":null,"output_tokens":1,"output_tokens_details":null,"total_tokens":2}}}\n',
].join("\n") + "\n";

function codexInvocation(providerEndpoint: string) {
  return [
    "codex",
    "exec",
    "--skip-git-repo-check",
    "--model",
    "gpt-5.4",
    "-C",
    "/home/agent",
    "-c",
    'model_provider="agentos-fixture"',
    "-c",
    'model_providers.agentos-fixture.name="AgentOS fixture"',
    "-c",
    `model_providers.agentos-fixture.base_url="${providerEndpoint}/v1"`,
    "-c",
    'model_providers.agentos-fixture.env_key="AGENTOS_CODEX_FIXTURE_KEY"',
    "-c",
    'model_providers.agentos-fixture.wire_api="responses"',
    codexPromptMarker,
  ];
}

function codexSmokeResources(
  image: string,
  providerEndpoint: string,
) {
  const home = { name: "home", mountPath: "/home/agent" };
  const environment = [
    { name: "HOME", value: "/home/agent" },
    { name: "AGENTOS_RELEASE_ROOT", value: "/opt/agentos" },
    { name: "AGENTOS_AGENT_ROLE", value: "crewmate" },
    { name: "AGENTOS_AI_RUNTIME", value: "codex" },
    { name: "AGENTOS_AI_RUNTIME_VERSION", value: codexVersion },
    { name: "AGENTOS_CODEX_FIXTURE_KEY", value: codexCredentialMarker },
    { name: "MISE_DATA_DIR", value: "/home/agent/.local/share/mise" },
    { name: "MISE_LOCKED", value: "1" },
    { name: "MISE_SYSTEM_CONFIG_FILE", value: "/etc/mise/config.toml" },
    { name: "MISE_TRUSTED_CONFIG_PATHS", value: "/opt/agentos" },
    {
      name: "PATH",
      value:
        "/home/agent/.local/share/mise/shims:/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin",
    },
    {
      name: "OTEL_EXPORTER_OTLP_ENDPOINT",
      value: "http://agentos-otel-collector.agentos.svc.cluster.local:4318",
    },
    { name: "OTEL_EXPORTER_OTLP_PROTOCOL", value: "http/protobuf" },
    {
      name: "OTEL_EXPORTER_OTLP_HEADERS",
      value: `x-agentos-exporter-test=${codexExporterHeaderMarker}`,
    },
    { name: "OTEL_EXPORTER_OTLP_TIMEOUT", value: "100" },
    { name: "OTEL_LOGS_EXPORTER", value: "otlp" },
    { name: "OTEL_METRICS_EXPORTER", value: "otlp" },
    {
      name: "OTEL_RESOURCE_ATTRIBUTES",
      value:
        "deployment.environment.name=test,service.namespace=agentos,agentos.fleet.name=default",
    },
    { name: "OTEL_SDK_DISABLED", value: "false" },
    { name: "OTEL_TRACES_EXPORTER", value: "otlp" },
  ];
  const invocation = codexInvocation(providerEndpoint);
  const shell = [
    "set -eu",
    invocation.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" "),
    "touch /tmp/codex-turn-complete",
    "exec sleep 3600",
  ].join("\n");
  return {
    apiVersion: "v1",
    kind: "List",
    items: [{
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "agentos-codex-native-smoke", namespace: "agentos" },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "1Gi" } },
      },
    }, {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "agentos-codex-native-smoke", namespace: "agentos" },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: "agentos-codex-native-smoke" } },
        template: {
          metadata: {
            labels: {
              app: "agentos-codex-native-smoke",
              "agentos.akua.dev/ai-runtime": "codex",
              "agentos.akua.dev/ai-runtime-version": codexVersion,
              "agentos.akua.dev/otel-client": "true",
            },
          },
          spec: {
            automountServiceAccountToken: false,
            securityContext: {
              fsGroup: 1000,
              fsGroupChangePolicy: "OnRootMismatch",
              runAsGroup: 1000,
              runAsNonRoot: true,
              runAsUser: 1000,
              seccompProfile: { type: "RuntimeDefault" },
            },
            initContainers: [{
              name: "install-codex",
              image,
              imagePullPolicy: "Never",
              command: ["mise"],
              args: ["install", "--locked", "node", "npm:@openai/codex"],
              env: environment,
              volumeMounts: [home],
            }, {
              name: "seed-config",
              image,
              imagePullPolicy: "Never",
              command: ["sh", "-ec"],
              args: [
                "mkdir -p /home/agent/.codex; test -f /home/agent/.codex/config.toml || printf '%s\\n' 'unrelated_setting = \"preserved\"' > /home/agent/.codex/config.toml; chmod 600 /home/agent/.codex/config.toml",
              ],
              env: environment,
              volumeMounts: [home],
            }, {
              name: "prepare-home",
              image,
              imagePullPolicy: "Never",
              workingDir:
                "/opt/agentos/packages/agentos/resources/crewmates/default",
              command: ["mise"],
              args: ["run", "--skip-tools", "crewmate:prepare"],
              env: environment,
              volumeMounts: [home],
            }],
            containers: [{
              name: "codex",
              image,
              imagePullPolicy: "Never",
              command: ["sh", "-ec"],
              args: [shell],
              env: environment,
              volumeMounts: [home],
              readinessProbe: {
                exec: {
                  command: ["test", "-f", "/tmp/codex-turn-complete"],
                },
                failureThreshold: 300,
                periodSeconds: 1,
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
            }],
            volumes: [{
              name: "home",
              persistentVolumeClaim: { claimName: "agentos-codex-native-smoke" },
            }],
          },
        },
      },
    }],
  };
}

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
      "exports a real pinned Codex workload, preserves inference, and reattaches retained state",
      () => Effect.scoped(Effect.gen(function*() {
        const enabled = yield* Config.boolean("AGENTOS_RUN_OTEL_K8S_E2E").pipe(
          Config.withDefault(false),
        );
        if (!enabled) return;
        const providerRequests = yield* Ref.make<ReadonlyArray<{
          readonly authorization: string | null;
          readonly traceparent: string | null;
        }>>([]);
        const provider = yield* acquireBunTestServer((request) =>
          Effect.gen(function*() {
            const path = new URL(request.url).pathname;
            yield* readWebRequestText(request);
            if (path !== "/v1/responses") return new Response(null, { status: 404 });
            const attempt = yield* Ref.modify(providerRequests, (current) => [
              current.length,
              [...current, {
                authorization: request.headers.get("authorization"),
                traceparent: request.headers.get("traceparent"),
              }],
            ]);
            if (attempt === 0) {
              return Response.json({
                error: {
                  code: "server_error",
                  message: "fixture transient failure",
                  type: "server_error",
                },
              }, {
                status: 503,
                headers: {
                  "retry-after": "0",
                  "x-request-id": codexRequestId,
                },
              });
            }
            return new Response(codexSseResponse, {
              headers: { "content-type": "text/event-stream" },
            });
          }),
          { hostname: "0.0.0.0" },
        );
        const sink = yield* acquireOtlpTestSink();
        yield* sink.setAvailable(true);
        const providerEndpoint = `http://host.docker.internal:${provider.port}`;
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
        const agentosLoadImage = `agentos:codex-otel-kind-${suffix}`;
        const fileSystem = yield* FileSystem.FileSystem;
        const paths = yield* Path.Path;
        const repositoryRoot = yield* paths.fromFileUrl(repositoryUrl);
        const collectorOverlay = paths.join(
          repositoryRoot,
          "services",
          "otel-collector",
          "kubernetes",
          "overlays",
          "remote",
        );
        const archiveDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "agentos-otel-kind-",
        });
        const imageArchive = paths.join(archiveDirectory, "images.tar");
        const imageSource = paths.join(archiveDirectory, "source");
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
            agentosLoadImage,
          ]).pipe(Effect.ignore);
        });
        const diagnostics = Effect.gen(function*() {
          const inspect = (arguments_: ReadonlyArray<string>) =>
            run(
              "kubectl",
              kubectl,
              ["--context", context, ...arguments_],
            ).pipe(
              Effect.map(({ exitCode, stderr, stdout }) => ({
                command: arguments_.join(" "),
                exitCode,
                stderr,
                stdout,
              })),
              Effect.catch(() => Effect.succeed({
                command: arguments_.join(" "),
                exitCode: -1,
                stderr: "diagnostic command failed",
                stdout: "",
              })),
            );
          const [pods, codexLogs, prepareLogs, collectorLogs] = yield* Effect.all([
            inspect(["--namespace", "agentos", "get", "pods", "--output=wide"]),
            inspect([
              "--namespace",
              "agentos",
              "logs",
              "deployment/agentos-codex-native-smoke",
              "--container=codex",
            ]),
            inspect([
              "--namespace",
              "agentos",
              "logs",
              "deployment/agentos-codex-native-smoke",
              "--container=prepare-home",
            ]),
            inspect([
              "--namespace",
              "agentos",
              "logs",
              "statefulset/agentos-otel-collector",
              "--container=collector",
            ]),
          ], { concurrency: "unbounded" });
          const requests = yield* sink.requests;
          const calls = yield* Ref.get(providerRequests);
          yield* Effect.logError("AgentOS Codex Kubernetes smoke diagnostics", {
            calls,
            codexLogs,
            collectorLogs,
            paths: requests.map(({ accepted, path, responseStatus }) => ({
              accepted,
              path,
              responseStatus,
            })),
            pods,
            prepareLogs,
          });
        });

        const evidence = yield* Effect.gen(function*() {
          yield* requireCommand("docker", "docker", ["pull", "--quiet", collectorImage]);
          yield* requireCommand("docker", "docker", ["pull", "--quiet", busyboxImage]);
          const sourceRevision = (yield* requireCommand("git", "git", [
            "-C",
            repositoryRoot,
            "rev-parse",
            "HEAD",
          ])).trim();
          yield* requireCommand("git", "git", [
            "clone",
            "--no-checkout",
            "--no-hardlinks",
            "--quiet",
            repositoryRoot,
            imageSource,
          ]);
          yield* requireCommand("git", "git", [
            "-C",
            imageSource,
            "checkout",
            "--detach",
            "--quiet",
            sourceRevision,
          ]);
          yield* requireCommand("docker", "docker", [
            "build",
            "--tag",
            agentosLoadImage,
            "--build-arg",
            "AGENTOS_VERSION=codex-otel-smoke",
            imageSource,
          ]);
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
            agentosLoadImage,
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
          yield* kube(["apply", "-f", "-"], JSON.stringify({
            apiVersion: "v1",
            kind: "Secret",
            metadata: { name: "agentos-otel-remote", namespace: "agentos" },
            stringData: {
              endpoint: sink.remoteEndpoint,
              "headers.yaml": [
                "exporters:",
                "  otlp_http/remote:",
                "    headers:",
                '      x-agentos-test: "bounded"',
                "",
              ].join("\n"),
            },
          }));
          yield* kube(["apply", "-k", collectorOverlay]);
          yield* kube(["apply", "-f", "-"], JSON.stringify(smokeResources()));
          yield* kube(
            ["apply", "-f", "-"],
            JSON.stringify(codexSmokeResources(agentosLoadImage, providerEndpoint)),
          );
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
          yield* kube([
            "--namespace",
            "agentos",
            "rollout",
            "status",
            "deployment/agentos-codex-native-smoke",
            "--timeout=300s",
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
          yield* waitFor(
            "codex_native_signals",
            sink.requests.pipe(Effect.map((requests) =>
              ["/v1/logs", "/v1/metrics", "/v1/traces"].every((path) =>
                requests.some((request) => request.path === path && request.accepted)
              ) && requests.some((request) =>
                new TextDecoder().decode(request.body).includes(codexRequestId)
              )
            )),
          );
          const providerCalls = yield* Ref.get(providerRequests);
          assert.isAtLeast(providerCalls.length, 2);
          for (const call of providerCalls) {
            assert.strictEqual(
              call.authorization,
              `Bearer ${codexCredentialMarker}`,
            );
            assert.match(
              call.traceparent ?? "",
              /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/,
            );
          }
          const exported = (yield* sink.requests)
            .filter(({ accepted }) => accepted)
            .map(({ body }) => new TextDecoder().decode(body))
            .join("\n");
          for (const expected of [
            "codex.api_request",
            "codex.api_request.duration_ms",
            "agentos.ai.request.kind",
            "main",
            "agentos.ai.status_class",
            "server_error",
            "agentos.ai.error.class",
            "overload",
            "agentos.ai.provider.request_id",
            codexRequestId,
            "http.response.status_code",
            "agentos.fleet.name",
            "k8s.cluster.name",
            "k8s.namespace.name",
            "agentos",
            "k8s.workload.name",
            "agentos-codex-native-smoke",
            "k8s.pod.name",
            "agentos.ai.runtime",
            "codex",
            "agentos.ai.runtime.version",
            codexVersion,
            "service.version",
          ]) {
            assert.include(exported, expected);
          }
          for (const forbidden of [
            codexPromptMarker,
            codexResponseMarker,
            codexCredentialMarker,
            codexExporterHeaderMarker,
            "fixture transient failure",
            "auth.request_id",
            "error.message",
            "gen_ai.prompt",
            "tool.arguments",
            "tool.result",
          ]) {
            assert.notInclude(exported, forbidden);
          }

          const codexPodBefore = (yield* kube([
            "--namespace",
            "agentos",
            "get",
            "pods",
            "--selector=app=agentos-codex-native-smoke",
            "--output=jsonpath={.items[0].metadata.name}",
          ])).trim();
          yield* kube([
            "--namespace",
            "agentos",
            "rollout",
            "restart",
            "deployment/agentos-codex-native-smoke",
          ]);
          yield* kube([
            "--namespace",
            "agentos",
            "rollout",
            "status",
            "deployment/agentos-codex-native-smoke",
            "--timeout=300s",
          ]);
          yield* waitFor(
            "codex_restart_turn",
            Ref.get(providerRequests).pipe(
              Effect.map((requests) => requests.length >= 3),
            ),
          );
          const codexPodAfter = (yield* kube([
            "--namespace",
            "agentos",
            "get",
            "pods",
            "--selector=app=agentos-codex-native-smoke",
            "--output=jsonpath={.items[0].metadata.name}",
          ])).trim();
          assert.notStrictEqual(codexPodAfter, codexPodBefore);
          assert.strictEqual(
            (yield* kube([
              "--namespace",
              "agentos",
              "exec",
              "deployment/agentos-codex-native-smoke",
              "--container=codex",
              "--",
              "codex",
              "--version",
            ])).trim(),
            `codex-cli ${codexVersion}`,
          );
          yield* kube([
            "--namespace",
            "agentos",
            "exec",
            "deployment/agentos-codex-native-smoke",
            "--container=codex",
            "--",
            "sh",
            "-ec",
            "grep -Fq 'unrelated_setting = \"preserved\"' /home/agent/.codex/config.toml && grep -Fq 'log_user_prompt = false' /home/agent/.codex/config.toml && test \"$(stat -c %a /home/agent/.codex/config.toml)\" = 600",
          ]);
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
          const outageStartedAt = yield* Clock.currentTimeMillis;
          const outageTurn = yield* kube([
            "--namespace",
            "agentos",
            "exec",
            "deployment/agentos-codex-native-smoke",
            "--container=codex",
            "--",
            ...codexInvocation(providerEndpoint),
          ]);
          const outageDuration = (yield* Clock.currentTimeMillis) - outageStartedAt;
          assert.include(outageTurn, codexResponseMarker);
          assert.isBelow(outageDuration, 8_000);
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
          return {
            context,
            outageDuration,
            pvcAfter,
            pvcBefore,
          };
        }).pipe(
          Effect.tapError(() => diagnostics.pipe(Effect.ignore)),
          Effect.ensuring(cleanup),
        );

        assert.strictEqual(evidence.pvcAfter, evidence.pvcBefore);
        assert.isBelow(evidence.outageDuration, 8_000);
        const clusters = yield* requireCommand("kind", kind, ["get", "clusters"]);
        assert.notInclude(clusters.split("\n"), cluster);
      })),
      900_000,
    );
  },
);
