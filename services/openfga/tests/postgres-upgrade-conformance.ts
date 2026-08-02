import {
  Effect,
  FileSystem,
  Path,
  Random,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

const ReleaseSchema = Schema.Struct({
  server: Schema.Struct({ image: Schema.String }),
  predecessor: Schema.Struct({ image: Schema.String }),
  postgresConformance: Schema.Struct({ image: Schema.String }),
});
export const UpgradeConformanceResult = Schema.Struct({
  predecessorVersion: Schema.Literal("1.17.1"),
  currentVersion: Schema.Literal("1.18.1"),
  backupBytes: Schema.Number,
  predecessorAssertions: Schema.Number,
  upgradedAssertions: Schema.Number,
  restoredAssertions: Schema.Number,
});
const ModelConformanceResultSchema = Schema.Struct({
  assertions: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
});

export class UpgradeConformanceError extends Schema.TaggedErrorClass<UpgradeConformanceError>()(
  "UpgradeConformanceError",
  {
    operation: Schema.String,
    code: Schema.Literals([
      "command_failed",
      "invalid_output",
      "health_unavailable",
    ]),
  },
) {}

interface UpgradeHarness {
  readonly network: string;
  readonly primaryPostgres: string;
  readonly restoredPostgres: string;
  readonly predecessorServer: string;
  readonly upgradedServer: string;
  readonly restoredServer: string;
  readonly testPassword: string;
  readonly serviceRoot: string;
  readonly backupPath: string;
}

const serviceRootUrl = new URL("..", import.meta.url);

export const postgresUpgradeConformance = Effect.scoped(Effect.gen(function*() {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const random = yield* Random.nextInt;
  const suffix = Math.abs(random).toString(36);
  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "agentos-openfga-upgrade-",
  });
  const serviceRoot = yield* paths.fromFileUrl(serviceRootUrl);
  const release = yield* fileSystem.readFileString(
    paths.join(serviceRoot, "release.json"),
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseSchema)),
    ),
  );
  const harness: UpgradeHarness = {
    network: `agentos-openfga-upgrade-${suffix}`,
    primaryPostgres: `agentos-openfga-pg-${suffix}`,
    restoredPostgres: `agentos-openfga-pg-restored-${suffix}`,
    predecessorServer: `agentos-openfga-predecessor-${suffix}`,
    upgradedServer: `agentos-openfga-upgraded-${suffix}`,
    restoredServer: `agentos-openfga-restored-${suffix}`,
    testPassword: "agentos-openfga-disposable-test",
    serviceRoot,
    backupPath: paths.join(temporaryDirectory, "openfga.dump"),
  };

  return yield* Effect.gen(function*() {
    yield* docker("create_network", [
      "network",
      "create",
      harness.network,
    ]);
    yield* startPostgres(
      harness,
      harness.primaryPostgres,
      "postgres",
      release.postgresConformance.image,
    );
    yield* waitForPostgres(harness.primaryPostgres);

    yield* migrate(
      harness,
      "migrate_predecessor",
      release.predecessor.image,
      "postgres",
    );
    const predecessorUrl = yield* startOpenFga(
      harness,
      harness.predecessorServer,
      release.predecessor.image,
      "postgres",
    );
    yield* waitForOpenFga(predecessorUrl);
    const predecessor = yield* runModelConformance(
      harness,
      "conformance_predecessor",
      predecessorUrl,
    );

    const backup = yield* dockerBytes("backup_predecessor", [
      "exec",
      harness.primaryPostgres,
      "pg_dump",
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--username=openfga",
      "--dbname=openfga",
    ]);
    yield* fileSystem.writeFile(harness.backupPath, backup).pipe(
      Effect.mapError(() => upgradeError("backup_predecessor", "command_failed")),
    );
    yield* docker("stop_predecessor", [
      "rm",
      "--force",
      harness.predecessorServer,
    ]);

    yield* migrate(
      harness,
      "migrate_current",
      release.server.image,
      "postgres",
    );
    const upgradedUrl = yield* startOpenFga(
      harness,
      harness.upgradedServer,
      release.server.image,
      "postgres",
    );
    yield* waitForOpenFga(upgradedUrl);
    const upgraded = yield* runModelConformance(
      harness,
      "conformance_upgraded",
      upgradedUrl,
    );

    yield* startPostgres(
      harness,
      harness.restoredPostgres,
      "postgres-restored",
      release.postgresConformance.image,
    );
    yield* waitForPostgres(harness.restoredPostgres);
    yield* docker("copy_backup", [
      "cp",
      harness.backupPath,
      `${harness.restoredPostgres}:/tmp/openfga.dump`,
    ]);
    yield* docker("restore_backup", [
      "exec",
      harness.restoredPostgres,
      "pg_restore",
      "--no-owner",
      "--no-acl",
      "--username=openfga",
      "--dbname=openfga",
      "/tmp/openfga.dump",
    ]);
    yield* migrate(
      harness,
      "migrate_restored_current",
      release.server.image,
      "postgres-restored",
    );
    const restoredUrl = yield* startOpenFga(
      harness,
      harness.restoredServer,
      release.server.image,
      "postgres-restored",
    );
    yield* waitForOpenFga(restoredUrl);
    const restored = yield* runModelConformance(
      harness,
      "conformance_restored",
      restoredUrl,
    );

    return {
      predecessorVersion: "1.17.1",
      currentVersion: "1.18.1",
      backupBytes: backup.byteLength,
      predecessorAssertions: predecessor.assertions,
      upgradedAssertions: upgraded.assertions,
      restoredAssertions: restored.assertions,
    } satisfies typeof UpgradeConformanceResult.Type;
  }).pipe(Effect.ensuring(cleanup(harness)));
}));

