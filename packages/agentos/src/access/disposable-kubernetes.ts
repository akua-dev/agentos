import {
  Clock,
  Effect,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";

export const disposableAccessProbeImage =
  "docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";

const KubernetesNameSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(63),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  ),
);
const OptionsSchema = Schema.Struct({
  context: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(128),
      Schema.isPattern(/^kind-agentos-(?:access|resilience)-[a-z0-9-]+$/),
    ),
  ),
  approvalReference: Schema.String.pipe(
    Schema.check(
      Schema.isMaxLength(128),
      Schema.isPattern(/^approval:[0-9A-Za-z._:-]+$/),
    ),
  ),
  namespacePrefix: KubernetesNameSchema,
  revocationSloMillis: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(60_000),
    ),
  ),
  hotReloadSloMillis: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(15_000),
    ),
  ),
  loadAttempts: Schema.Number.pipe(
    Schema.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(16),
      Schema.isLessThanOrEqualTo(64),
    ),
  ),
});
const KubeconfigSchema = Schema.fromJsonString(Schema.Struct({
  clusters: Schema.Tuple([Schema.Struct({
    cluster: Schema.Struct({ server: Schema.String }),
  })]),
}));
const TokenReviewRequestSchema = Schema.fromJsonString(Schema.Struct({
  apiVersion: Schema.Literal("authentication.k8s.io/v1"),
  kind: Schema.Literal("TokenReview"),
  spec: Schema.Struct({
    token: Schema.String,
    audiences: Schema.Tuple([Schema.Literal("agentos-egress-authz")]),
  }),
}));
const TokenReviewResponseSchema = Schema.fromJsonString(Schema.Struct({
  status: Schema.Struct({
    authenticated: Schema.optionalKey(Schema.Boolean),
    audiences: Schema.optionalKey(Schema.Array(Schema.String)),
    user: Schema.optionalKey(Schema.Struct({
      username: Schema.optionalKey(Schema.String),
    })),
  }),
}));
const PodSchema = Schema.fromJsonString(Schema.Struct({
  apiVersion: Schema.Literal("v1"),
  kind: Schema.Literal("Pod"),
  metadata: Schema.Struct({
    name: KubernetesNameSchema,
    labels: Schema.Struct({ app: KubernetesNameSchema }),
  }),
  spec: Schema.Struct({
    serviceAccountName: KubernetesNameSchema,
    automountServiceAccountToken: Schema.Literal(false),
    restartPolicy: Schema.Literal("Never"),
    terminationGracePeriodSeconds: Schema.Literal(1),
    securityContext: Schema.Struct({
      runAsNonRoot: Schema.Literal(true),
      runAsUser: Schema.Literal(65_535),
      runAsGroup: Schema.Literal(65_535),
      fsGroup: Schema.Literal(65_535),
      seccompProfile: Schema.Struct({ type: Schema.Literal("RuntimeDefault") }),
    }),
    containers: Schema.Tuple([Schema.Struct({
      name: Schema.Literal("probe"),
      image: Schema.Literal(disposableAccessProbeImage),
      imagePullPolicy: Schema.Literal("IfNotPresent"),
      command: Schema.Tuple([
        Schema.Literal("/bin/sh"),
        Schema.Literal("-c"),
        Schema.Literal("sleep 3600"),
      ]),
      securityContext: Schema.Struct({
        allowPrivilegeEscalation: Schema.Literal(false),
        readOnlyRootFilesystem: Schema.Literal(true),
        capabilities: Schema.Struct({
          drop: Schema.Tuple([Schema.Literal("ALL")]),
        }),
      }),
      volumeMounts: Schema.Tuple([Schema.Struct({
        name: Schema.Literal("identity"),
        mountPath: Schema.Literal("/var/run/secrets/agentos-egress"),
        readOnly: Schema.Literal(true),
      })]),
    })]),
    volumes: Schema.Tuple([Schema.Struct({
      name: Schema.Literal("identity"),
      projected: Schema.Struct({
        defaultMode: Schema.Literal(288),
        sources: Schema.Tuple([Schema.Struct({
          serviceAccountToken: Schema.Struct({
            audience: Schema.Literal("agentos-egress-authz"),
            expirationSeconds: Schema.Literal(600),
            path: Schema.Literal("token"),
          }),
        })]),
      }),
    })]),
  }),
}));
const RoleBindingSchema = Schema.fromJsonString(Schema.Struct({
  apiVersion: Schema.Literal("rbac.authorization.k8s.io/v1"),
  kind: Schema.Literal("RoleBinding"),
  metadata: Schema.Struct({ name: Schema.Literal("access-hot-reload") }),
  roleRef: Schema.Struct({
    apiGroup: Schema.Literal("rbac.authorization.k8s.io"),
    kind: Schema.Literal("Role"),
    name: Schema.Literal("access-hot-reload"),
  }),
  subjects: Schema.Array(Schema.Struct({
    kind: Schema.Literal("ServiceAccount"),
    name: KubernetesNameSchema,
    namespace: KubernetesNameSchema,
  })).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(2))),
}));

const TokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const TokenPath = "/var/run/secrets/agentos-egress/token";

export class DisposableAccessProofError extends Schema.TaggedErrorClass<DisposableAccessProofError>()(
  "DisposableAccessProofError",
  {
    operation: Schema.Literals([
      "invalid_configuration",
      "context_not_disposable",
      "kubectl",
      "token_review",
      "identity_mismatch",
      "revocation_timeout",
      "hot_reload_timeout",
      "access_plane_not_absent",
      "internet_unavailable",
    ]),
  },
) {}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DisposableAccessPlaneEvidence {
  readonly version: 1;
  readonly context: string;
  readonly approvalReference: string;
  readonly revocationMillis: number;
  readonly hotReloadMillis: number;
  readonly loadAttempts: number;
  readonly wrongAudienceDenied: true;
  readonly stalePodUidDenied: true;
  readonly deletedPodDenied: true;
  readonly staleServiceAccountUidDenied: true;
  readonly deletedServiceAccountDenied: true;
  readonly projectedTokensRotated: true;
  readonly unrelatedSubjectAllowed: true;
  readonly ordinaryInternetAllowed: true;
  readonly namespacesDeleted: true;
  readonly productionEndpointContacted: false;
}

export const runDisposableAccessPlaneProof = Effect.fn(
  "agentos.access.runDisposableProof",
)(function*(untrusted: unknown) {
  const options = yield* Schema.decodeUnknownEffect(OptionsSchema, {
    onExcessProperty: "error",
  })(untrusted).pipe(
    Effect.mapError(() => proofError("invalid_configuration")),
  );
  const kubeconfig = yield* requireKubectl(
    options.context,
    ["config", "view", "--minify", "--output=json"],
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(KubeconfigSchema)),
    Effect.mapError(() => proofError("context_not_disposable")),
  );
  const server = kubeconfig.clusters[0].cluster.server;
  const serverUrl = URL.canParse(server) ? new URL(server) : null;
  if (
    serverUrl === null || serverUrl.protocol !== "https:" ||
    (serverUrl.hostname !== "127.0.0.1" && serverUrl.hostname !== "localhost")
  ) return yield* proofError("context_not_disposable");

  const suffix = (yield* Clock.currentTimeMillis).toString(36).slice(-6);
  const namespace = `${options.namespacePrefix}-${suffix}`;
  const cleanup = requireKubectl(options.context, [
    "delete",
    "namespace",
    namespace,
    "--ignore-not-found=true",
    "--wait=true",
    "--timeout=60s",
  ]);

  const evidence = yield* Effect.gen(function*() {
    yield* requireKubectl(options.context, ["create", "namespace", namespace]);
    yield* Effect.forEach(
      ["target", "service-target", "unrelated"],
      (name) =>
        requireKubectl(options.context, [
          "--namespace",
          namespace,
          "create",
          "serviceaccount",
          name,
        ]),
      { concurrency: 3, discard: true },
    );
    yield* Effect.forEach(
      [
        { name: "target", serviceAccount: "target" },
        { name: "service-target", serviceAccount: "service-target" },
        { name: "unrelated", serviceAccount: "unrelated" },
      ],
      ({ name, serviceAccount }) =>
        applyPod(options.context, namespace, name, serviceAccount),
      { concurrency: 3, discard: true },
    );
    yield* Effect.forEach(
      ["target", "service-target", "unrelated"],
      (pod) => waitForPod(options.context, namespace, pod, 60_000),
      { concurrency: 3, discard: true },
    );

    const [targetToken, serviceToken, unrelatedToken] = yield* Effect.all([
      readProjectedToken(options.context, namespace, "target"),
      readProjectedToken(options.context, namespace, "service-target"),
      readProjectedToken(options.context, namespace, "unrelated"),
    ], { concurrency: 3 });
    yield* Effect.all([
      requireAuthenticated(
        options.context,
        targetToken,
        `system:serviceaccount:${namespace}:target`,
      ),
      requireAuthenticated(
        options.context,
        serviceToken,
        `system:serviceaccount:${namespace}:service-target`,
      ),
      requireAuthenticated(
        options.context,
        unrelatedToken,
        `system:serviceaccount:${namespace}:unrelated`,
      ),
    ], { concurrency: 3, discard: true });

    const wrongAudienceSource = yield* requireKubectl(options.context, [
      "--namespace",
      namespace,
      "create",
      "token",
      "target",
      "--audience=agentos-wrong-audience",
      "--duration=10m",
    ]);
    const wrongAudienceToken = yield* redactToken(wrongAudienceSource);
    const wrongAudienceDenied = !(yield* reviewToken(
      options.context,
      wrongAudienceToken,
    )).authenticated;
    if (!wrongAudienceDenied) return yield* proofError("identity_mismatch");

    yield* requireKubectl(options.context, [
      "--namespace",
      namespace,
      "create",
      "role",
      "access-hot-reload",
      "--verb=get",
      "--resource=configmaps",
    ]);
    yield* applyRoleBinding(options.context, namespace, ["target", "unrelated"]);
    const initialAuthorization = yield* Effect.all([
      canI(options.context, namespace, "target"),
      canI(options.context, namespace, "unrelated"),
    ], { concurrency: 2 });
    if (!initialAuthorization.every(Boolean)) {
      return yield* proofError("identity_mismatch");
    }
    const hotReloadStarted = yield* Clock.currentTimeMillis;
    const [, hotReloadMillis] = yield* Effect.all([
      runAuthorizationLoad(
        options.context,
        namespace,
        "target",
        options.loadAttempts,
      ),
      Effect.gen(function*() {
        yield* applyRoleBinding(options.context, namespace, ["unrelated"]);
        return yield* waitForAuthorization(
          options.context,
          namespace,
          "target",
          false,
          hotReloadStarted,
          options.hotReloadSloMillis,
        );
      }),
    ], { concurrency: 2 });
    const unrelatedSubjectAllowed = yield* canI(
      options.context,
      namespace,
      "unrelated",
    );
    if (!unrelatedSubjectAllowed) {
      return yield* proofError("identity_mismatch");
    }

    const revocationStarted = yield* Clock.currentTimeMillis;
    const [, podRevocationMillis] = yield* Effect.all([
      runTokenReviewLoad(options.context, targetToken, options.loadAttempts),
      Effect.gen(function*() {
        yield* requireKubectl(options.context, [
          "--namespace",
          namespace,
          "delete",
          "pod",
          "target",
          "--wait=false",
        ]);
        return yield* waitForTokenDenial(
          options.context,
          targetToken,
          revocationStarted,
          options.revocationSloMillis,
        );
      }),
    ], { concurrency: 2 });
    const deletedPodDenied = !(yield* reviewToken(
      options.context,
      targetToken,
    )).authenticated;
    yield* waitForPodDeletion(options.context, namespace, "target", 60_000);
    yield* applyPod(options.context, namespace, "target", "target");
    yield* waitForPod(options.context, namespace, "target", 60_000);
    const rotatedTargetToken = yield* readProjectedToken(
      options.context,
      namespace,
      "target",
    );
    yield* requireAuthenticated(
      options.context,
      rotatedTargetToken,
      `system:serviceaccount:${namespace}:target`,
    );
    const stalePodUidDenied = !(yield* reviewToken(
      options.context,
      targetToken,
    )).authenticated;
    const projectedTokensRotated =
      Redacted.value(targetToken) !== Redacted.value(rotatedTargetToken);

    const serviceRevocationStarted = yield* Clock.currentTimeMillis;
    yield* requireKubectl(options.context, [
      "--namespace",
      namespace,
      "delete",
      "serviceaccount",
      "service-target",
      "--wait=true",
    ]);
    const serviceRevocationMillis = yield* waitForTokenDenial(
      options.context,
      serviceToken,
      serviceRevocationStarted,
      options.revocationSloMillis,
    );
    const deletedServiceAccountDenied = !(yield* reviewToken(
      options.context,
      serviceToken,
    )).authenticated;
    yield* requireKubectl(options.context, [
      "--namespace",
      namespace,
      "create",
      "serviceaccount",
      "service-target",
    ]);
    const staleServiceAccountUidDenied = !(yield* reviewToken(
      options.context,
      serviceToken,
    )).authenticated;
    yield* requireAuthenticated(
      options.context,
      unrelatedToken,
      `system:serviceaccount:${namespace}:unrelated`,
    );

    yield* requireAccessPlaneAbsent(options.context);
    const internet = yield* runKubectl(options.context, [
      "--namespace",
      namespace,
      "exec",
      "unrelated",
      "--",
      "wget",
      "-q",
      "-T",
      "15",
      "-O",
      "/dev/null",
      "http://example.com",
    ]);
    const ordinaryInternetAllowed = internet.exitCode === 0;
    if (!ordinaryInternetAllowed) {
      return yield* proofError("internet_unavailable");
    }

    if (
      !deletedPodDenied || !stalePodUidDenied ||
      !deletedServiceAccountDenied || !staleServiceAccountUidDenied ||
      !projectedTokensRotated
    ) return yield* proofError("identity_mismatch");

    const result: DisposableAccessPlaneEvidence = {
      version: 1,
      context: options.context,
      approvalReference: options.approvalReference,
      revocationMillis: Math.max(
        podRevocationMillis,
        serviceRevocationMillis,
      ),
      hotReloadMillis,
      loadAttempts: options.loadAttempts,
      wrongAudienceDenied: true,
      stalePodUidDenied: true,
      deletedPodDenied: true,
      staleServiceAccountUidDenied: true,
      deletedServiceAccountDenied: true,
      projectedTokensRotated: true,
      unrelatedSubjectAllowed: true,
      ordinaryInternetAllowed: true,
      namespacesDeleted: true,
      productionEndpointContacted: false,
    };
    return result;
  }).pipe(
    Effect.tapError(() => cleanup.pipe(Effect.ignore)),
    Effect.onInterrupt(() => cleanup.pipe(Effect.ignore)),
  );
  yield* cleanup;
  return evidence;
});

