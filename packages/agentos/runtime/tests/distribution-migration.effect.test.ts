import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import {
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Scope,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import { migratePiSessionCwd } from "../pi-session.ts";

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
type JsonRecord = typeof JsonRecord.Type;
const Json = Schema.fromJsonString(Schema.Unknown);
const EnvironmentEntries = Schema.Array(Schema.Struct({
  name: Schema.String,
  value: Schema.optional(Schema.String),
}));

const withPlatform = <A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(BunServices.layer));

const repository = new URL("../../../..", import.meta.url).pathname.replace(/\/$/, "");

function sessionHeader(cwd: string) {
  return {
    cwd,
    id: "session-persistent",
    parentSession: null,
    timestamp: "2026-07-29T00:00:00.000Z",
    type: "session",
    version: 3,
  };
}

const encodeJson = (value: unknown) => Schema.encodeEffect(Json)(value);
const decodeJson = (value: string) => Schema.decodeUnknownEffect(Json)(value);

const readSession = Effect.fn("test.distributionMigration.readSession")(
  function*(path: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const lines = (yield* fileSystem.readFileString(path)).trim().split("\n");
    const header = lines[0];
    if (header === undefined) return yield* Effect.fail("Missing session header");
    return {
      header: yield* decodeJson(header),
      history: yield* Effect.forEach(lines.slice(1), decodeJson),
    };
  },
);

const renderRollout = Effect.fn("test.distributionMigration.render")(
  function*(image: string, distributionRoot: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const overlay = yield* fileSystem.makeTempDirectoryScoped({
      directory: repository,
      prefix: ".agentos-distribution-migration-",
    });
    const firstMateWithDatabase = paths.join(
      repository,
      "packages",
      "agentos",
      "resources",
      "roles",
      "firstmate",
      "kubernetes",
      "tests",
      "fixtures",
      "cloudnative-pg",
    );
    const roleDirectory = `${distributionRoot}/resources/roles/firstmate`;
    const resourcePath = paths.relative(overlay, firstMateWithDatabase);
    const [newName, digest] = image.split("@");
    if (newName === undefined || digest === undefined) {
      return yield* Effect.fail("Test image must contain a digest");
    }
    yield* fileSystem.writeFileString(
      paths.join(overlay, "kustomization.yaml"),
      `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ${resourcePath}
images:
  - name: agentos
    newName: ${newName}
    digest: ${digest}
patches:
  - target:
      group: apps
      version: v1
      kind: StatefulSet
      name: agentos-firstmate
    patch: |-
      apiVersion: apps/v1
      kind: StatefulSet
      metadata:
        name: agentos-firstmate
      spec:
        template:
          spec:
            initContainers:
              - name: install-tools
                workingDir: ${roleDirectory}
                env:
                  - name: AGENTOS_AGENT_CWD
                    value: ${roleDirectory}
                  - name: AGENTOS_DISTRIBUTION_ROOT
                    value: ${distributionRoot}
              - name: prepare-home
                workingDir: ${roleDirectory}
                env:
                  - name: AGENTOS_AGENT_CWD
                    value: ${roleDirectory}
                  - name: AGENTOS_DISTRIBUTION_ROOT
                    value: ${distributionRoot}
            containers:
              - name: agentos
                workingDir: ${roleDirectory}
                env:
                  - name: AGENTOS_AGENT_CWD
                    value: ${roleDirectory}
                  - name: AGENTOS_DISTRIBUTION_ROOT
                    value: ${distributionRoot}
`,
    );
    return yield* Effect.scoped(Effect.gen(function*() {
      const child = yield* ChildProcess.make("kubectl", [
        "kustomize",
        "--load-restrictor",
        "LoadRestrictionsNone",
        overlay,
      ], { stderr: "pipe", stdout: "pipe" });
      const [exitCode, stderr, stdout] = yield* Effect.all([
        child.exitCode.pipe(Effect.map(Number)),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      ], { concurrency: "unbounded" });
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const parsed = yield* Effect.try({
        try: () => Bun.YAML.parse(stdout),
        catch: (cause) => cause,
      });
      return yield* Schema.decodeUnknownEffect(Schema.Array(JsonRecord))(parsed);
    }));
  },
);

const recordAt = Effect.fn("test.distributionMigration.recordAt")(
  function*(value: unknown, ...keys: ReadonlyArray<string>) {
    let current = value;
    for (const key of keys) {
      const decoded = Schema.decodeUnknownOption(JsonRecord)(current);
      if (Option.isNone(decoded)) return yield* Effect.fail(`Expected object at ${key}`);
      current = decoded.value[key];
    }
    const decoded = Schema.decodeUnknownOption(JsonRecord)(current);
    return Option.isSome(decoded)
      ? decoded.value
      : yield* Effect.fail(`Expected object at ${keys.join(".")}`);
  },
);

