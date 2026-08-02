import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit, Schedule, Schema } from "effect";

const ReleaseSchema = Schema.Struct({
  server: Schema.Struct({ image: Schema.String }),
  predecessor: Schema.Struct({ image: Schema.String }),
  postgresConformance: Schema.Struct({ image: Schema.String }),
});

class UpgradeConformanceError extends Schema.TaggedErrorClass<UpgradeConformanceError>()(
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

const suffix = `${process.pid}-${Date.now()}`;
const network = `agentos-openfga-upgrade-${suffix}`;
const primaryPostgres = `agentos-openfga-pg-${suffix}`;
const restoredPostgres = `agentos-openfga-pg-restored-${suffix}`;
const predecessorServer = `agentos-openfga-predecessor-${suffix}`;
const upgradedServer = `agentos-openfga-upgraded-${suffix}`;
const restoredServer = `agentos-openfga-restored-${suffix}`;
const testPassword = "agentos-openfga-disposable-test";

const release = await Effect.runPromise(
  Effect.tryPromise(() =>
    Bun.file(new URL("../release.json", import.meta.url)).text()
  ).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(ReleaseSchema)),
    ),
  ),
);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "agentos-openfga-upgrade-"));
const backupPath = join(temporaryDirectory, "openfga.dump");

const program = Effect.gen(function*() {
  yield* docker("create_network", ["network", "create", network]);
  yield* startPostgres(primaryPostgres, "postgres", release.postgresConformance.image);
  yield* waitForPostgres(primaryPostgres);

  yield* migrate(
    "migrate_predecessor",
    release.predecessor.image,
    "postgres",
  );
  const predecessorUrl = yield* startOpenFga(
    predecessorServer,
    release.predecessor.image,
    "postgres",
  );
  yield* waitForOpenFga(predecessorUrl);
  const predecessor = yield* runModelConformance(
    "conformance_predecessor",
    predecessorUrl,
  );

  const backup = yield* dockerBytes("backup_predecessor", [
    "exec",
    primaryPostgres,
    "pg_dump",
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--username=openfga",
    "--dbname=openfga",
  ]);
  yield* Effect.tryPromise({
    try: () => Bun.write(backupPath, backup),
    catch: () => upgradeError("backup_predecessor", "command_failed"),
  });
  yield* docker("stop_predecessor", ["rm", "--force", predecessorServer]);

  yield* migrate("migrate_current", release.server.image, "postgres");
  const upgradedUrl = yield* startOpenFga(
    upgradedServer,
    release.server.image,
    "postgres",
  );
  yield* waitForOpenFga(upgradedUrl);
  const upgraded = yield* runModelConformance(
    "conformance_upgraded",
    upgradedUrl,
  );

  yield* startPostgres(
    restoredPostgres,
    "postgres-restored",
    release.postgresConformance.image,
  );
  yield* waitForPostgres(restoredPostgres);
  yield* docker("copy_backup", [
    "cp",
    backupPath,
    `${restoredPostgres}:/tmp/openfga.dump`,
  ]);
  yield* docker("restore_backup", [
    "exec",
    restoredPostgres,
    "pg_restore",
    "--no-owner",
    "--no-acl",
    "--username=openfga",
    "--dbname=openfga",
    "/tmp/openfga.dump",
  ]);
  yield* migrate(
    "migrate_restored_current",
    release.server.image,
    "postgres-restored",
  );
  const restoredUrl = yield* startOpenFga(
    restoredServer,
    release.server.image,
    "postgres-restored",
  );
  yield* waitForOpenFga(restoredUrl);
  const restored = yield* runModelConformance(
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
  };
});

const cleanup = Effect.gen(function*() {
  for (const container of [
    predecessorServer,
    upgradedServer,
    restoredServer,
    primaryPostgres,
    restoredPostgres,
  ]) {
    yield* docker("cleanup_container", ["rm", "--force", container]).pipe(
      Effect.ignore,
    );
  }
  yield* docker("cleanup_network", ["network", "rm", network]).pipe(
    Effect.ignore,
  );
  yield* Effect.tryPromise({
    try: () => rm(temporaryDirectory, { recursive: true, force: true }),
    catch: () => upgradeError("cleanup_directory", "command_failed"),
  }).pipe(Effect.ignore);
});

