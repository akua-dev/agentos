import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import {
  Clock,
  Config,
  ConfigProvider,
  Console,
  Effect,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import {
  kubernetesResourceListJson,
  renderCompiledWorkloadSpec,
  type RenderedWorkloadPlan,
} from "./conformance-support.ts";

const packageRootUrl = new URL("../../../", import.meta.url);
const fixtureDistributionUrl = new URL(
  "./fixtures/disposable-distribution/",
  import.meta.url,
);
const busyboxImage =
  "docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const ids = {
  assignment: "59000000-0000-4000-8000-000000000001",
  crew: "29000000-0000-4000-8000-000000000003",
  firstMate: "29000000-0000-4000-8000-000000000001",
  secondMate: "29000000-0000-4000-8000-000000000002",
  task: "49000000-0000-4000-8000-000000000001",
};
const briefDigest = "b".repeat(64);

const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);
const LiveConfig = Config.all({
  context: Config.option(Config.string("AGENTOS_KUBERNETES_TEST_CONTEXT")),
  approval: Config.option(
    Config.string("AGENTOS_DISPOSABLE_FLEET_APPROVAL"),
  ),
});
const OptionsSchema = Schema.Struct({
  context: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(128),
      Schema.isPattern(/^kind-agentos-workload-[a-z0-9-]+$/),
    ),
  ),
  approval: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(128),
      Schema.isPattern(/^approval:[0-9A-Za-z._:-]+$/),
    ),
  ),
});
const KubeconfigSchema = Schema.Struct({
  clusters: Schema.Tuple([Schema.Struct({
    cluster: Schema.Struct({ server: Schema.String }),
  })]),
});
const StatefulSetSchema = Schema.Struct({
  apiVersion: Schema.Literal("apps/v1"),
  kind: Schema.Literal("StatefulSet"),
  metadata: Schema.Struct({ name: Schema.String }),
  spec: Schema.Struct({
    replicas: Schema.Literal(1),
    serviceName: Schema.String,
    template: Schema.Struct({
      metadata: Schema.Struct({
        annotations: Schema.Record(Schema.String, Schema.String),
      }),
      spec: Schema.Struct({
        automountServiceAccountToken: Schema.Boolean,
        serviceAccountName: Schema.String,
        containers: Schema.Array(Schema.Struct({
          image: Schema.String,
          name: Schema.String,
          readinessProbe: Schema.Struct({
            httpGet: Schema.Struct({ path: Schema.String }),
          }),
        })),
      }),
    }),
    volumeClaimTemplates: Schema.Tuple([Schema.Struct({
      metadata: Schema.Struct({ name: Schema.Literal("home") }),
      spec: Schema.Struct({
        accessModes: Schema.Tuple([Schema.Literal("ReadWriteOnce")]),
        storageClassName: Schema.String,
      }),
    })]),
  }),
});

type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

class WorkloadDisposableProofError
  extends Schema.TaggedErrorClass<WorkloadDisposableProofError>()(
    "WorkloadDisposableProofError",
    {
      operation: Schema.Literals([
        "admission",
        "authorization",
        "configuration",
        "context",
        "kubectl",
        "replacement",
        "resource",
      ]),
      detail: Schema.optional(Schema.String),
    },
  )
{}

function proofError(
  operation: typeof WorkloadDisposableProofError.fields.operation.Type,
  detail?: string,
) {
  return WorkloadDisposableProofError.make({ operation, detail });
}

