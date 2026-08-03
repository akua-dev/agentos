import {
  Clock,
  Effect,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { ChildProcess } from "effect/unstable/process";

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
      Schema.isPattern(/^kind-agentos-(?:protocol|resilience)-[a-z0-9-]+$/),
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
const StatefulSetSchema = Schema.fromJsonString(Schema.Struct({
  apiVersion: Schema.Literal("apps/v1"),
  kind: Schema.Literal("StatefulSet"),
  metadata: Schema.Struct({ name: KubernetesNameSchema }),
  spec: Schema.Struct({
    replicas: Schema.Literal(1),
    serviceName: KubernetesNameSchema,
    selector: Schema.Struct({
      matchLabels: Schema.Struct({ app: KubernetesNameSchema }),
    }),
    template: Schema.Struct({
      metadata: Schema.Struct({
        labels: Schema.Struct({ app: KubernetesNameSchema }),
      }),
      spec: Schema.Struct({
        automountServiceAccountToken: Schema.Literal(false),
        terminationGracePeriodSeconds: Schema.Literal(1),
        securityContext: Schema.Struct({
          runAsNonRoot: Schema.Literal(true),
          runAsUser: Schema.Literal(65_535),
          runAsGroup: Schema.Literal(65_535),
          seccompProfile: Schema.Struct({
            type: Schema.Literal("RuntimeDefault"),
          }),
        }),
        containers: Schema.Tuple([Schema.Struct({
          name: Schema.Literal("writer"),
          image: Schema.Literal("registry.k8s.io/pause:3.10"),
          imagePullPolicy: Schema.Literal("IfNotPresent"),
          securityContext: Schema.Struct({
            allowPrivilegeEscalation: Schema.Literal(false),
            readOnlyRootFilesystem: Schema.Literal(true),
            capabilities: Schema.Struct({
              drop: Schema.Tuple([Schema.Literal("ALL")]),
            }),
          }),
          volumeMounts: Schema.Tuple([Schema.Struct({
            name: Schema.Literal("session"),
            mountPath: Schema.Literal("/session"),
          })]),
        })]),
      }),
    }),
    volumeClaimTemplates: Schema.Tuple([Schema.Struct({
      metadata: Schema.Struct({
        name: Schema.Literal("session"),
        annotations: Schema.Struct({
          "agentos.akua.dev/native-session-ref": Schema.String,
        }),
      }),
      spec: Schema.Struct({
        accessModes: Schema.Tuple([Schema.Literal("ReadWriteOnce")]),
        storageClassName: Schema.Literal("standard"),
        resources: Schema.Struct({
          requests: Schema.Struct({ storage: Schema.Literal("8Mi") }),
        }),
      }),
    })]),
  }),
}));

export class DisposableProtocolProofError extends Schema.TaggedErrorClass<DisposableProtocolProofError>()(
  "DisposableProtocolProofError",
  {
    operation: Schema.Literals([
      "invalid_configuration",
      "context_not_disposable",
      "kubectl",
      "token_review",
      "revocation_timeout",
    ]),
  },
) {}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export const runDisposableProtocolIdentityProof = Effect.fn(
  "agentos.protocol.runDisposableIdentityProof",
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
    serverUrl === null ||
    serverUrl.protocol !== "https:" ||
    (serverUrl.hostname !== "127.0.0.1" &&
      serverUrl.hostname !== "localhost")
  ) {
    return yield* proofError("context_not_disposable");
  }

  const suffix = `${(yield* Clock.currentTimeMillis).toString(36).slice(-6)}`;
  const core = `${options.namespacePrefix}-core-${suffix}`;
  const alpha = `${options.namespacePrefix}-alpha-${suffix}`;
  const beta = `${options.namespacePrefix}-beta-${suffix}`;
  const namespaces = [core, alpha, beta];
  const cleanup = Effect.forEach(namespaces, (namespace) =>
    requireKubectl(options.context, [
      "delete",
      "namespace",
      namespace,
      "--ignore-not-found=true",
      "--wait=true",
      "--timeout=60s",
    ]), { concurrency: 3, discard: true });

  const evidence = yield* Effect.gen(function*() {
    yield* Effect.forEach(namespaces, (namespace) =>
      requireKubectl(options.context, ["create", "namespace", namespace]), {
      concurrency: 3,
      discard: true,
    });
    yield* Effect.forEach([
      { namespace: core, name: "firstmate" },
      { namespace: alpha, name: "child" },
      { namespace: alpha, name: "sibling" },
      { namespace: beta, name: "cross-domain" },
    ], ({ namespace, name }) =>
      requireKubectl(options.context, [
        "--namespace",
        namespace,
        "create",
        "serviceaccount",
        name,
      ]), { concurrency: 4, discard: true });
    yield* requireKubectl(options.context, [
      "--namespace",
      alpha,
      "create",
      "role",
      "a2a-direct-edge",
      "--verb=get",
      "--resource=configmaps",
    ]);
    yield* requireKubectl(options.context, [
      "--namespace",
      alpha,
      "create",
      "rolebinding",
      "a2a-direct-edge",
      "--role=a2a-direct-edge",
      `--serviceaccount=${core}:firstmate`,
      `--serviceaccount=${alpha}:child`,
    ]);

    const [parentAllowed, childAllowed, siblingAllowed, crossDomainAllowed] =
      yield* Effect.all([
        canI(options.context, core, "firstmate", alpha),
        canI(options.context, alpha, "child", alpha),
        canI(options.context, alpha, "sibling", alpha),
        canI(options.context, beta, "cross-domain", alpha),
      ], { concurrency: 4 });
    const [piReplacement, codexReplacement] = yield* Effect.all([
      proveWriterReplacement(
        options.context,
        core,
        "acp-pi",
        "pi:/session/native/pi-session.jsonl",
      ),
      proveWriterReplacement(
        options.context,
        core,
        "acp-codex",
        "codex:10000000-0000-4000-8000-000000000001",
      ),
    ], { concurrency: 2 });
    const tokenSource = yield* requireKubectl(options.context, [
      "--namespace",
      alpha,
      "create",
      "token",
      "child",
      "--audience=agentos-egress-authz",
      "--duration=10m",
    ]);
    const token = Redacted.make(tokenSource.trim());
    const initialReview = yield* reviewToken(options.context, token);
    const expectedUsername = `system:serviceaccount:${alpha}:child`;
    if (
      !initialReview.authenticated ||
      initialReview.username !== expectedUsername ||
      !initialReview.audiences.includes("agentos-egress-authz")
    ) {
      return yield* proofError("token_review");
    }
    const revocationStarted = yield* Clock.currentTimeMillis;
    yield* requireKubectl(options.context, [
      "--namespace",
      alpha,
      "delete",
      "serviceaccount",
      "child",
      "--wait=true",
    ]);
    const revocationMillis = yield* waitForRevocation(
      options.context,
      token,
      revocationStarted,
      options.revocationSloMillis,
    );
    return {
      version: 1,
      context: options.context,
      approvalReference: options.approvalReference,
      productionEndpointContacted: false,
      parentChildAllowed: parentAllowed && childAllowed,
      siblingDenied: !siblingAllowed,
      crossDomainDenied: !crossDomainAllowed,
      tokenReviewAuthenticated: initialReview.authenticated,
      expiredIdentityDenied: true,
      revocationMillis,
      piPodReplaced: piReplacement.podReplaced,
      piNativeSessionResumed: piReplacement.nativeSessionResumed,
      codexPodReplaced: codexReplacement.podReplaced,
      codexNativeSessionResumed: codexReplacement.nativeSessionResumed,
      namespacesDeleted: true,
    };
  }).pipe(
    Effect.tapError(() => cleanup.pipe(Effect.ignore)),
    Effect.onInterrupt(() => cleanup.pipe(Effect.ignore)),
  );
  yield* cleanup;
  return evidence;
});

