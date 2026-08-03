import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, layer } from "@effect/vitest";
import {
  Config,
  ConfigProvider,
  Crypto,
  Effect,
  Encoding,
  FileSystem,
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

const fixtureUrl = new URL("./fixtures/secret-projection/pods.yaml", import.meta.url);
const secretName = "managed-credential";
const expectedLabels = {
  "agentos.akua.dev/secret-owner": "test-service",
  "agentos.akua.dev/secret-schema": "token-version-v1",
  "agentos.akua.dev/secret-scope": "disposable-proof",
  "app.kubernetes.io/managed-by": "agentos",
};
const platform = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv()),
);
const StringRecord = Schema.Record(Schema.String, Schema.String);
const RenderedSecret = Schema.Struct({
  apiVersion: Schema.String,
  data: StringRecord,
  kind: Schema.Literal("Secret"),
  metadata: Schema.Struct({ name: Schema.String }),
});
const ManagedSecretManifest = Schema.Struct({
  apiVersion: Schema.String,
  data: StringRecord,
  kind: Schema.Literal("Secret"),
  metadata: Schema.Struct({
    labels: StringRecord,
    name: Schema.String,
    resourceVersion: Schema.optional(Schema.String),
  }),
  type: Schema.String,
});
const ObservedSecret = Schema.Struct({
  data: StringRecord,
  metadata: Schema.Struct({
    annotations: Schema.optional(StringRecord),
    labels: Schema.optional(StringRecord),
    resourceVersion: Schema.String,
    uid: Schema.String,
  }),
  type: Schema.String,
});

type CommandEnvironment = Readonly<Record<string, string>>;
type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};
type SecretSnapshot = {
  readonly annotations: ReadonlyArray<string>;
  readonly dataKeys: ReadonlyArray<string>;
  readonly labels: Readonly<Record<string, string>>;
  readonly resourceVersion: string;
  readonly type: string;
  readonly uid: string;
};

class SecretLifecycleError extends Schema.TaggedErrorClass<SecretLifecycleError>()(
  "SecretLifecycleError",
  {
    detail: Schema.optional(Schema.String),
    operation: Schema.String,
  },
) {}

class ManagedSecretContractError
  extends Schema.TaggedErrorClass<ManagedSecretContractError>()(
    "ManagedSecretContractError",
    {
      reason: Schema.Literals([
        "annotations_present",
        "data_keys_mismatch",
        "labels_mismatch",
        "type_mismatch",
      ]),
    },
  )
{}

const lifecycleError = (operation: string, detail?: string) =>
  SecretLifecycleError.make({ detail, operation });

function encodeJson<S extends Schema.Constraint>(schema: S, value: S["Type"]) {
  return Schema.encodeEffect(Schema.fromJsonString(schema))(value);
}

function decodeJson<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  source: string,
) {
  return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(source);
}

const commandEnvironment = Effect.fn(
  "test.secretLifecycle.commandEnvironment",
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

const kubectl = Effect.fn("test.secretLifecycle.kubectl")(function*(
  context: string,
  environment: CommandEnvironment,
  capturedOutput: Ref.Ref<ReadonlyArray<string>>,
  namespace: string,
  arguments_: ReadonlyArray<string>,
  captureStdout = true,
) {
  const command = [
    "--context",
    context,
    ...(namespace === "" ? [] : ["--namespace", namespace]),
    ...arguments_,
  ];
  const result = yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make("kubectl", command, {
      env: environment,
      extendEnv: false,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  })).pipe(Effect.mapError(() => lifecycleError("kubectl_spawn")));
  yield* Ref.update(capturedOutput, (captured) => [
    ...captured,
    ...(captureStdout ? [result.stdout] : []),
    result.stderr,
  ]);
  return result;
});