function persistentSpec(
  distributionRoot: string,
  overlayRoot: string,
  namespace: string,
  coreNamespace: string,
) {
  return {
    version: 1,
    distributionRoot,
    overlayRoot,
    profile: { name: "persistent-mate", version: 1 },
    fleet: "disposable",
    namespace,
    identity: {
      agentId: ids.secondMate,
      ownerAgentId: ids.firstMate,
      taskId: null,
      assignmentId: null,
      role: "second_mate",
      agentName: "workload-mate",
    },
    names: {
      workload: "agentos-workload-mate",
      service: "agentos-workload-mate",
      serviceAccount: "agentos-workload-mate",
      herdrSession: "agentos-workload-mate",
    },
    ownerServiceAccount: {
      name: "agentos-firstmate",
      namespace: coreNamespace,
    },
    image: { reference: busyboxImage, pullPolicy: "IfNotPresent" },
    harness: "pi",
    home: {
      accessMode: "ReadWriteOnce",
      retention: "Retain",
      size: "1Gi",
      storageClassName: "standard",
    },
    resources: {
      agent: {
        requests: { cpu: "25m", memory: "64Mi" },
        limits: { cpu: "250m", memory: "128Mi" },
      },
      init: {
        requests: { cpu: "25m", memory: "64Mi" },
        limits: { cpu: "250m", memory: "128Mi" },
      },
    },
    scheduling: { nodeSelector: {}, tolerations: [] },
    database: {
      identity: "runtime_workload_mate",
      url:
        "postgresql://runtime_workload_mate@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos?sslmode=require",
      secret: { key: "pgpass", name: "agentos-workload-mate-postgres" },
    },
    providerAccessProfiles: ["openai-responses@v1"],
    brief: null,
    readiness: { contract: "semantic-v1" },
    protocols: { a2a: "v1", acp: "v1" },
  };
}

function interactiveSpec(
  distributionRoot: string,
  overlayRoot: string,
  namespace: string,
) {
  return {
    version: 1,
    distributionRoot,
    overlayRoot,
    profile: { name: "interactive-crewmate", version: 1 },
    fleet: "disposable",
    namespace,
    identity: {
      agentId: ids.crew,
      ownerAgentId: ids.secondMate,
      taskId: ids.task,
      assignmentId: ids.assignment,
      role: "crewmate",
      agentName: "workload-crew",
    },
    names: {
      workload: "agentos-workload-crew",
      service: "agentos-workload-crew",
      serviceAccount: "agentos-workload-crew",
      herdrSession: "agentos-workload-crew",
    },
    ownerServiceAccount: {
      name: "agentos-workload-mate",
      namespace,
    },
    image: { reference: busyboxImage, pullPolicy: "IfNotPresent" },
    harness: "codex",
    home: {
      accessMode: "ReadWriteOnce",
      retention: "Retain",
      size: "1Gi",
      storageClassName: "standard",
    },
    resources: {
      agent: {
        requests: { cpu: "25m", memory: "64Mi" },
        limits: { cpu: "250m", memory: "128Mi" },
      },
      init: {
        requests: { cpu: "25m", memory: "64Mi" },
        limits: { cpu: "250m", memory: "128Mi" },
      },
    },
    scheduling: { nodeSelector: {}, tolerations: [] },
    database: {
      identity: "runtime_workload_crew",
      url:
        "postgresql://runtime_workload_crew@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos?sslmode=require",
      secret: { key: "pgpass", name: "agentos-workload-crew-postgres" },
    },
    providerAccessProfiles: ["openai-responses@v1"],
    brief: { path: "/home/agent/brief.md", sha256: briefDigest },
    readiness: { contract: "semantic-v1" },
    protocols: { a2a: "v1", acp: "v1" },
  };
}

const renderPlans = Effect.fn("test.workloadDisposable.renderPlans")(
  function*(alpha: string, beta: string, core: string) {
    const paths = yield* Path.Path;
    const distributionRoot = paths.resolve(
      yield* paths.fromFileUrl(fixtureDistributionUrl),
    );
    return yield* Effect.all({
      persistent: renderCompiledWorkloadSpec({
        withOverlayRoot: (overlayRoot) =>
          persistentSpec(distributionRoot, overlayRoot, alpha, core),
      }),
      interactive: renderCompiledWorkloadSpec({
        withOverlayRoot: (overlayRoot) =>
          interactiveSpec(distributionRoot, overlayRoot, alpha),
      }),
      isolatedInteractive: renderCompiledWorkloadSpec({
        withOverlayRoot: (overlayRoot) =>
          interactiveSpec(distributionRoot, overlayRoot, beta),
      }),
    }, { concurrency: "unbounded" });
  },
);

const runKubectl = Effect.fn("test.workloadDisposable.kubectl")(function*(
  context: string,
  arguments_: ReadonlyArray<string>,
  input?: string,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(
      "kubectl",
      ["--context", context, ...arguments_],
      {
        stdin: input === undefined
          ? "ignore"
          : Stream.make(new TextEncoder().encode(input)),
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout } satisfies CommandResult;
  })).pipe(Effect.mapError(() => proofError("kubectl")));
});

