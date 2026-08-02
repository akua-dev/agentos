import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Effect,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import {
  AGENTOS_EGRESS_TOKEN_AUDIENCE,
  AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
} from "../../../../../src/access/identity.ts";
import { parseYamlDocuments } from "../../../../../../../tooling/testing/kubernetes.ts";

const kubernetesUrl = new URL("..", import.meta.url);
const alpha = "agentos-domain-alpha";
const beta = "agentos-domain-beta";
const core = "agentos";
const secondmateIdentity =
  `system:serviceaccount:${alpha}:agentos-secondmate`;
const firstmateIdentity = `system:serviceaccount:${core}:agentos-firstmate`;
const providerRootCredential = "not-a-real-secret";
const clusterScopedResources = new Set([
  "clusterroles.rbac.authorization.k8s.io",
  "namespaces",
  "validatingadmissionpolicies.admissionregistration.k8s.io",
  "validatingadmissionpolicybindings.admissionregistration.k8s.io",
]);
const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);

const StringRecord = Schema.Record(Schema.String, Schema.String);
const AdmissionPolicyList = Schema.Struct({
  items: Schema.Array(Schema.Struct({
    metadata: Schema.Struct({ name: Schema.String }),
    status: Schema.Unknown,
  })),
});
const NamespaceResource = Schema.Struct({
  metadata: Schema.Struct({ labels: StringRecord }),
});
const StatefulSetResource = Schema.Struct({
  spec: Schema.Struct({
    template: Schema.Struct({
      spec: Schema.Struct({
        containers: Schema.Array(Schema.Struct({
          env: Schema.Array(Schema.Struct({
            name: Schema.String,
            value: Schema.String,
          })),
        })),
      }),
    }),
  }),
});

type CommandEnvironment = Readonly<Record<string, string>>;
type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};
type MutableRecord = Record<string, unknown>;
type WorkloadParts = {
  readonly container: MutableRecord;
  readonly labels: MutableRecord;
  readonly pod: MutableRecord;
  readonly templateLabels: MutableRecord;
};

function isMutableRecord(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class DomainLifecycleError
  extends Schema.TaggedErrorClass<DomainLifecycleError>()(
    "DomainLifecycleError",
    {
      detail: Schema.optional(Schema.String),
      operation: Schema.Literals([
        "admission_denial",
        "authorization",
        "fixture_shape",
        "kubectl_command",
        "kubectl_spawn",
        "pod_pending",
        "pod_timeout",
      ]),
    },
  )
{}

const lifecycleError = (
  operation: typeof DomainLifecycleError.fields.operation.Type,
  detail?: string,
) => DomainLifecycleError.make({ detail, operation });

const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  source: string,
) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(source);

const encodeJson = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value);

const commandEnvironment = Effect.fn(
  "test.secondMateDomain.commandEnvironment",
)(function*() {
  const configured = yield* Config.all({
    home: Config.option(Config.string("HOME")),
    kubeconfig: Config.option(Config.string("KUBECONFIG")),
    path: Config.string("PATH"),
  });
  const environment: Record<string, string> = { PATH: configured.path };
  if (Option.isSome(configured.home)) environment.HOME = configured.home.value;
  if (Option.isSome(configured.kubeconfig)) {
    environment.KUBECONFIG = configured.kubeconfig.value;
  }
  return environment;
});

const kubectl = Effect.fn("test.secondMateDomain.kubectl")(function*(
  context: string,
  environment: CommandEnvironment,
  capturedOutput: Ref.Ref<ReadonlyArray<string>>,
  arguments_: ReadonlyArray<string>,
  input?: string,
) {
  const result = yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(
      "kubectl",
      ["--context", context, ...arguments_],
      {
        env: environment,
        extendEnv: false,
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
  })).pipe(
    Effect.mapError(() => lifecycleError("kubectl_spawn")),
  );
  yield* Ref.update(capturedOutput, (captured) => [
    ...captured,
    result.stdout,
    result.stderr,
  ]);
  return result;
});