const requireKubectl = Effect.fn(
  "test.secretLifecycle.requireKubectl",
)(function*(
  context: string,
  environment: CommandEnvironment,
  capturedOutput: Ref.Ref<ReadonlyArray<string>>,
  namespace: string,
  arguments_: ReadonlyArray<string>,
  captureStdout = true,
) {
  const result = yield* kubectl(
    context,
    environment,
    capturedOutput,
    namespace,
    arguments_,
    captureStdout,
  );
  if (result.exitCode !== 0 || result.stderr !== "") {
    return yield* lifecycleError(
      "kubectl_command",
      `status=${result.exitCode}; stderr=${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
});

const submitJson = Effect.fn("test.secretLifecycle.submitJson")(function*(
  context: string,
  environment: CommandEnvironment,
  capturedOutput: Ref.Ref<ReadonlyArray<string>>,
  namespace: string,
  operation: "create" | "replace",
  source: string,
) {
  const result = yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(
      "kubectl",
      [
        "--context",
        context,
        "--namespace",
        namespace,
        operation,
        "--filename=-",
        "--output=name",
      ],
      {
        env: environment,
        extendEnv: false,
        stdin: Stream.make(new TextEncoder().encode(source)),
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  })).pipe(Effect.mapError(() => lifecycleError("kubectl_submit")));
  yield* Ref.update(capturedOutput, (captured) => [
    ...captured,
    result.stdout,
    result.stderr,
  ]);
  return result;
});

const writeManagedSecret = Effect.fn(
  "test.secretLifecycle.writeManagedSecret",
)(function*(
  context: string,
  environment: CommandEnvironment,
  capturedOutput: Ref.Ref<ReadonlyArray<string>>,
  namespace: string,
  operation: "create" | "replace",
  tokenFile: string,
  versionFile: string,
  resourceVersion = "",
) {
  const renderedResult = yield* kubectl(
    context,
    environment,
    capturedOutput,
    namespace,
    [
      "create",
      "secret",
      "generic",
      secretName,
      `--from-file=token=${tokenFile}`,
      `--from-file=version=${versionFile}`,
      "--dry-run=client",
      "--output=json",
    ],
    false,
  );
  if (renderedResult.exitCode !== 0 || renderedResult.stderr !== "") {
    return yield* lifecycleError(
      "secret_render",
      `status=${renderedResult.exitCode}; stderr=${renderedResult.stderr.trim()}`,
    );
  }
  const manifest = yield* managedSecretManifest(
    renderedResult.stdout,
    resourceVersion,
  );
  const source = yield* encodeJson(ManagedSecretManifest, manifest);
  return yield* submitJson(
    context,
    environment,
    capturedOutput,
    namespace,
    operation,
    source,
  );
});

const managedSecretManifest = Effect.fn(
  "test.secretLifecycle.managedSecretManifest",
)(function*(source: string, resourceVersion = "") {
  const rendered = yield* decodeJson(RenderedSecret, source);
  const metadata = resourceVersion === ""
    ? { labels: expectedLabels, name: secretName }
    : { labels: expectedLabels, name: secretName, resourceVersion };
  return {
    apiVersion: rendered.apiVersion,
    data: rendered.data,
    kind: "Secret",
    metadata,
    type: "Opaque",
  } satisfies typeof ManagedSecretManifest.Type;
});

const inspectSecret = Effect.fn("test.secretLifecycle.inspectSecret")(
  function*(
    context: string,
    environment: CommandEnvironment,
    capturedOutput: Ref.Ref<ReadonlyArray<string>>,
    namespace: string,
  ) {
    const source = yield* requireKubectl(
      context,
      environment,
      capturedOutput,
      namespace,
      ["get", `secret/${secretName}`, "--output=json"],
      false,
    );
    const observed = yield* decodeJson(ObservedSecret, source);
    const annotations = Object.keys(observed.metadata.annotations ?? {}).sort();
    const dataKeys = Object.keys(observed.data).sort();
    const labels = Object.fromEntries(
      Object.keys(expectedLabels).map((key) => [
        key,
        observed.metadata.labels?.[key] ?? "",
      ]),
    );
    return {
      annotations,
      dataKeys,
      labels,
      resourceVersion: observed.metadata.resourceVersion,
      type: observed.type,
      uid: observed.metadata.uid,
    } satisfies SecretSnapshot;
  },
);

function validateManagedContract(
  snapshot: SecretSnapshot,
  allowAnnotations = false,
) {
  if (snapshot.type !== "Opaque") {
    return Effect.fail(ManagedSecretContractError.make({
      reason: "type_mismatch",
    }));
  }
  for (const [key, value] of Object.entries(expectedLabels)) {
    if (snapshot.labels[key] !== value) {
      return Effect.fail(ManagedSecretContractError.make({
        reason: "labels_mismatch",
      }));
    }
  }
  if (snapshot.dataKeys.join("\n") !== ["token", "version"].join("\n")) {
    return Effect.fail(ManagedSecretContractError.make({
      reason: "data_keys_mismatch",
    }));
  }
  if (!allowAnnotations && snapshot.annotations.length > 0) {
    return Effect.fail(ManagedSecretContractError.make({
      reason: "annotations_present",
    }));
  }
  return Effect.void;
}

const waitForProjectedVersion = Effect.fn(
  "test.secretLifecycle.waitForProjectedVersion",
)(function*(
  context: string,
  environment: CommandEnvironment,
  capturedOutput: Ref.Ref<ReadonlyArray<string>>,
  namespace: string,
  expected: string,
) {
  yield* TestClock.withLive(
    kubectl(
      context,
      environment,
      capturedOutput,
      namespace,
      [
        "exec",
        "pod/secret-reader",
        "--container=reader",
        "--",
        "cat",
        "/var/run/secrets/agentos/version",
      ],
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0 && result.stdout.trim() === expected
          ? Effect.void
          : Effect.fail(lifecycleError("projection_pending"))
      ),
      Effect.retry({
        schedule: Schedule.spaced("1 second"),
        times: 119,
      }),
      Effect.mapError(() =>
        lifecycleError("projection_timeout", `expected=${expected}`)
      ),
    ),
  );
});

layer(platform)("managed Kubernetes Secret lifecycle", (it) => {
  it.effect("normalizes kubectl's omitted default Secret type", () =>
    Effect.gen(function*() {
      const manifest = yield* managedSecretManifest(
        '{"apiVersion":"v1","kind":"Secret","metadata":{"name":"managed-credential"},"data":{"token":"eA==","version":"djE="}}',
      );
      assert.strictEqual(manifest.type, "Opaque");
      assert.deepStrictEqual(manifest.metadata.labels, expectedLabels);
    }));

  it.effect(
    "proves retry, rotation, conflict, takeover, projection, rollback, and revocation",
    () => Effect.scoped(Effect.gen(function*() {
      const context = yield* Config.option(
        Config.string("AGENTOS_KUBERNETES_TEST_CONTEXT"),
      );
      if (Option.isNone(context)) return;

      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const environment = yield* commandEnvironment();
      const capturedOutput = yield* Ref.make<ReadonlyArray<string>>([]);
      const fixture = yield* paths.fromFileUrl(fixtureUrl);
      const namespace = `agentos-secret-proof-${
        Encoding.encodeHex(yield* crypto.randomBytes(3))
      }`;
      const staging = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-secret-proof-",
      });
      const originalToken = Encoding.encodeBase64Url(
        yield* crypto.randomBytes(32),
      );
      const rotatedToken = Encoding.encodeBase64Url(
        yield* crypto.randomBytes(32),
      );
      const originalTokenFile = paths.join(staging, "original-token");
      const rotatedTokenFile = paths.join(staging, "rotated-token");
      const versionOneFile = paths.join(staging, "version-one");
      const versionTwoFile = paths.join(staging, "version-two");

      yield* fileSystem.chmod(staging, 0o700);
      assert.strictEqual((yield* fileSystem.stat(staging)).mode & 0o777, 0o700);
      yield* Effect.all([
        fileSystem.writeFileString(originalTokenFile, originalToken, {
          mode: 0o600,
        }),
        fileSystem.writeFileString(rotatedTokenFile, rotatedToken, {
          mode: 0o600,
        }),
        fileSystem.writeFileString(versionOneFile, "v1", { mode: 0o600 }),
        fileSystem.writeFileString(versionTwoFile, "v2", { mode: 0o600 }),
      ], { concurrency: "unbounded", discard: true });
      for (const file of [
        originalTokenFile,
        rotatedTokenFile,
        versionOneFile,
        versionTwoFile,
      ]) {
        assert.strictEqual((yield* fileSystem.stat(file)).mode & 0o777, 0o600);
      }

      yield* Effect.addFinalizer(() =>
        kubectl(
          context.value,
          environment,
          capturedOutput,
          "",
          [
            "delete",
            `namespace/${namespace}`,
            "--ignore-not-found=true",
            "--wait=true",
          ],
        ).pipe(Effect.ignore)
      );
      yield* requireKubectl(
        context.value,
        environment,
        capturedOutput,
        "",
        ["create", "namespace", namespace],
      );
      yield* requireKubectl(
        context.value,
        environment,
        capturedOutput,
        "",
        [
          "label",
          `namespace/${namespace}`,
          "pod-security.kubernetes.io/enforce=restricted",
          "pod-security.kubernetes.io/enforce-version=latest",
        ],
      );

      const created = yield* writeManagedSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
        "create",
        originalTokenFile,
        versionOneFile,
      );
      assert.deepStrictEqual(created, {
        exitCode: 0,
        stderr: "",
        stdout: `secret/${secretName}\n`,
      });
      const initial = yield* inspectSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
      );
      yield* validateManagedContract(initial);
      const unexpectedKeys = yield* validateManagedContract({
        ...initial,
        dataKeys: ["token", "unexpected", "version"],
      }).pipe(Effect.flip);
      assert.strictEqual(unexpectedKeys.reason, "data_keys_mismatch");

      const exactRetry = yield* writeManagedSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
        "replace",
        originalTokenFile,
        versionOneFile,
        initial.resourceVersion,
      );
      assert.strictEqual(exactRetry.exitCode, 0);
      const retried = yield* inspectSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
      );
      yield* validateManagedContract(retried);
      assert.strictEqual(retried.uid, initial.uid);

      yield* requireKubectl(
        context.value,
        environment,
        capturedOutput,
        namespace,
        ["create", "--filename", fixture],
      );
      yield* requireKubectl(
        context.value,
        environment,
        capturedOutput,
        namespace,
        [
          "wait",
          "--for=condition=Ready",
          "pod/secret-reader",
          "pod/unrelated-reader",
          "--timeout=180s",
        ],
      );
      assert.strictEqual(
        yield* requireKubectl(
          context.value,
          environment,
          capturedOutput,
          namespace,
          [
            "exec",
            "pod/secret-reader",
            "--container=reader",
            "--",
            "stat",
            "-L",
            "-c",
            "%a:%u:%g",
            "/var/run/secrets/agentos/token",
          ],
        ),
        "440:0:2000",
      );
      yield* requireKubectl(
        context.value,
        environment,
        capturedOutput,
        namespace,
        [
          "exec",
          "pod/secret-reader",
          "--container=reader",
          "--",
          "sh",
          "-c",
          "test -r /var/run/secrets/agentos/token",
        ],
      );
      yield* requireKubectl(
        context.value,
        environment,
        capturedOutput,
        namespace,
        [
          "exec",
          "pod/unrelated-reader",
          "--container=reader",
          "--",
          "sh",
          "-c",
          "test ! -r /var/run/secrets/agentos/token",
        ],
      );
      yield* waitForProjectedVersion(
        context.value,
        environment,
        capturedOutput,
        namespace,
        "v1",
      );

      yield* requireKubectl(
        context.value,
        environment,
        capturedOutput,
        namespace,
        [
          "annotate",
          `secret/${secretName}`,
          "agentos.akua.dev/test-conflict=concurrent-writer",
        ],
      );
      yield* requireKubectl(
        context.value,
        environment,
        capturedOutput,
        namespace,
        [
          "annotate",
          `secret/${secretName}`,
          "agentos.akua.dev/test-conflict-",
        ],
      );
      const afterConcurrentWrite = yield* inspectSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
      );
      yield* validateManagedContract(afterConcurrentWrite);
      assert.notStrictEqual(
        afterConcurrentWrite.resourceVersion,
        retried.resourceVersion,
      );

      const staleReplacement = yield* writeManagedSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
        "replace",
        rotatedTokenFile,
        versionTwoFile,
        retried.resourceVersion,
      );
      assert.notStrictEqual(staleReplacement.exitCode, 0);
      assert.include(staleReplacement.stderr, "the object has been modified");

      const rotated = yield* writeManagedSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
        "replace",
        rotatedTokenFile,
        versionTwoFile,
        afterConcurrentWrite.resourceVersion,
      );
      assert.strictEqual(rotated.exitCode, 0);
      const afterRotation = yield* inspectSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
      );
      yield* validateManagedContract(afterRotation);
      assert.strictEqual(afterRotation.uid, initial.uid);
      yield* waitForProjectedVersion(
        context.value,
        environment,
        capturedOutput,
        namespace,
        "v2",
      );

      const rolledBack = yield* writeManagedSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
        "replace",
        originalTokenFile,
        versionOneFile,
        afterRotation.resourceVersion,
      );
      assert.strictEqual(rolledBack.exitCode, 0);
      const afterRollback = yield* inspectSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
      );
      yield* validateManagedContract(afterRollback);
      assert.strictEqual(afterRollback.uid, initial.uid);
      yield* waitForProjectedVersion(
        context.value,
        environment,
        capturedOutput,
        namespace,
        "v1",
      );

      yield* requireKubectl(
        context.value,
        environment,
        capturedOutput,
        namespace,
        [
          "annotate",
          `secret/${secretName}`,
          "kubectl.kubernetes.io/last-applied-configuration=synthetic-legacy-value",
        ],
      );
      const annotated = yield* inspectSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
      );
      const annotationConflict = yield* validateManagedContract(
        annotated,
      ).pipe(Effect.flip);
      assert.strictEqual(annotationConflict.reason, "annotations_present");
      yield* requireKubectl(
        context.value,
        environment,
        capturedOutput,
        namespace,
        [
          "label",
          `secret/${secretName}`,
          "agentos.akua.dev/secret-scope=conflicting-scope",
          "--overwrite",
        ],
      );
      const conflict = yield* inspectSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
      );
      const labelConflict = yield* validateManagedContract(conflict).pipe(
        Effect.flip,
      );
      assert.strictEqual(labelConflict.reason, "labels_mismatch");
      assert.deepStrictEqual(conflict.annotations, [
        "kubectl.kubernetes.io/last-applied-configuration",
      ]);

      yield* validateManagedContract(
        { ...conflict, labels: expectedLabels },
        true,
      );
      const takeover = yield* writeManagedSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
        "replace",
        rotatedTokenFile,
        versionTwoFile,
        conflict.resourceVersion,
      );
      assert.strictEqual(takeover.exitCode, 0);
      const afterTakeover = yield* inspectSecret(
        context.value,
        environment,
        capturedOutput,
        namespace,
      );
      yield* validateManagedContract(afterTakeover);
      assert.strictEqual(afterTakeover.uid, initial.uid);
      assert.deepStrictEqual(afterTakeover.annotations, []);
      yield* waitForProjectedVersion(
        context.value,
        environment,
        capturedOutput,
        namespace,
        "v2",
      );

      for (const pod of ["secret-reader", "unrelated-reader"]) {
        assert.strictEqual(
          yield* requireKubectl(
            context.value,
            environment,
            capturedOutput,
            namespace,
            ["logs", `pod/${pod}`],
          ),
          "",
        );
      }
      const output = (yield* Ref.get(capturedOutput)).join("\n");
      for (const credential of [originalToken, rotatedToken]) {
        assert.notInclude(output, credential);
        assert.notInclude(output, Encoding.encodeBase64(credential));
      }

      yield* requireKubectl(
        context.value,
        environment,
        capturedOutput,
        namespace,
        [
          "delete",
          "pod/secret-reader",
          "pod/unrelated-reader",
          "--wait=true",
        ],
      );
      assert.strictEqual(
        yield* requireKubectl(
          context.value,
          environment,
          capturedOutput,
          namespace,
          [
            "get",
            `secret/${secretName}`,
            "--output=jsonpath={.metadata.uid}",
          ],
        ),
        initial.uid,
      );
      yield* requireKubectl(
        context.value,
        environment,
        capturedOutput,
        namespace,
        ["delete", `secret/${secretName}`, "--wait=true"],
      );
      assert.strictEqual(
        yield* requireKubectl(
          context.value,
          environment,
          capturedOutput,
          namespace,
          [
            "get",
            `secret/${secretName}`,
            "--ignore-not-found",
            "--output=name",
          ],
        ),
        "",
      );

    })),
    420_000,
  );
});