const requireKubectl = Effect.fn(
  "test.workloadDisposable.requireKubectl",
)(function*(
  context: string,
  arguments_: ReadonlyArray<string>,
  input?: string,
) {
  const result = yield* runKubectl(context, arguments_, input);
  if (result.exitCode !== 0) {
    return yield* proofError(
      "kubectl",
      `status=${result.exitCode}; stderr=${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
});

const requireFailure = Effect.fn(
  "test.workloadDisposable.requireFailure",
)(function*(
  context: string,
  arguments_: ReadonlyArray<string>,
  expected: string,
  input?: string,
) {
  const result = yield* runKubectl(context, arguments_, input);
  if (result.exitCode === 0 || !result.stderr.includes(expected)) {
    return yield* proofError(
      "admission",
      `expected=${expected}; status=${result.exitCode}`,
    );
  }
});

const canI = Effect.fn("test.workloadDisposable.canI")(function*(
  context: string,
  identity: string,
  namespace: string,
  verb: string,
  resource: string,
) {
  const result = yield* runKubectl(context, [
    "auth",
    "can-i",
    verb,
    resource,
    "--as",
    identity,
    "--namespace",
    namespace,
  ]);
  const answer = result.stdout.trim();
  if (
    ![0, 1].includes(result.exitCode) ||
    !["yes", "no"].includes(answer)
  ) return yield* proofError("authorization");
  return answer === "yes";
});

const statefulSet = Effect.fn("test.workloadDisposable.statefulSet")(
  function*(rendered: RenderedWorkloadPlan, name: string) {
    const source = rendered.resources.find((resource) =>
      typeof resource === "object" &&
      resource !== null &&
      "kind" in resource &&
      resource.kind === "StatefulSet" &&
      "metadata" in resource &&
      typeof resource.metadata === "object" &&
      resource.metadata !== null &&
      "name" in resource.metadata &&
      resource.metadata.name === name
    );
    if (source === undefined) return yield* proofError("resource", name);
    return yield* Schema.decodeUnknownEffect(StatefulSetSchema, {
      onExcessProperty: "preserve",
    })(source).pipe(
      Effect.mapError(() => proofError("resource", name)),
    );
  },
);

const waitForReplacement = Effect.fn(
  "test.workloadDisposable.waitForReplacement",
)(function*(
  context: string,
  namespace: string,
  pod: string,
  previousUid: string,
) {
  return yield* runKubectl(context, [
    "--namespace",
    namespace,
    "get",
    `pod/${pod}`,
    "--output=jsonpath={.metadata.uid}{'|'}{.status.conditions[?(@.type=='Ready')].status}",
  ]).pipe(
    Effect.flatMap((result) => {
      const [uid = "", ready = ""] = result.stdout.split("|");
      return result.exitCode === 0 && uid !== "" && uid !== previousUid &&
          ready === "True"
        ? Effect.succeed(uid)
        : Effect.fail(proofError("replacement"));
    }),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 119 }),
  );
});

function invalidImageStatefulSet(
  workload: typeof StatefulSetSchema.Type,
) {
  return {
    ...workload,
    spec: {
      ...workload.spec,
      template: {
        ...workload.spec.template,
        spec: {
          ...workload.spec.template.spec,
          containers: workload.spec.template.spec.containers.map(
            (container, index) =>
              index === 0
                ? { ...container, image: "docker.io/library/busybox:latest" }
                : container,
          ),
        },
      },
    },
  };
}

const encodeJson = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value);

layer(platform)("disposable typed workload recovery", (it) => {
  it.effect("renders exact persistent and interactive plans from native structured resources", () =>
    Effect.gen(function*() {
      const plans = yield* renderPlans(
        "agentos-workload-local-alpha",
        "agentos-workload-local-beta",
        "agentos-workload-local-core",
      );
      assert.deepStrictEqual(plans.persistent.plan.summary.resourceKinds, [
        "LimitRange",
        "Namespace",
        "NetworkPolicy",
        "PersistentVolumeClaim",
        "ResourceQuota",
        "Role",
        "RoleBinding",
        "Service",
        "ServiceAccount",
        "StatefulSet",
      ]);
      assert.deepStrictEqual(
        plans.interactive.plan.summary.resourceKinds,
        ["PersistentVolumeClaim", "Service", "ServiceAccount", "StatefulSet"],
      );
      const persistent = yield* statefulSet(
        plans.persistent,
        "agentos-workload-mate",
      );
      const interactive = yield* statefulSet(
        plans.interactive,
        "agentos-workload-crew",
      );
      for (const workload of [persistent, interactive]) {
        assert.strictEqual(workload.spec.replicas, 1);
        assert.strictEqual(
          workload.spec.volumeClaimTemplates[0].spec.storageClassName,
          "standard",
        );
        assert.strictEqual(
          workload.spec.volumeClaimTemplates[0].spec.accessModes[0],
          "ReadWriteOnce",
        );
        assert.strictEqual(
          workload.spec.template.spec.containers[0]?.image,
          busyboxImage,
        );
        assert.strictEqual(
          workload.spec.template.spec.containers[0]?.readinessProbe.httpGet.path,
          "/ready",
        );
      }
      assert.isTrue(
        persistent.spec.template.spec.automountServiceAccountToken,
      );
      assert.isFalse(
        interactive.spec.template.spec.automountServiceAccountToken,
      );
      assert.notStrictEqual(
        plans.persistent.plan.specDigest,
        plans.interactive.plan.specDigest,
      );
      assert.notStrictEqual(
        plans.persistent.renderDigest,
        plans.interactive.renderDigest,
      );
    }));

  it.effect("proves dry-run, admission, apply repair, Herdr readiness, replacement, and retained PVC", () =>
    Effect.gen(function*() {
      const configured = yield* LiveConfig;
      if (
        Option.isNone(configured.context) || Option.isNone(configured.approval)
      ) {
        yield* Console.log(
          "Disposable workload proof unobserved: context or approval is absent",
        );
        return;
      }
      const options = yield* Schema.decodeUnknownEffect(OptionsSchema, {
        onExcessProperty: "error",
      })({
        context: configured.context.value,
        approval: configured.approval.value,
      }).pipe(Effect.mapError(() => proofError("configuration")));
      const kubeconfig = yield* requireKubectl(options.context, [
        "config",
        "view",
        "--minify",
        "--output=json",
      ]).pipe(
        Effect.flatMap((source) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(KubeconfigSchema))(
            source,
          )
        ),
        Effect.mapError(() => proofError("context")),
      );
      const server = kubeconfig.clusters[0].cluster.server;
      const url = URL.canParse(server) ? new URL(server) : null;
      if (
        url === null ||
        url.protocol !== "https:" ||
        !["127.0.0.1", "localhost"].includes(url.hostname)
      ) return yield* proofError("context");

      yield* TestClock.withLive(Effect.scoped(Effect.gen(function*() {
        const paths = yield* Path.Path;
        const packageRoot = paths.resolve(
          yield* paths.fromFileUrl(packageRootUrl),
        );
        const suffix = (yield* Clock.currentTimeMillis).toString(36).slice(-5);
        const core = `agentos-workload-127-core-${suffix}`;
        const alpha = `agentos-workload-127-alpha-${suffix}`;
        const beta = `agentos-workload-127-beta-${suffix}`;
        const namespaces = [core, alpha, beta];
        const admission = paths.join(
          packageRoot,
          "resources/roles/secondmate/kubernetes/admission",
        );
        const cleanup = Effect.all([
          requireKubectl(options.context, [
            "delete",
            "namespace",
            ...namespaces,
            "--ignore-not-found=true",
            "--wait=true",
            "--timeout=90s",
          ]),
          requireKubectl(options.context, [
            "delete",
            "--kustomize",
            admission,
            "--ignore-not-found=true",
            "--wait=true",
          ]),
        ], { concurrency: "unbounded", discard: true }).pipe(Effect.ignore);
        yield* Effect.addFinalizer(() => cleanup);

        yield* Effect.forEach(namespaces, (namespace) =>
          requireKubectl(options.context, ["create", "namespace", namespace]), {
          concurrency: 3,
          discard: true,
        });
        yield* Effect.forEach(namespaces, (namespace) =>
          requireKubectl(options.context, [
            "label",
            `namespace/${namespace}`,
            "agentos.akua.dev/fleet=disposable",
            "pod-security.kubernetes.io/enforce=restricted",
            "pod-security.kubernetes.io/enforce-version=latest",
            "--overwrite",
          ]), { concurrency: 3, discard: true });
        yield* requireKubectl(options.context, [
          "--namespace",
          core,
          "create",
          "serviceaccount",
          "agentos-firstmate",
        ]);
        yield* requireKubectl(options.context, [
          "apply",
          "--server-side",
          "--kustomize",
          admission,
        ]);

        const plans = yield* renderPlans(alpha, beta, core);
        const [persistentJson, interactiveJson, isolatedJson] =
          yield* Effect.all([
            kubernetesResourceListJson(plans.persistent.resources),
            kubernetesResourceListJson(plans.interactive.resources),
            kubernetesResourceListJson(plans.isolatedInteractive.resources),
          ]);
        yield* requireKubectl(options.context, [
          "apply",
          "--server-side",
          "--dry-run=server",
          "--filename=-",
        ], persistentJson);
        yield* requireKubectl(options.context, [
          "apply",
          "--server-side",
          "--dry-run=server",
          "--filename=-",
        ], isolatedJson);

        const beforeApply = yield* runKubectl(options.context, [
          "diff",
          "--server-side",
          "--filename=-",
        ], persistentJson);
        assert.strictEqual(beforeApply.exitCode, 1);
        yield* requireKubectl(options.context, [
          "apply",
          "--server-side",
          "--filename=-",
        ], persistentJson);
        const afterApply = yield* runKubectl(options.context, [
          "diff",
          "--server-side",
          "--filename=-",
        ], persistentJson);
        assert.strictEqual(afterApply.exitCode, 0);
        yield* requireKubectl(options.context, [
          "--namespace",
          alpha,
          "rollout",
          "status",
          "statefulset/agentos-workload-mate",
          "--timeout=180s",
        ]);

        const secondMateIdentity =
          `system:serviceaccount:${alpha}:agentos-workload-mate`;
        assert.isTrue(yield* canI(
          options.context,
          secondMateIdentity,
          alpha,
          "create",
          "statefulsets.apps",
        ));
        assert.isFalse(yield* canI(
          options.context,
          secondMateIdentity,
          beta,
          "create",
          "statefulsets.apps",
        ));
        assert.isFalse(yield* canI(
          options.context,
          secondMateIdentity,
          alpha,
          "create",
          "secrets",
        ));

        const interactiveStatefulSet = yield* statefulSet(
          plans.interactive,
          "agentos-workload-crew",
        );
        yield* requireFailure(
          options.context,
          [
            "--namespace",
            alpha,
            "--as",
            secondMateIdentity,
            "create",
            "--dry-run=server",
            "--filename=-",
          ],
          "Every Crewmate image must be a remote image pinned by sha256 digest",
          yield* encodeJson(invalidImageStatefulSet(interactiveStatefulSet)),
        );
        yield* requireFailure(
          options.context,
          [
            "--namespace",
            alpha,
            "--as",
            secondMateIdentity,
            "patch",
            "statefulset/agentos-workload-mate",
            "--dry-run=server",
            "--type=merge",
            "--patch",
            '{"metadata":{"annotations":{"agentos.akua.dev/proof":"denied"}}}',
          ],
          "A Second Mate cannot create, update, or delete its persistent Mate workload",
        );

        yield* requireKubectl(options.context, [
          "--namespace",
          alpha,
          "--as",
          secondMateIdentity,
          "apply",
          "--server-side",
          "--filename=-",
        ], interactiveJson);
        yield* requireKubectl(options.context, [
          "--namespace",
          alpha,
          "rollout",
          "status",
          "statefulset/agentos-workload-crew",
          "--timeout=180s",
        ]);

        const pod = "agentos-workload-crew-0";
        const pvc = "home-agentos-workload-crew-0";
        const podUid = yield* requireKubectl(options.context, [
          "--namespace",
          alpha,
          "get",
          `pod/${pod}`,
          "--output=jsonpath={.metadata.uid}",
        ]);
        const pvcUid = yield* requireKubectl(options.context, [
          "--namespace",
          alpha,
          "get",
          `persistentvolumeclaim/${pvc}`,
          "--output=jsonpath={.metadata.uid}",
        ]);
        assert.strictEqual(
          yield* requireKubectl(options.context, [
            "--namespace",
            alpha,
            "exec",
            `pod/${pod}`,
            "--container=crewmate",
            "--",
            "cat",
            "/home/agent/native-session",
          ]),
          "agentos-workload-crew",
        );

        const brokenReadiness = yield* encodeJson({
          spec: {
            template: {
              spec: {
                containers: [{
                  name: "crewmate",
                  readinessProbe: {
                    httpGet: { path: "/missing", port: "herdr" },
                  },
                }],
              },
            },
          },
        });
        yield* requireKubectl(options.context, [
          "--namespace",
          alpha,
          "--as",
          secondMateIdentity,
          "patch",
          "statefulset/agentos-workload-crew",
          "--type=strategic",
          "--patch",
          brokenReadiness,
        ]);
        const failedRollout = yield* runKubectl(options.context, [
          "--namespace",
          alpha,
          "rollout",
          "status",
          "statefulset/agentos-workload-crew",
          "--timeout=8s",
        ]);
        assert.notStrictEqual(failedRollout.exitCode, 0);
        yield* requireKubectl(options.context, [
          "--namespace",
          alpha,
          "--as",
          secondMateIdentity,
          "apply",
          "--server-side",
          "--force-conflicts",
          "--filename=-",
        ], interactiveJson);
        yield* requireKubectl(options.context, [
          "--namespace",
          alpha,
          "--as",
          secondMateIdentity,
          "delete",
          `pod/${pod}`,
          "--wait=true",
        ]);
        yield* requireKubectl(options.context, [
          "--namespace",
          alpha,
          "rollout",
          "status",
          "statefulset/agentos-workload-crew",
          "--timeout=180s",
        ]);

        const currentPodUid = yield* requireKubectl(options.context, [
          "--namespace",
          alpha,
          "get",
          `pod/${pod}`,
          "--output=jsonpath={.metadata.uid}",
        ]);
        assert.notStrictEqual(currentPodUid, podUid);
        assert.strictEqual(
          yield* requireKubectl(options.context, [
            "--namespace",
            alpha,
            "get",
            `persistentvolumeclaim/${pvc}`,
            "--output=jsonpath={.metadata.uid}",
          ]),
          pvcUid,
        );
        yield* requireKubectl(options.context, [
          "--namespace",
          alpha,
          "--as",
          secondMateIdentity,
          "delete",
          `pod/${pod}`,
          "--wait=true",
        ]);
        const replacementUid = yield* waitForReplacement(
          options.context,
          alpha,
          pod,
          currentPodUid,
        );
        assert.notStrictEqual(replacementUid, currentPodUid);
        assert.strictEqual(
          yield* requireKubectl(options.context, [
            "--namespace",
            alpha,
            "get",
            `persistentvolumeclaim/${pvc}`,
            "--output=jsonpath={.metadata.uid}",
          ]),
          pvcUid,
        );
        assert.strictEqual(
          yield* requireKubectl(options.context, [
            "--namespace",
            alpha,
            "exec",
            `pod/${pod}`,
            "--container=crewmate",
            "--",
            "cat",
            "/home/agent/native-session",
          ]),
          "agentos-workload-crew",
        );

        yield* requireKubectl(options.context, [
          "--namespace",
          alpha,
          "--as",
          secondMateIdentity,
          "delete",
          "--filename=-",
          "--wait=true",
        ], interactiveJson);
        assert.strictEqual(
          yield* requireKubectl(options.context, [
            "--namespace",
            alpha,
            "get",
            `persistentvolumeclaim/${pvc}`,
            "--output=jsonpath={.metadata.uid}",
          ]),
          pvcUid,
        );

        yield* cleanup;
        for (const namespace of namespaces) {
          assert.strictEqual(
            yield* requireKubectl(options.context, [
              "get",
              `namespace/${namespace}`,
              "--ignore-not-found",
              "--output=name",
            ]),
            "",
          );
        }
        yield* Effect.logInfo("agentos.workload.disposable_recovery_proof", {
          context: options.context,
          approval: options.approval,
          persistentSpecDigest: plans.persistent.plan.specDigest,
          persistentOverlayDigest: plans.persistent.plan.overlayDigest,
          persistentRenderDigest: plans.persistent.renderDigest,
          interactiveSpecDigest: plans.interactive.plan.specDigest,
          interactiveOverlayDigest: plans.interactive.plan.overlayDigest,
          interactiveRenderDigest: plans.interactive.renderDigest,
          podReplaced: true,
          pvcRetained: true,
          namespacesDeleted: true,
          productionEndpointContacted: false,
        });
      })));
    }), 360_000);
});