const requireKubectl = Effect.fn(
  "test.secondMateDomain.requireKubectl",
)(function*(
  context: string,
  environment: CommandEnvironment,
  capturedOutput: Ref.Ref<ReadonlyArray<string>>,
  arguments_: ReadonlyArray<string>,
) {
  const result = yield* kubectl(
    context,
    environment,
    capturedOutput,
    arguments_,
  );
  if (result.exitCode !== 0 || result.stderr !== "") {
    return yield* lifecycleError(
      "kubectl_command",
      `status=${result.exitCode}; stderr=${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
});

const requireAdmissionDenial = Effect.fn(
  "test.secondMateDomain.requireAdmissionDenial",
)(function*(
  context: string,
  environment: CommandEnvironment,
  capturedOutput: Ref.Ref<ReadonlyArray<string>>,
  namespace: string,
  identity: string,
  manifest: unknown,
  message: string,
) {
  const input = yield* encodeJson(manifest);
  const result = yield* kubectl(
    context,
    environment,
    capturedOutput,
    [
      "--namespace",
      namespace,
      "--as",
      identity,
      "create",
      "--dry-run=server",
      "--filename=-",
    ],
    input,
  );
  if (result.exitCode !== 1 || !result.stderr.includes(message)) {
    return yield* lifecycleError(
      "admission_denial",
      `expected=${message}; status=${result.exitCode}`,
    );
  }
});

const requireRecord = Effect.fn("test.secondMateDomain.requireRecord")(
  function*(value: unknown, path: string) {
    if (!isMutableRecord(value)) {
      return yield* lifecycleError("fixture_shape", `${path} must be an object`);
    }
    return value;
  },
);

const requireArray = Effect.fn("test.secondMateDomain.requireArray")(
  function*(value: unknown, path: string) {
    if (!Array.isArray(value)) {
      return yield* lifecycleError("fixture_shape", `${path} must be an array`);
    }
    return value;
  },
);

const workloadParts = Effect.fn("test.secondMateDomain.workloadParts")(
  function*(workload: unknown) {
    const root = yield* requireRecord(workload, "workload");
    const metadata = yield* requireRecord(root.metadata, "workload.metadata");
    const specification = yield* requireRecord(root.spec, "workload.spec");
    const template = yield* requireRecord(
      specification.template,
      "workload.spec.template",
    );
    const templateMetadata = yield* requireRecord(
      template.metadata,
      "workload.spec.template.metadata",
    );
    const pod = yield* requireRecord(
      template.spec,
      "workload.spec.template.spec",
    );
    const containers = yield* requireArray(
      pod.containers,
      "workload.spec.template.spec.containers",
    );
    return {
      container: yield* requireRecord(
        containers[0],
        "workload.spec.template.spec.containers[0]",
      ),
      labels: yield* requireRecord(metadata.labels, "workload.metadata.labels"),
      pod,
      templateLabels: yield* requireRecord(
        templateMetadata.labels,
        "workload.spec.template.metadata.labels",
      ),
    } satisfies WorkloadParts;
  },
);

const egressTokenProjection = Effect.fn(
  "test.secondMateDomain.egressTokenProjection",
)(function*(workload: unknown) {
  const pod = (yield* workloadParts(workload)).pod;
  const volumes = yield* requireArray(
    pod.volumes,
    "workload.spec.template.spec.volumes",
  );
  const decodedVolumes = yield* Effect.forEach(
    volumes,
    (volume, index) =>
      requireRecord(volume, `workload.spec.template.spec.volumes[${index}]`),
  );
  const identityVolume = decodedVolumes.find(
    (volume) => volume.name === "agentos-egress-identity",
  );
  if (identityVolume === undefined) {
    return yield* lifecycleError(
      "fixture_shape",
      "Workload is missing agentos-egress-identity volume",
    );
  }
  const projected = yield* requireRecord(
    identityVolume.projected,
    "agentos-egress-identity.projected",
  );
  const sources = yield* requireArray(
    projected.sources,
    "agentos-egress-identity.projected.sources",
  );
  if (sources.length !== 1) {
    return yield* lifecycleError(
      "fixture_shape",
      "agentos-egress-identity must have exactly one source",
    );
  }
  const source = yield* requireRecord(
    sources[0],
    "agentos-egress-identity source",
  );
  return yield* requireRecord(
    source.serviceAccountToken,
    "agentos-egress-identity serviceAccountToken",
  );
});

function hasNoTypeCheckingWarnings(status: unknown): boolean {
  if (!isMutableRecord(status)) return false;
  const typeChecking = status.typeChecking;
  if (typeChecking === undefined) return true;
  if (!isMutableRecord(typeChecking)) return false;
  const warnings = typeChecking.expressionWarnings;
  return warnings === undefined ||
    (Array.isArray(warnings) && warnings.length === 0);
}

const canI = Effect.fn("test.secondMateDomain.canI")(function*(
  context: string,
  environment: CommandEnvironment,
  capturedOutput: Ref.Ref<ReadonlyArray<string>>,
  identity: string,
  namespace: string,
  verb: string,
  resource: string,
) {
  const [baseResource = "", subresource] = resource.split("/");
  if (baseResource === "") {
    return yield* lifecycleError("authorization", "resource must not be empty");
  }
  const result = yield* kubectl(
    context,
    environment,
    capturedOutput,
    [
      "auth",
      "can-i",
      verb,
      baseResource,
      ...(subresource === undefined ? [] : [`--subresource=${subresource}`]),
      "--as",
      identity,
      ...(clusterScopedResources.has(baseResource)
        ? ["--all-namespaces"]
        : ["--namespace", namespace]),
    ],
  );
  const output = result.stdout.trim();
  if (
    ![0, 1].includes(result.exitCode) ||
    result.stderr !== "" ||
    !["yes", "no"].includes(output)
  ) {
    return yield* lifecycleError(
      "authorization",
      `status=${result.exitCode}; output=${output}`,
    );
  }
  return output === "yes";
});

const waitForPodUid = Effect.fn("test.secondMateDomain.waitForPodUid")(
  function*(
    context: string,
    environment: CommandEnvironment,
    capturedOutput: Ref.Ref<ReadonlyArray<string>>,
    namespace: string,
    name: string,
    previousUid?: string,
    requireReady = false,
  ) {
    return yield* TestClock.withLive(
      kubectl(
        context,
        environment,
        capturedOutput,
        [
          "--namespace",
          namespace,
          "get",
          `pod/${name}`,
          "--output=jsonpath={.metadata.uid}{\"|\"}{.status.conditions[?(@.type==\"Ready\")].status}",
        ],
      ).pipe(
        Effect.flatMap((result) => {
          const [uid = "", ready] = result.stdout.split("|");
          const isNew = previousUid === undefined || uid !== previousUid;
          return result.exitCode === 0 &&
              uid !== "" &&
              isNew &&
              (!requireReady || ready === "True")
            ? Effect.succeed(uid)
            : Effect.fail(lifecycleError("pod_pending"));
        }),
        Effect.retry({
          schedule: Schedule.spaced("1 second"),
          times: 119,
        }),
        Effect.mapError(() =>
          lifecycleError(
            "pod_timeout",
            `Pod ${namespace}/${name} did not reach the expected replacement state`,
          )
        ),
      ),
    );
  },
);

const allowedSecondmateAuthorizations: ReadonlyArray<
  readonly [verb: string, resource: string]
> = [
  ["create", "statefulsets.apps"],
  ["create", "services"],
  ["create", "serviceaccounts"],
  ["get", "pods"],
  ["delete", "pods"],
  ["create", "pods/exec"],
  ["get", "persistentvolumeclaims"],
];
const deniedSecondmateAuthorizations: ReadonlyArray<
  readonly [verb: string, resource: string]
> = [
  ["create", "namespaces"],
  ["create", "clusterroles.rbac.authorization.k8s.io"],
  ["create", "validatingadmissionpolicies.admissionregistration.k8s.io"],
  [
    "create",
    "validatingadmissionpolicybindings.admissionregistration.k8s.io",
  ],
  ["get", "secrets"],
  ["create", "secrets"],
  ["create", "rolebindings.rbac.authorization.k8s.io"],
  ["create", "networkpolicies.networking.k8s.io"],
  ["update", "resourcequotas"],
  ["update", "limitranges"],
];
const deniedSiblingAuthorizations: ReadonlyArray<
  readonly [verb: string, resource: string]
> = [
  ["get", "pods"],
  ["get", "services"],
  ["create", "statefulsets.apps"],
  ["create", "pods/exec"],
  ["get", "secrets"],
];
const allowedFirstmateAuthorizations: ReadonlyArray<
  readonly [namespace: string, verb: string, resource: string]
> = [
  [alpha, "get", "pods"],
  [alpha, "delete", "pods"],
  [alpha, "create", "pods/exec"],
  [alpha, "patch", "statefulsets.apps"],
  [alpha, "create", "secrets"],
  [alpha, "get", "persistentvolumeclaims"],
  [alpha, "update", "roles.rbac.authorization.k8s.io"],
  [alpha, "update", "rolebindings.rbac.authorization.k8s.io"],
  [alpha, "update", "networkpolicies.networking.k8s.io"],
  [alpha, "update", "resourcequotas"],
  [beta, "get", "pods"],
  [beta, "get", "persistentvolumeclaims"],
  [beta, "patch", "statefulsets.apps"],
];
const inaccessibleNamespaces: ReadonlyArray<
  readonly [namespace: string, resource: string]
> = [
  [beta, "pods"],
  [beta, "services"],
  [beta, "secrets"],
  [core, "pods"],
  [core, "services"],
  [core, "secrets"],
];

layer(platform)("Second Mate domain lifecycle", (it) => {
  it.effect("reports malformed workload fixtures as typed failures", () =>
    Effect.gen(function*() {
      const failure = yield* workloadParts({}).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "DomainLifecycleError");
      assert.strictEqual(failure.operation, "fixture_shape");
    }));

  it.effect(
    "proves domain-local child lifecycle, sibling denial, supervision, and PVC retention",
    () => Effect.scoped(Effect.gen(function*() {
      const configuredContext = yield* Config.option(
        Config.string("AGENTOS_KUBERNETES_TEST_CONTEXT"),
      );
      if (Option.isNone(configuredContext)) return;

      const paths = yield* Path.Path;
      const kubernetes = yield* paths.fromFileUrl(kubernetesUrl);
      const context = configuredContext.value;
      const environment = yield* commandEnvironment();
      const capturedOutput = yield* Ref.make<ReadonlyArray<string>>([]);
      const alphaFixture = paths.join(
        kubernetes,
        "tests",
        "fixtures",
        "domain-alpha",
      );
      const betaFixture = paths.join(
        kubernetes,
        "tests",
        "fixtures",
        "domain-beta",
      );
      const admission = paths.join(kubernetes, "admission");
      const childFixture = paths.join(
        kubernetes,
        "tests",
        "fixtures",
        "lifecycle-child",
      );

      yield* Effect.addFinalizer(() =>
        Effect.all([
          kubectl(
            context,
            environment,
            capturedOutput,
            [
              "delete",
              "namespace",
              alpha,
              beta,
              core,
              "--ignore-not-found=true",
              "--wait=true",
            ],
          ),
          kubectl(
            context,
            environment,
            capturedOutput,
            [
              "delete",
              "--kustomize",
              admission,
              "--ignore-not-found=true",
              "--wait=true",
            ],
          ),
        ], { concurrency: "unbounded", discard: true }).pipe(Effect.ignore)
      );

      yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        ["create", "namespace", core],
      );
      yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        ["label", "namespace", core, "agentos.akua.dev/fleet=default"],
      );
      yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        [
          "--namespace",
          core,
          "create",
          "serviceaccount",
          "agentos-firstmate",
        ],
      );
      yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        ["apply", "--server-side", "--kustomize", admission],
      );

      const admissionPolicies = yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        [
          "get",
          "validatingadmissionpolicies.admissionregistration.k8s.io",
          "--output=json",
        ],
      ).pipe(Effect.flatMap((source) => decodeJson(AdmissionPolicyList, source)));
      assert.deepStrictEqual(
        admissionPolicies.items.map(({ metadata }) => metadata.name).sort(),
        ["agentos-crewmate-pods", "agentos-crewmate-statefulsets"],
      );
      assert.isTrue(
        admissionPolicies.items.every(({ status }) =>
          hasNoTypeCheckingWarnings(status)
        ),
      );

      yield* Effect.all([
        requireKubectl(
          context,
          environment,
          capturedOutput,
          ["apply", "--server-side", "--kustomize", alphaFixture],
        ),
        requireKubectl(
          context,
          environment,
          capturedOutput,
          ["apply", "--server-side", "--kustomize", betaFixture],
        ),
      ], { concurrency: "unbounded", discard: true });

      const secondmatePodUid = yield* waitForPodUid(
        context,
        environment,
        capturedOutput,
        alpha,
        "agentos-secondmate-0",
      );
      const secondmatePvcUid = yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        [
          "--namespace",
          alpha,
          "get",
          "persistentvolumeclaim/home-agentos-secondmate-0",
          "--output=jsonpath={.metadata.uid}",
        ],
      );
      const namespace = yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        ["get", `namespace/${alpha}`, "--output=json"],
      ).pipe(Effect.flatMap((source) => decodeJson(NamespaceResource, source)));
      assert.deepInclude(namespace.metadata.labels, {
        "agentos.akua.dev/owner-agent-id":
          "00000000-0000-4000-8000-00000000000a",
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": "v1.35",
      });

      const secondmateStatefulSet = yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        [
          "--namespace",
          alpha,
          "get",
          "statefulset/agentos-secondmate",
          "--output=json",
        ],
      ).pipe(Effect.flatMap((source) => decodeJson(StatefulSetResource, source)));
      const secondmateContainer = secondmateStatefulSet.spec.template.spec
        .containers[0];
      if (secondmateContainer === undefined) {
        return yield* lifecycleError(
          "fixture_shape",
          "Second Mate StatefulSet is missing its container",
        );
      }
      const secondmateEnvironment = Object.fromEntries(
        secondmateContainer.env.map(({ name, value }) => [name, value]),
      );
      assert.deepInclude(secondmateEnvironment, {
        AGENTOS_AGENT_ID: "00000000-0000-4000-8000-00000000000a",
        AGENTOS_DATABASE_URL:
          "postgresql://runtime_secondmate@agentos-postgres-rw.agentos.svc.cluster.local:5432/agentos?sslmode=require",
        HERDR_SESSION: "agentos-secondmate",
      });

      const renderedChild = yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        [
          "kustomize",
          "--load-restrictor",
          "LoadRestrictionsNone",
          childFixture,
        ],
      ).pipe(Effect.flatMap(parseYamlDocuments));
      const renderedResources = yield* requireArray(
        renderedChild,
        "rendered child",
      );
      const decodedResources = yield* Effect.forEach(
        renderedResources,
        (resource) => requireRecord(resource, "rendered child resource"),
      );
      const validChild = decodedResources.find(
        (candidate) => candidate.kind === "StatefulSet",
      );
      if (validChild === undefined) {
        return yield* lifecycleError(
          "fixture_shape",
          "Rendered child is missing its StatefulSet",
        );
      }

      const mutableImage = structuredClone(validChild);
      (yield* workloadParts(mutableImage)).container.image =
        "registry.k8s.io/pause:3.10.1";
      yield* requireAdmissionDenial(
        context,
        environment,
        capturedOutput,
        alpha,
        secondmateIdentity,
        mutableImage,
        "Every Crewmate image must be a remote image pinned by sha256 digest",
      );

      const missingLabels = structuredClone(validChild);
      const missingLabelParts = yield* workloadParts(missingLabels);
      delete missingLabelParts.labels["agentos.akua.dev/task-id"];
      delete missingLabelParts.templateLabels["agentos.akua.dev/task-id"];
      yield* requireAdmissionDenial(
        context,
        environment,
        capturedOutput,
        alpha,
        secondmateIdentity,
        missingLabels,
        "Crewmates require matching UUID Agent, owner, Task, and Assignment labels",
      );

      const unexpectedToken = structuredClone(validChild);
      (yield* workloadParts(unexpectedToken)).pod.automountServiceAccountToken =
        true;
      yield* requireAdmissionDenial(
        context,
        environment,
        capturedOutput,
        alpha,
        secondmateIdentity,
        unexpectedToken,
        "disabled token automount",
      );

      const widenedAudience = structuredClone(validChild);
      (yield* egressTokenProjection(widenedAudience)).audience = "kubernetes";
      yield* requireAdmissionDenial(
        context,
        environment,
        capturedOutput,
        alpha,
        secondmateIdentity,
        widenedAudience,
        "only the dedicated egress identity token projection",
      );

      const widenedLifetime = structuredClone(validChild);
      (yield* egressTokenProjection(widenedLifetime)).expirationSeconds =
        AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS + 600;
      yield* requireAdmissionDenial(
        context,
        environment,
        capturedOutput,
        alpha,
        secondmateIdentity,
        widenedLifetime,
        "only the dedicated egress identity token projection",
      );

      const wrongTokenPath = structuredClone(validChild);
      (yield* egressTokenProjection(wrongTokenPath)).path =
        "kubernetes-api-token";
      yield* requireAdmissionDenial(
        context,
        environment,
        capturedOutput,
        alpha,
        secondmateIdentity,
        wrongTokenPath,
        "only the dedicated egress identity token projection",
      );

      assert.deepStrictEqual(yield* egressTokenProjection(validChild), {
        audience: AGENTOS_EGRESS_TOKEN_AUDIENCE,
        expirationSeconds: AGENTOS_EGRESS_TOKEN_EXPIRATION_SECONDS,
        path: "token",
      });

      const initContainerToken = structuredClone(validChild);
      const initContainerTokenParts = yield* workloadParts(initContainerToken);
      initContainerTokenParts.pod.initContainers = [{
        ...structuredClone(initContainerTokenParts.container),
        name: "identity-reading-init",
      }];
      yield* requireAdmissionDenial(
        context,
        environment,
        capturedOutput,
        alpha,
        secondmateIdentity,
        initContainerToken,
        "only the dedicated egress identity token projection",
      );

      const hostAccess = structuredClone(validChild);
      (yield* workloadParts(hostAccess)).pod.hostNetwork = true;
      yield* requireAdmissionDenial(
        context,
        environment,
        capturedOutput,
        alpha,
        secondmateIdentity,
        hostAccess,
        "cannot use host namespaces",
      );

      const excessiveResources = structuredClone(validChild);
      const excessiveContainer = (yield* workloadParts(excessiveResources))
        .container;
      const resourceRequirements = yield* requireRecord(
        excessiveContainer.resources,
        "container.resources",
      );
      const resourceLimits = yield* requireRecord(
        resourceRequirements.limits,
        "container.resources.limits",
      );
      resourceLimits.cpu = "8";
      yield* requireAdmissionDenial(
        context,
        environment,
        capturedOutput,
        alpha,
        secondmateIdentity,
        excessiveResources,
        "within the domain ceiling",
      );

      const providerCredentialWorkload = structuredClone(validChild);
      const providerCredentialContainer = (
        yield* workloadParts(providerCredentialWorkload)
      ).container;
      const providerEnvironment = providerCredentialContainer.env === undefined
        ? []
        : yield* requireArray(
          providerCredentialContainer.env,
          "container.env",
        );
      providerEnvironment.push({
        name: "OPENAI_API_KEY",
        value: providerRootCredential,
      });
      providerCredentialContainer.env = providerEnvironment;
      yield* requireAdmissionDenial(
        context,
        environment,
        capturedOutput,
        alpha,
        secondmateIdentity,
        providerCredentialWorkload,
        "Direct provider-root credential environment variables are not permitted",
      );

      const selfMutationPatch = yield* encodeJson({
        metadata: { annotations: { "agentos.akua.dev/test": "denied" } },
      });
      const selfMutation = yield* kubectl(
        context,
        environment,
        capturedOutput,
        [
          "--namespace",
          alpha,
          "--as",
          secondmateIdentity,
          "patch",
          "statefulset/agentos-secondmate",
          "--dry-run=server",
          "--type=merge",
          "--patch",
          selfMutationPatch,
        ],
      );
      assert.strictEqual(selfMutation.exitCode, 1);
      assert.include(
        selfMutation.stderr,
        "A Second Mate cannot create, update, or delete its persistent Mate workload",
      );

      for (const [verb, resource] of allowedSecondmateAuthorizations) {
        assert.isTrue(yield* canI(
          context,
          environment,
          capturedOutput,
          secondmateIdentity,
          alpha,
          verb,
          resource,
        ));
      }
      for (const [verb, resource] of deniedSecondmateAuthorizations) {
        assert.isFalse(yield* canI(
          context,
          environment,
          capturedOutput,
          secondmateIdentity,
          alpha,
          verb,
          resource,
        ));
      }
      for (const [verb, resource] of deniedSiblingAuthorizations) {
        assert.isFalse(yield* canI(
          context,
          environment,
          capturedOutput,
          secondmateIdentity,
          beta,
          verb,
          resource,
        ));
      }

      for (
        const [namespaceName, verb, resource] of allowedFirstmateAuthorizations
      ) {
        assert.isTrue(yield* canI(
          context,
          environment,
          capturedOutput,
          firstmateIdentity,
          namespaceName,
          verb,
          resource,
        ));
      }

      for (const [namespaceName, resource] of inaccessibleNamespaces) {
        assert.isFalse(yield* canI(
          context,
          environment,
          capturedOutput,
          secondmateIdentity,
          namespaceName,
          "get",
          resource,
        ));
      }

      yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        [
          "--namespace",
          alpha,
          "--as",
          firstmateIdentity,
          "delete",
          "pod/agentos-secondmate-0",
          "--wait=true",
        ],
      );
      assert.notStrictEqual(
        yield* waitForPodUid(
          context,
          environment,
          capturedOutput,
          alpha,
          "agentos-secondmate-0",
          secondmatePodUid,
        ),
        secondmatePodUid,
      );
      assert.strictEqual(
        yield* requireKubectl(
          context,
          environment,
          capturedOutput,
          [
            "--namespace",
            alpha,
            "get",
            "persistentvolumeclaim/home-agentos-secondmate-0",
            "--output=jsonpath={.metadata.uid}",
          ],
        ),
        secondmatePvcUid,
      );

      yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        [
          "--namespace",
          alpha,
          "--as",
          secondmateIdentity,
          "apply",
          "--server-side",
          "--kustomize",
          childFixture,
        ],
      );
      yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        [
          "--namespace",
          alpha,
          "rollout",
          "status",
          "statefulset/agentos-crewmate",
          "--timeout=180s",
        ],
      );

      const podUid = yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        [
          "--namespace",
          alpha,
          "get",
          "pod/agentos-crewmate-0",
          "--output=jsonpath={.metadata.uid}",
        ],
      );
      const pvcUid = yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        [
          "--namespace",
          alpha,
          "get",
          "persistentvolumeclaim/home-agentos-crewmate-0",
          "--output=jsonpath={.metadata.uid}",
        ],
      );

      yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        [
          "--namespace",
          alpha,
          "--as",
          secondmateIdentity,
          "delete",
          "pod/agentos-crewmate-0",
          "--wait=true",
        ],
      );
      const replacementUid = yield* waitForPodUid(
        context,
        environment,
        capturedOutput,
        alpha,
        "agentos-crewmate-0",
        podUid,
        true,
      );
      assert.notStrictEqual(replacementUid, podUid);
      assert.strictEqual(
        yield* requireKubectl(
          context,
          environment,
          capturedOutput,
          [
            "--namespace",
            alpha,
            "get",
            "persistentvolumeclaim/home-agentos-crewmate-0",
            "--output=jsonpath={.metadata.uid}",
          ],
        ),
        pvcUid,
      );

      yield* requireKubectl(
        context,
        environment,
        capturedOutput,
        [
          "--namespace",
          alpha,
          "--as",
          secondmateIdentity,
          "delete",
          "--kustomize",
          childFixture,
          "--wait=true",
        ],
      );
      assert.strictEqual(
        yield* requireKubectl(
          context,
          environment,
          capturedOutput,
          [
            "--namespace",
            alpha,
            "get",
            "persistentvolumeclaim/home-agentos-crewmate-0",
            "--output=jsonpath={.metadata.uid}",
          ],
        ),
        pvcUid,
      );

      assert.notInclude(
        (yield* Ref.get(capturedOutput)).join("\n"),
        providerRootCredential,
      );
    })),
    300_000,
  );
});