function startPostgres(name: string, alias: string, image: string) {
  return docker("start_postgres", [
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    network,
    "--network-alias",
    alias,
    "--env",
    `POSTGRES_PASSWORD=${testPassword}`,
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

function datastoreUri(host: string) {
  return `postgresql://openfga:${testPassword}@${host}:5432/openfga?sslmode=disable`;
}

function migrate(operation: string, image: string, databaseHost: string) {
  return docker(operation, [
    "run",
    "--rm",
    "--network",
    network,
    "--env",
    "OPENFGA_DATASTORE_ENGINE=postgres",
    "--env",
    `OPENFGA_DATASTORE_URI=${datastoreUri(databaseHost)}`,
    image,
    "migrate",
  ]);
}

const startOpenFga = Effect.fn("agentos.openfga.upgrade.startServer")(
  function*(name: string, image: string, databaseHost: string) {
    yield* docker("start_openfga", [
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      network,
      "--publish",
      "127.0.0.1::8080",
      "--env",
      "OPENFGA_DATASTORE_ENGINE=postgres",
      "--env",
      `OPENFGA_DATASTORE_URI=${datastoreUri(databaseHost)}`,
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

function waitForOpenFga(baseUrl: string) {
  return Effect.tryPromise({
    try: (signal) => fetch(new URL("/healthz", baseUrl), { signal }),
    catch: () => upgradeError("wait_openfga", "health_unavailable"),
  }).pipe(
    Effect.flatMap((response) => {
      void response.body?.cancel().catch(() => undefined);
      return response.ok
        ? Effect.void
        : Effect.fail(upgradeError("wait_openfga", "health_unavailable"));
    }),
    Effect.retry({
      times: 60,
      schedule: Schedule.spaced("500 millis"),
    }),
  );
}

const ModelConformanceResultSchema = Schema.Struct({
  assertions: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
});

function runModelConformance(operation: string, baseUrl: string) {
  return command(operation, [
    "bun",
    "tests/live-model-conformance-main.ts",
  ], {
    cwd: new URL("..", import.meta.url).pathname,
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

function commandBytes(
  operation: string,
  command: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly environment?: Readonly<Record<string, string>>;
  } = {},
) {
  return Effect.tryPromise({
    try: async (signal) => {
      const child = Bun.spawn([...command], {
        cwd: options.cwd,
        env: options.environment === undefined
          ? process.env
          : { ...process.env, ...options.environment },
        stdout: "pipe",
        stderr: "pipe",
      });
      signal.addEventListener("abort", () => child.kill("SIGTERM"), {
        once: true,
      });
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) throw new CommandFailedError();
      return new Uint8Array(stdout);
    },
    catch: () => upgradeError(operation, "command_failed"),
  });
}

function upgradeError(
  operation: string,
  code: UpgradeConformanceError["code"],
) {
  return UpgradeConformanceError.make({ operation, code });
}

class CommandFailedError extends Error {}

const exit = await Effect.runPromiseExit(program.pipe(Effect.ensuring(cleanup)));
if (Exit.isSuccess(exit)) {
  console.log(JSON.stringify(exit.value));
} else {
  const first = exit.cause.reasons.find(Cause.isFailReason)?.error;
  const defect = exit.cause.reasons.find(Cause.isDieReason)?.defect;
  const safe = typeof first === "object" && first !== null && "_tag" in first
    ? {
      error: String(first._tag),
      ...("operation" in first ? { operation: String(first.operation) } : {}),
      ...("code" in first ? { code: String(first.code) } : {}),
    }
    : {
      error: "UnknownFailure",
      ...(defect === undefined
        ? {}
        : {
          defect: defect instanceof Error
            ? `${defect.name}: ${defect.message}`
            : String(defect),
        }),
    };
  console.error(JSON.stringify(safe));
  process.exitCode = 1;
}