function cleanup(harness: UpgradeHarness) {
  return Effect.gen(function*() {
    for (const container of [
      harness.predecessorServer,
      harness.upgradedServer,
      harness.restoredServer,
      harness.primaryPostgres,
      harness.restoredPostgres,
    ]) {
      yield* docker("cleanup_container", ["rm", "--force", container]).pipe(
        Effect.ignore,
      );
    }
    yield* docker("cleanup_network", [
      "network",
      "rm",
      harness.network,
    ]).pipe(Effect.ignore);
  });
}

function startPostgres(
  harness: UpgradeHarness,
  name: string,
  alias: string,
  image: string,
) {
  return docker("start_postgres", [
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    harness.network,
    "--network-alias",
    alias,
    "--env",
    `POSTGRES_PASSWORD=${harness.testPassword}`,
    "--env",
    "POSTGRES_DB=openfga",
    "--env",
    "POSTGRES_USER=openfga",
    image,
  ]);
}

function waitForPostgres(container: string) {
  return docker("wait_postgres", [
    "exec",
    container,
    "pg_isready",
    "--username=openfga",
    "--dbname=openfga",
  ]).pipe(
    Effect.retry({
      times: 60,
      schedule: Schedule.spaced("500 millis"),
    }),
  );
}

function datastoreUri(harness: UpgradeHarness, host: string) {
  return `postgresql://openfga:${harness.testPassword}@${host}:5432/openfga?sslmode=disable`;
}

function migrate(
  harness: UpgradeHarness,
  operation: string,
  image: string,
  databaseHost: string,
) {
  return docker(operation, [
    "run",
    "--rm",
    "--network",
    harness.network,
    "--env",
    "OPENFGA_DATASTORE_ENGINE=postgres",
    "--env",
    `OPENFGA_DATASTORE_URI=${datastoreUri(harness, databaseHost)}`,
    image,
    "migrate",
  ]);
}

