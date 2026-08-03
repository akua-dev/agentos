import {
  Crypto,
  Effect,
  Encoding,
  FileSystem,
  Path,
  Schema,
} from "effect";

import { renderKustomize } from "../../../../../tooling/testing/kubernetes.ts";
import {
  compileAgentWorkloadSpec,
  type AgentWorkloadPlanV1,
} from "../compiler.ts";

const ResourceEnvelope = Schema.Struct({
  apiVersion: Schema.String,
  kind: Schema.String,
  metadata: Schema.Struct({
    name: Schema.String,
    namespace: Schema.optional(Schema.String),
  }),
});
const KubernetesList = Schema.Struct({
  apiVersion: Schema.Literal("v1"),
  kind: Schema.Literal("List"),
  items: Schema.Array(Schema.Unknown),
});

export interface RenderedWorkloadPlan {
  readonly plan: AgentWorkloadPlanV1;
  readonly resources: ReadonlyArray<unknown>;
  readonly resourceIdentities: ReadonlyArray<string>;
  readonly renderDigest: string;
}

export interface WorkloadSpecFixture {
  readonly withOverlayRoot: (overlayRoot: string) => unknown;
}

export const renderCompiledWorkloadSpec = Effect.fn(
  "test.workloadConformance.renderCompiledSpec",
)(function*(fixture: WorkloadSpecFixture) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "agentos-workload-conformance-",
    });
    const overlayRoot = yield* fileSystem.realPath(root);
    const plan = yield* compileAgentWorkloadSpec(
      fixture.withOverlayRoot(overlayRoot),
    );
    yield* Effect.forEach(plan.files, ({ path, content }) =>
      fileSystem.writeFileString(paths.join(overlayRoot, path), content), {
      concurrency: "unbounded",
      discard: true,
    });
    const resources = yield* renderKustomize(overlayRoot, {
      loadRestrictionsNone: true,
    });
    const renderDigest = yield* digestKubernetesResources(resources);
    const resourceIdentities = yield* Effect.forEach(resources, (resource) =>
      Schema.decodeUnknownEffect(ResourceEnvelope)(resource).pipe(
        Effect.map(({ apiVersion, kind, metadata }) =>
          `${apiVersion}/${kind}/${metadata.namespace ?? "_cluster"}/${metadata.name}`
        ),
      ));
    return {
      plan,
      resources,
      resourceIdentities: [...resourceIdentities].sort(),
      renderDigest,
    } satisfies RenderedWorkloadPlan;
  }));
});

export const digestKubernetesResources = Effect.fn(
  "test.workloadConformance.digestResources",
)(function*(resources: ReadonlyArray<unknown>) {
  const crypto = yield* Crypto.Crypto;
  const encoded = yield* Effect.forEach(resources, (resource) =>
    Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      canonicalize(resource),
    ));
  const source = [...encoded].sort().join("\n");
  return Encoding.encodeHex(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(source)),
  );
});

export function kubernetesResourceListJson(
  resources: ReadonlyArray<unknown>,
) {
  return Schema.encodeEffect(Schema.fromJsonString(KubernetesList))({
    apiVersion: "v1",
    kind: "List",
    items: resources,
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}