const runKubectl = Effect.fn("agentos.access.kubectl")(function*(
  context: string,
  arguments_: ReadonlyArray<string>,
  input?: string,
) {
  const command = ChildProcess.make(
    "kubectl",
    ["--context", context, ...arguments_],
    {
      stdin: input === undefined
        ? "ignore"
        : Stream.make(new TextEncoder().encode(input)),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return yield* Effect.scoped(Effect.gen(function*() {
    const handle = yield* command;
    const [exitCode, stdout, stderr] = yield* Effect.all([
      handle.exitCode.pipe(Effect.map(Number)),
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stdout, stderr } satisfies CommandResult;
  })).pipe(Effect.mapError(() => proofError("kubectl")));
});

const requireKubectl = Effect.fn("agentos.access.requireKubectl")(
  function*(
    context: string,
    arguments_: ReadonlyArray<string>,
    input?: string,
  ) {
    const result = yield* runKubectl(context, arguments_, input);
    if (result.exitCode !== 0) return yield* proofError("kubectl");
    return result.stdout;
  },
);

const applyPod = Effect.fn("agentos.access.applyProbePod")(function*(
  context: string,
  namespace: string,
  name: string,
  serviceAccount: string,
) {
  const manifest = yield* Schema.encodeEffect(PodSchema)(
    pod(name, serviceAccount),
  ).pipe(Effect.mapError(() => proofError("kubectl")));
  yield* requireKubectl(
    context,
    ["--namespace", namespace, "apply", "--filename=-"],
    manifest,
  );
});

function pod(name: string, serviceAccount: string): typeof PodSchema.Type {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, labels: { app: name } },
    spec: {
      serviceAccountName: serviceAccount,
      automountServiceAccountToken: false,
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 1,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65_535,
        runAsGroup: 65_535,
        fsGroup: 65_535,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [{
        name: "probe",
        image: disposableAccessProbeImage,
        imagePullPolicy: "IfNotPresent",
        command: ["/bin/sh", "-c", "sleep 3600"],
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ["ALL"] },
        },
        volumeMounts: [{
          name: "identity",
          mountPath: "/var/run/secrets/agentos-egress",
          readOnly: true,
        }],
      }],
      volumes: [{
        name: "identity",
        projected: {
          defaultMode: 0o440,
          sources: [{
            serviceAccountToken: {
              audience: "agentos-egress-authz",
              expirationSeconds: 600,
              path: "token",
            },
          }],
        },
      }],
    },
  };
}