const resource = Effect.fn("test.distributionMigration.resource")(
  function*(resources: ReadonlyArray<JsonRecord>, kind: string, name: string) {
    for (const candidate of resources) {
      const metadata = Schema.decodeUnknownOption(JsonRecord)(candidate.metadata);
      if (
        candidate.kind === kind &&
        Option.isSome(metadata) &&
        metadata.value.name === name
      ) return candidate;
    }
    return yield* Effect.fail(`Missing ${kind}/${name}`);
  },
);

const environment = Effect.fn("test.distributionMigration.environment")(
  function*(container: JsonRecord) {
    const entries = yield* Schema.decodeUnknownEffect(EnvironmentEntries)(container.env);
    return Object.fromEntries(
      entries.flatMap(({ name, value }) =>
        value === undefined ? [] : [[name, value]]
      ),
    );
  },
);

describe("persistent Mate distribution migration", () => {
  it.effect("preserves the retained home while moving one Pi session across distributions and rollback", () =>
    withPlatform(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const sandbox = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agentos-retained-home-" });
      const home = paths.join(sandbox, "home");
      const checkout = paths.join(home, "projects", "agentos");
      const piDirectory = paths.join(home, ".pi", "agent");
      const memoryDirectory = paths.join(home, "memory");
      const herdrDirectory = paths.join(home, ".local", "state", "herdr");
      yield* Effect.forEach([piDirectory, memoryDirectory, herdrDirectory, checkout],
        (directory) => fileSystem.makeDirectory(directory, { recursive: true }),
        { concurrency: "unbounded", discard: true });

      const oldRole = paths.join(checkout, "agents", "firstmate");
      const defaultRole = paths.join(checkout, "packages", "default", "resources", "roles", "firstmate");
      const customRole = paths.join(checkout, "packages", "acme-agentos", "resources", "roles", "firstmate");
      const session = paths.join(piDirectory, "session.jsonl");
      const retained = {
        auth: paths.join(piDirectory, "auth.json"),
        settings: paths.join(piDirectory, "settings.json"),
        memory: paths.join(memoryDirectory, "MEMORY.md"),
        git: paths.join(checkout, ".unfinished-work"),
        herdr: paths.join(herdrDirectory, "agentos-firstmate.json"),
      };
      const history = [
        { message: { content: "preserve conversation", role: "user" }, type: "message" },
        { customType: "agentos-memory-context", type: "custom" },
      ];
      const encodedHistory = yield* Effect.forEach(history, encodeJson);
      yield* Effect.all([
        encodeJson(sessionHeader(oldRole)).pipe(
          Effect.flatMap((header) => fileSystem.writeFileString(session, [header, ...encodedHistory, ""].join("\n"))),
        ),
        fileSystem.writeFileString(retained.auth, '{"provider":"preserved"}\n'),
        fileSystem.writeFileString(retained.settings, '{"theme":"preserved","defaultModel":"gpt-5.6-sol"}\n'),
        fileSystem.writeFileString(retained.memory, "# Memory index\n- preserve this\n"),
        fileSystem.writeFileString(retained.git, "unfinished work\n"),
        fileSystem.writeFileString(retained.herdr, '{"agent":"firstmate","session":"session-persistent"}\n'),
      ], { concurrency: "unbounded", discard: true });
      const retainedBefore = Object.assign({}, ...yield* Effect.forEach(
        Object.entries(retained),
        ([name, path]) => fileSystem.readFileString(path).pipe(Effect.map((source) => ({ [name]: source }))),
        { concurrency: "unbounded" },
      ));
      for (const cwd of [defaultRole, customRole, defaultRole, oldRole]) {
        yield* migratePiSessionCwd(session, cwd);
        const observed = yield* readSession(session);
        expect(observed.header).toEqual(sessionHeader(cwd));
        expect(observed.history).toEqual(history);
      }
      const retainedAfter = Object.assign({}, ...yield* Effect.forEach(
        Object.entries(retained),
        ([name, path]) => fileSystem.readFileString(path).pipe(Effect.map((source) => ({ [name]: source }))),
        { concurrency: "unbounded" },
      ));
      expect(retainedAfter).toEqual(retainedBefore);
    }))
  );

  it.effect("rewrites only the Pi header cwd after a tolerated malformed preamble", () =>
    withPlatform(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const sandbox = yield* fileSystem.makeTempDirectoryScoped({ prefix: "agentos-session-preamble-" });
      const session = paths.join(sandbox, "session.jsonl");
      const previousCwd = paths.join(sandbox, "previous");
      const nextCwd = paths.join(sandbox, "next");
      const preamble = "\n{malformed\n";
      const history = `${yield* encodeJson({ message: { content: "preserve conversation", role: "user" }, type: "message" })}\n`;
      yield* fileSystem.writeFileString(
        session,
        `${preamble}${yield* encodeJson(sessionHeader(previousCwd))}\n${history}`,
      );
      yield* migratePiSessionCwd(session, nextCwd);
      expect(yield* fileSystem.readFileString(session)).toBe(
        `${preamble}${yield* encodeJson(sessionHeader(nextCwd))}\n${history}`,
      );
    }))
  );

  it.effect("keeps Pi-only selection separate from native rollout and restores native authorities", () =>
    withPlatform(Effect.gen(function*() {
      const previousImage = "ghcr.io/example/agentos@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const customImage = "ghcr.io/example/acme-agentos@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const defaultRoot = "/home/agent/projects/agentos/packages/agentos";
      const customRoot = "/home/agent/projects/agentos/packages/acme-agentos";
      const piOnlySelection = { packages: [
        { source: "@akua-dev/agentos@0.1.0", autoload: false, extensions: [], skills: ["skills/agentos-supervision"] },
        "@example/agentos-replacement@1.0.0",
      ] };
      const before = yield* renderRollout(previousImage, defaultRoot);
      const changed = yield* renderRollout(customImage, customRoot);
      const rolledBack = yield* renderRollout(previousImage, defaultRoot);
      expect(piOnlySelection.packages).toHaveLength(2);
      const beforeStatefulSet = yield* resource(before, "StatefulSet", "agentos-firstmate");
      const changedStatefulSet = yield* resource(changed, "StatefulSet", "agentos-firstmate");
      const rollbackStatefulSet = yield* resource(rolledBack, "StatefulSet", "agentos-firstmate");
      const beforePod = yield* recordAt(beforeStatefulSet, "spec", "template", "spec");
      const changedPod = yield* recordAt(changedStatefulSet, "spec", "template", "spec");
      const rollbackPod = yield* recordAt(rollbackStatefulSet, "spec", "template", "spec");
      const beforeContainers = yield* Schema.decodeUnknownEffect(Schema.Array(JsonRecord))(beforePod.containers);
      const changedContainers = yield* Schema.decodeUnknownEffect(Schema.Array(JsonRecord))(changedPod.containers);
      const rollbackContainers = yield* Schema.decodeUnknownEffect(Schema.Array(JsonRecord))(rollbackPod.containers);
      const beforeContainer = beforeContainers[0];
      const changedContainer = changedContainers[0];
      const rollbackContainer = rollbackContainers[0];
      if (!beforeContainer || !changedContainer || !rollbackContainer) return yield* Effect.fail("Missing Mate container");
      expect((yield* environment(beforeContainer)).AGENTOS_DISTRIBUTION_ROOT).toBe(defaultRoot);
      expect(changedContainer.image).toBe(customImage);
      expect((yield* environment(changedContainer)).AGENTOS_DISTRIBUTION_ROOT).toBe(customRoot);
      expect(rollbackContainer.image).toBe(previousImage);
      expect((yield* environment(rollbackContainer)).AGENTOS_DISTRIBUTION_ROOT).toBe(defaultRoot);
      expect(yield* recordAt(rollbackStatefulSet, "metadata")).toEqual(yield* recordAt(beforeStatefulSet, "metadata"));
      const beforeSpec = yield* recordAt(beforeStatefulSet, "spec");
      const rollbackSpec = yield* recordAt(rollbackStatefulSet, "spec");
      expect(rollbackSpec.serviceName).toBe(beforeSpec.serviceName);
      expect(rollbackSpec.volumeClaimTemplates).toEqual(beforeSpec.volumeClaimTemplates);
      expect(rollbackPod.serviceAccountName).toBe(beforePod.serviceAccountName);
      expect((yield* environment(rollbackContainer)).AGENTOS_DATABASE_URL).toBe(
        (yield* environment(beforeContainer)).AGENTOS_DATABASE_URL,
      );
      expect(yield* resource(rolledBack, "RoleBinding", "agentos-firstmate-admin")).toEqual(
        yield* resource(before, "RoleBinding", "agentos-firstmate-admin"),
      );
      expect(yield* resource(rolledBack, "ServiceAccount", "agentos-firstmate")).toEqual(
        yield* resource(before, "ServiceAccount", "agentos-firstmate"),
      );
      expect(rolledBack.some(({ kind }) => kind === "Cluster")).toBe(false);
    }))
  );
});