const runKubectl = Effect.fn("agentos.protocol.kubectl")(function*(
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

const requireKubectl = Effect.fn("agentos.protocol.requireKubectl")(
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

const canI = Effect.fn("agentos.protocol.kubectlCanI")(function*(
  context: string,
  namespace: string,
  serviceAccount: string,
  targetNamespace: string,
) {
  const result = yield* runKubectl(context, [
    "auth",
    "can-i",
    "get",
    "configmaps",
    `--as=system:serviceaccount:${namespace}:${serviceAccount}`,
    "--namespace",
    targetNamespace,
  ]);
  const answer = result.stdout.trim();
  if (
    (result.exitCode !== 0 && result.exitCode !== 1) ||
    (answer !== "yes" && answer !== "no")
  ) {
    return yield* proofError("kubectl");
  }
  return answer === "yes";
});

const proveWriterReplacement = Effect.fn(
  "agentos.protocol.proveWriterReplacement",
)(function*(
  context: string,
  namespace: string,
  name: string,
  nativeSessionReference: string,
) {
  const manifest = yield* Schema.encodeEffect(StatefulSetSchema)(
    statefulSet(name, nativeSessionReference),
  ).pipe(Effect.mapError(() => proofError("kubectl")));
  yield* requireKubectl(
    context,
    ["--namespace", namespace, "apply", "--filename=-"],
    manifest,
  );
  const initialPodUid = yield* waitForPodUid(
    context,
    namespace,
    `${name}-0`,
    null,
    60_000,
  );
  const initialPvc = yield* pvcIdentity(
    context,
    namespace,
    `session-${name}-0`,
  );
  yield* requireKubectl(context, [
    "--namespace",
    namespace,
    "delete",
    "pod",
    `${name}-0`,
    "--wait=true",
    "--timeout=60s",
  ]);
  const replacementPodUid = yield* waitForPodUid(
    context,
    namespace,
    `${name}-0`,
    initialPodUid,
    60_000,
  );
  const replacementPvc = yield* pvcIdentity(
    context,
    namespace,
    `session-${name}-0`,
  );
  return {
    podReplaced: replacementPodUid !== initialPodUid,
    nativeSessionResumed:
      initialPvc.uid === replacementPvc.uid &&
      initialPvc.nativeSessionReference === nativeSessionReference &&
      replacementPvc.nativeSessionReference === nativeSessionReference,
  };
});

function statefulSet(
  name: string,
  nativeSessionReference: string,
): typeof StatefulSetSchema.Type {
  return {
    apiVersion: "apps/v1",
    kind: "StatefulSet",
    metadata: { name },
    spec: {
      replicas: 1,
      serviceName: name,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { app: name } },
        spec: {
          automountServiceAccountToken: false,
          terminationGracePeriodSeconds: 1,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65_535,
            runAsGroup: 65_535,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [{
            name: "writer",
            image: "registry.k8s.io/pause:3.10",
            imagePullPolicy: "IfNotPresent",
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [{ name: "session", mountPath: "/session" }],
          }],
        },
      },
      volumeClaimTemplates: [{
        metadata: {
          name: "session",
          annotations: {
            "agentos.akua.dev/native-session-ref": nativeSessionReference,
          },
        },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: "standard",
          resources: { requests: { storage: "8Mi" } },
        },
      }],
    },
  };
}