const applyRoleBinding = Effect.fn("agentos.access.applyHotReloadBinding")(
  function*(context: string, namespace: string, subjects: ReadonlyArray<string>) {
    const binding: typeof RoleBindingSchema.Type = {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: { name: "access-hot-reload" },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: "access-hot-reload",
      },
      subjects: subjects.map((name) => ({
        kind: "ServiceAccount",
        name,
        namespace,
      })),
    };
    const manifest = yield* Schema.encodeEffect(RoleBindingSchema)(binding)
      .pipe(Effect.mapError(() => proofError("kubectl")));
    yield* requireKubectl(
      context,
      ["--namespace", namespace, "apply", "--filename=-"],
      manifest,
    );
  },
);

const waitForPod = Effect.fn("agentos.access.waitForProbePod")(function*(
  context: string,
  namespace: string,
  podName: string,
  timeoutMillis: number,
) {
  const result = yield* runKubectl(context, [
    "--namespace",
    namespace,
    "wait",
    "--for=condition=Ready",
    `pod/${podName}`,
    `--timeout=${timeoutMillis}ms`,
  ]);
  if (result.exitCode !== 0) return yield* proofError("kubectl");
});

const waitForPodDeletion = Effect.fn("agentos.access.waitForProbeDeletion")(
  function*(
    context: string,
    namespace: string,
    podName: string,
    timeoutMillis: number,
  ) {
    const result = yield* runKubectl(context, [
      "--namespace",
      namespace,
      "wait",
      "--for=delete",
      `pod/${podName}`,
      `--timeout=${timeoutMillis}ms`,
    ]);
    if (result.exitCode !== 0) return yield* proofError("kubectl");
  },
);