const startOpenFga = Effect.fn("agentos.openfga.upgrade.startServer")(
  function*(
    harness: UpgradeHarness,
    name: string,
    image: string,
    databaseHost: string,
  ) {
    yield* docker("start_openfga", [
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      harness.network,
      "--publish",
      "127.0.0.1::8080",
      "--env",
      "OPENFGA_DATASTORE_ENGINE=postgres",
      "--env",
      `OPENFGA_DATASTORE_URI=${datastoreUri(harness, databaseHost)}`,
      image,
      "run",
      "--http-addr=0.0.0.0:8080",
      "--grpc-addr=0.0.0.0:8081",
    ]);
    const portOutput = yield* docker("resolve_openfga_port", [
      "port",
      name,
      "8080/tcp",
    ]);
    const match = /127\.0\.0\.1:(\d+)/.exec(portOutput);
    if (match?.[1] === undefined) {
      return yield* upgradeError("resolve_openfga_port", "invalid_output");
    }
    return `http://127.0.0.1:${match[1]}`;
  },
);

const waitForOpenFga = Effect.fn("agentos.openfga.upgrade.waitForServer")(
  function*(baseUrl: string) {
    const client = yield* HttpClient.HttpClient;
    yield* client.get(new URL("/healthz", baseUrl)).pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.void
          : upgradeError("wait_openfga", "health_unavailable")
      ),
      Effect.mapError(() => upgradeError("wait_openfga", "health_unavailable")),
      Effect.retry({
        times: 60,
        schedule: Schedule.spaced("500 millis"),
      }),
    );
  },
);

function runModelConformance(
  harness: UpgradeHarness,
  operation: string,
  baseUrl: string,
) {
  return command(operation, [
    "bun",
    "tests/live-model-conformance-main.ts",
  ], {
    cwd: harness.serviceRoot,
    environment: { OPENFGA_TEST_URL: baseUrl },
  }).pipe(
    Effect.flatMap((source) =>
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(ModelConformanceResultSchema),
      )(source.trim()).pipe(
        Effect.mapError(() => upgradeError(operation, "invalid_output")),
      )
    ),
  );
}

function docker(operation: string, args: ReadonlyArray<string>) {
  return command(operation, ["docker", ...args]);
}

function dockerBytes(operation: string, args: ReadonlyArray<string>) {
  return commandBytes(operation, ["docker", ...args]);
}

function command(
  operation: string,
  command: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly environment?: Readonly<Record<string, string>>;
  } = {},
) {
  return commandBytes(operation, command, options).pipe(
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
  );
}

const commandBytes = Effect.fn("agentos.openfga.upgrade.commandBytes")(
  function*(
    operation: string,
    command: ReadonlyArray<string>,
    options: {
      readonly cwd?: string;
      readonly environment?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const executable = command[0];
    if (executable === undefined) {
      return yield* upgradeError(operation, "invalid_output");
    }
    return yield* Effect.scoped(Effect.gen(function*() {
      const child = yield* ChildProcess.make(executable, command.slice(1), {
        cwd: options.cwd,
        env: options.environment,
        extendEnv: true,
        forceKillAfter: "2 seconds",
        killSignal: "SIGTERM",
        stdout: "pipe",
        stderr: "pipe",
      }).pipe(
        Effect.mapError(() => upgradeError(operation, "command_failed")),
      );
      const [exitCode, stdout] = yield* Effect.all([
        child.exitCode.pipe(Effect.map(Number)),
        child.stdout.pipe(Stream.runFold(
          () => new Array<Uint8Array>(),
          (chunks, chunk) => [...chunks, chunk],
        )),
        child.stderr.pipe(Stream.runDrain),
      ], { concurrency: "unbounded" });
      if (exitCode !== 0) {
        return yield* upgradeError(operation, "command_failed");
      }
      return concatenate(stdout);
    }));
  },
);

function concatenate(chunks: ReadonlyArray<Uint8Array>) {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

function upgradeError(
  operation: string,
  code: UpgradeConformanceError["code"],
) {
  return UpgradeConformanceError.make({ operation, code });
}