const waitForPodUid = Effect.fn("agentos.protocol.waitForReplacementPod")(
  function*(
    context: string,
    namespace: string,
    pod: string,
    previousUid: string | null,
    timeoutMillis: number,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    while ((yield* Clock.currentTimeMillis) - startedAt <= timeoutMillis) {
      const result = yield* runKubectl(context, [
        "--namespace",
        namespace,
        "get",
        "pod",
        pod,
        "--output=jsonpath={.metadata.uid}{'|'}{.status.conditions[?(@.type=='Ready')].status}",
      ]);
      if (result.exitCode === 0) {
        const [uid, ready] = result.stdout.split("|");
        if (
          uid !== undefined &&
          uid !== "" &&
          uid !== previousUid &&
          ready === "True"
        ) {
          return uid;
        }
      }
      yield* Effect.sleep("250 millis");
    }
    return yield* proofError("kubectl");
  },
);

const pvcIdentity = Effect.fn("agentos.protocol.readSessionPvcIdentity")(
  function*(context: string, namespace: string, pvc: string) {
    const source = yield* requireKubectl(context, [
      "--namespace",
      namespace,
      "get",
      "persistentvolumeclaim",
      pvc,
      "--output=jsonpath={.metadata.uid}{'|'}{.metadata.annotations.agentos\\.akua\\.dev/native-session-ref}",
    ]);
    const separator = source.indexOf("|");
    if (separator <= 0 || separator === source.length - 1) {
      return yield* proofError("kubectl");
    }
    return {
      uid: source.slice(0, separator),
      nativeSessionReference: source.slice(separator + 1),
    };
  },
);

const reviewToken = Effect.fn("agentos.protocol.reviewProjectedToken")(
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

const waitForRevocation = Effect.fn("agentos.protocol.waitForTokenRevocation")(
  function*(
    context: string,
    token: Redacted.Redacted<string>,
    startedAtMillis: number,
    sloMillis: number,
  ) {
    while ((yield* Clock.currentTimeMillis) - startedAtMillis <= sloMillis) {
      const review = yield* reviewToken(context, token);
      if (!review.authenticated) {
        return (yield* Clock.currentTimeMillis) - startedAtMillis;
      }
      yield* Effect.sleep("250 millis");
    }
    return yield* proofError("revocation_timeout");
  },
);

function proofError(operation: DisposableProtocolProofError["operation"]) {
  return DisposableProtocolProofError.make({ operation });
}