const readProjectedToken = Effect.fn("agentos.access.readProjectedToken")(
  function*(context: string, namespace: string, podName: string) {
    const source = yield* requireKubectl(context, [
      "--namespace",
      namespace,
      "exec",
      podName,
      "--",
      "cat",
      TokenPath,
    ]);
    return yield* redactToken(source);
  },
);

function redactToken(source: string) {
  const token = source.trim();
  return TokenPattern.test(token) && token.length <= 16 * 1_024
    ? Effect.succeed(Redacted.make(token))
    : Effect.fail(proofError("token_review"));
}

const reviewToken = Effect.fn("agentos.access.reviewProjectedToken")(
  function*(context: string, token: Redacted.Redacted<string>) {
    const request = yield* Schema.encodeEffect(TokenReviewRequestSchema)({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      spec: {
        token: Redacted.value(token),
        audiences: ["agentos-egress-authz"],
      },
    }).pipe(Effect.mapError(() => proofError("token_review")));
    const response = yield* requireKubectl(
      context,
      [
        "create",
        "--raw=/apis/authentication.k8s.io/v1/tokenreviews",
        "--filename=-",
      ],
      request,
    );
    const decoded = yield* Schema.decodeUnknownEffect(TokenReviewResponseSchema)(
      response,
    ).pipe(Effect.mapError(() => proofError("token_review")));
    return {
      authenticated: decoded.status.authenticated ?? false,
      audiences: decoded.status.audiences ?? [],
      username: decoded.status.user?.username ?? null,
    };
  },
);

