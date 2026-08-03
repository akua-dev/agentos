import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { parseAllDocuments, stringify } from "yaml";

export class KubernetesTestError extends Schema.TaggedErrorClass<KubernetesTestError>()(
  "KubernetesTestError",
  {
    operation: Schema.Literals(["process", "render", "patch", "yaml"]),
    detail: Schema.String,
    exitCode: Schema.optional(Schema.Number),
  },
) {}

function testError(
  operation: typeof KubernetesTestError.fields.operation.Type,
  detail: string,
  exitCode?: number,
) {
  return KubernetesTestError.make({ operation, detail, exitCode });
}

const runKubectl = Effect.fn("test.kubernetes.runKubectl")(function*(
  operation: "render" | "patch",
  args: ReadonlyArray<string>,
) {
  const output = yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make("kubectl", Array.from(args), {
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  })).pipe(
    Effect.mapError(() => testError("process", "kubectl process failed")),
  );

  if (output.exitCode !== 0) {
    return yield* testError(
      operation,
      output.stderr.length === 0
        ? "kubectl exited unsuccessfully"
        : "kubectl reported an error; stderr is redacted",
      output.exitCode,
    );
  }
  return output.stdout;
});

export const parseYamlDocuments = Effect.fn("test.kubernetes.parseYamlDocuments")(
  (source: string) => Effect.try({
    try: () =>
      parseAllDocuments(source).map((document) => document.toJSON()),
    catch: () => testError("yaml", "invalid Kubernetes YAML"),
  }),
);

export const renderKustomize = Effect.fn("test.kubernetes.renderKustomize")(
  function*(
    directory: string,
    options?: { readonly loadRestrictionsNone?: boolean },
  ) {
    const args = ["kustomize"];
    if (options?.loadRestrictionsNone === true) {
      args.push("--load-restrictor", "LoadRestrictionsNone");
    }
    args.push(directory);
    return yield* runKubectl("render", args).pipe(
      Effect.flatMap(parseYamlDocuments),
    );
  },
);

export const applyStrategicPatch = Effect.fn(
  "test.kubernetes.applyStrategicPatch",
)(function*(target: unknown, patchFile: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "agentos-kubectl-patch-",
  });
  const targetFile = paths.join(directory, "target.yaml");
  const source = yield* Effect.try({
    try: () => stringify(target),
    catch: () => testError("yaml", "Kubernetes object is not serializable"),
  });
  yield* fileSystem.writeFileString(targetFile, source).pipe(
    Effect.mapError(() => testError("patch", "temporary patch input failed")),
  );
  const patched = yield* runKubectl("patch", [
    "patch",
    "--local",
    "--filename",
    targetFile,
    "--type",
    "strategic",
    "--patch-file",
    patchFile,
    "--output",
    "yaml",
  ]);
  const documents = yield* parseYamlDocuments(patched);
  const document = documents[0];
  if (document === undefined) {
    return yield* testError("yaml", "kubectl patch returned no document");
  }
  return document;
});