const requireAuthenticated = Effect.fn("agentos.access.requireLiveIdentity")(
  function*(
    context: string,
    token: Redacted.Redacted<string>,
    expectedUsername: string,
  ) {
    const review = yield* reviewToken(context, token);
    if (
      !review.authenticated || review.username !== expectedUsername ||
      !review.audiences.includes("agentos-egress-authz")
    ) return yield* proofError("identity_mismatch");
  },
);

const waitForTokenDenial = Effect.fn("agentos.access.waitForTokenDenial")(
  function*(
    context: string,
    token: Redacted.Redacted<string>,
    startedAtMillis: number,
    sloMillis: number,
  ) {
    while ((yield* Clock.currentTimeMillis) - startedAtMillis <= sloMillis) {
      if (!(yield* reviewToken(context, token)).authenticated) {
        return (yield* Clock.currentTimeMillis) - startedAtMillis;
      }
      yield* Effect.sleep("100 millis");
    }
    return yield* proofError("revocation_timeout");
  },
);

const runTokenReviewLoad = Effect.fn("agentos.access.tokenReviewLoad")(
  function*(
    context: string,
    token: Redacted.Redacted<string>,
    attempts: number,
  ) {
    yield* Effect.forEach(
      Array.from({ length: attempts }),
      () => reviewToken(context, token),
      { concurrency: "unbounded", discard: true },
    );
  },
);

const canI = Effect.fn("agentos.access.canI")(function*(
  context: string,
  namespace: string,
  serviceAccount: string,
) {
  const result = yield* runKubectl(context, [
    "auth",
    "can-i",
    "get",
    "configmaps",
    `--as=system:serviceaccount:${namespace}:${serviceAccount}`,
    "--namespace",
    namespace,
  ]);
  const answer = result.stdout.trim();
  if (
    (result.exitCode !== 0 && result.exitCode !== 1) ||
    (answer !== "yes" && answer !== "no")
  ) return yield* proofError("kubectl");
  return answer === "yes";
});

const runAuthorizationLoad = Effect.fn("agentos.access.authorizationLoad")(
  function*(
    context: string,
    namespace: string,
    serviceAccount: string,
    attempts: number,
  ) {
    yield* Effect.forEach(
      Array.from({ length: attempts }),
      () => canI(context, namespace, serviceAccount),
      { concurrency: "unbounded", discard: true },
    );
  },
);

const waitForAuthorization = Effect.fn("agentos.access.waitForAuthorization")(
  function*(
    context: string,
    namespace: string,
    serviceAccount: string,
    expected: boolean,
    startedAtMillis: number,
    sloMillis: number,
  ) {
    while ((yield* Clock.currentTimeMillis) - startedAtMillis <= sloMillis) {
      if ((yield* canI(context, namespace, serviceAccount)) === expected) {
        return (yield* Clock.currentTimeMillis) - startedAtMillis;
      }
      yield* Effect.sleep("100 millis");
    }
    return yield* proofError("hot_reload_timeout");
  },
);

const requireAccessPlaneAbsent = Effect.fn("agentos.access.requirePlaneAbsent")(
  function*(context: string) {
    const source = yield* requireKubectl(context, [
      "get",
      "services",
      "--all-namespaces",
      "--output=jsonpath={range .items[*]}{.metadata.namespace}{'/'}{.metadata.name}{'\\n'}{end}",
    ]);
    const governed = [
      "/agentos-egress-authz",
      "/agentgateway-github",
      "/agentgateway-openai",
      "/github-broker",
      "/ai-gateway",
    ];
    if (source.split("\n").some((service) =>
      governed.some((name) => service.endsWith(name))
    )) return yield* proofError("access_plane_not_absent");
  },
);

function proofError(operation: DisposableAccessProofError["operation"]) {
  return DisposableAccessProofError.make({ operation });
}
