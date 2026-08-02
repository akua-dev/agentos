import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, layer } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

class TestCommandError extends Schema.TaggedErrorClass<TestCommandError>()(
  "TestCommandError",
  { message: Schema.String },
) {}

function commandError(message: string) {
  return TestCommandError.make({ message });
}

const runCommand = Effect.fn("test.imageSeed.runCommand")(function*(
  executable: string,
  arguments_: ReadonlyArray<string>,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make(executable, arguments_, {
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" });
    return { exitCode, stderr, stdout };
  }));
});

function successfulOutput(
  operation: string,
  result: Effect.Success<ReturnType<typeof runCommand>>,
) {
  return result.exitCode === 0
    ? Effect.succeed(result.stdout)
    : Effect.fail(commandError(`${operation} failed: ${result.stderr}`));
}

const runGit = Effect.fn("test.imageSeed.runGit")(function*(
  operation: string,
  arguments_: ReadonlyArray<string>,
) {
  return yield* successfulOutput(
    operation,
    yield* runCommand("git", arguments_),
  );
});

const fixture = Effect.fn("test.imageSeed.fixture")(function*(
  withCommit = true,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "agentos-image-seed-",
  });
  const source = paths.join(root, "source");
  yield* fileSystem.makeDirectory(source);
  yield* runGit("git init", ["-C", source, "init", "--quiet"]);
  yield* runGit("git user name", [
    "-C",
    source,
    "config",
    "user.name",
    "AgentOS",
  ]);
  yield* runGit("git user email", [
    "-C",
    source,
    "config",
    "user.email",
    "agentos@example.invalid",
  ]);
  if (withCommit) {
    const oldFile = paths.join(source, "old.txt");
    yield* fileSystem.writeFileString(oldFile, "old history\n");
    yield* runGit("git add old", ["-C", source, "add", "old.txt"]);
    yield* runGit("git commit old", [
      "-C",
      source,
      "commit",
      "--quiet",
      "--message",
      "old",
    ]);
    yield* fileSystem.remove(oldFile);
    yield* fileSystem.writeFileString(
      paths.join(source, "current.txt"),
      "current tree\n",
    );
    yield* runGit("git add current", ["-C", source, "add", "--all"]);
    yield* runGit("git commit current", [
      "-C",
      source,
      "commit",
      "--quiet",
      "--message",
      "current",
    ]);
  }
  return { root, source };
});

const imageSeedEntrypoint = Effect.fn("test.imageSeed.entrypoint")(
  function*() {
    const paths = yield* Path.Path;
    const repository = yield* paths.fromFileUrl(
      new URL("../../../..", import.meta.url),
    );
    return paths.join(
      repository,
      "packages",
      "agentos",
      "runtime",
      "create-image-seed.ts",
    );
  },
);

const runSeed = Effect.fn("test.imageSeed.runSeed")(function*(
  source: string,
  output: string,
  remoteArguments: ReadonlyArray<string>,
) {
  return yield* runCommand("bun", [
    yield* imageSeedEntrypoint(),
    "--source",
    source,
    "--output",
    output,
    ...remoteArguments,
  ]);
});

describe("Effect AgentOS image Git seed", () => {
  layer(BunServices.layer)((it) => {
    it.effect(
      "creates a credential-free shallow clone at the exact source commit",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const { root, source } = yield* fixture();
          const output = paths.join(root, "seed");

          const result = yield* runSeed(source, output, [
            "--origin",
            "https://github.com/acme/agentos.git",
            "--upstream",
            "https://github.com/akua-dev/agentos.git",
          ]);

          assert.deepStrictEqual(result, {
            exitCode: 0,
            stderr: "",
            stdout: "",
          });
          assert.strictEqual(
            (yield* runGit("seed HEAD", [
              "-C",
              output,
              "rev-parse",
              "HEAD",
            ])).trim(),
            (yield* runGit("source HEAD", [
              "-C",
              source,
              "rev-parse",
              "HEAD",
            ])).trim(),
          );
          assert.strictEqual(
            (yield* runGit("seed history", [
              "-C",
              output,
              "rev-list",
              "--count",
              "HEAD",
            ])).trim(),
            "1",
          );
          assert.isNotEmpty(
            yield* fileSystem.readFileString(
              paths.join(output, ".git", "shallow"),
            ),
          );
          assert.strictEqual(
            (yield* runGit("origin URL", [
              "-C",
              output,
              "config",
              "--get",
              "remote.origin.url",
            ])).trim(),
            "https://github.com/acme/agentos.git",
          );
          assert.strictEqual(
            (yield* runGit("upstream URL", [
              "-C",
              output,
              "config",
              "--get",
              "remote.upstream.url",
            ])).trim(),
            "https://github.com/akua-dev/agentos.git",
          );
        })),
    );

    it.effect(
      "rejects source changes that are not in the selected commit",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const { root, source } = yield* fixture();
          const output = paths.join(root, "seed");
          yield* fileSystem.writeFileString(
            paths.join(source, "unfinished.txt"),
            "not committed\n",
          );

          const result = yield* runSeed(source, output, [
            "--origin",
            "https://github.com/akua-dev/agentos.git",
          ]);

          assert.strictEqual(result.exitCode, 1);
          assert.include(result.stderr, "must be clean");
          assert.isFalse(yield* fileSystem.exists(output));
        })),
    );

    it.effect(
      "rejects credentials embedded in a configured remote",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const { root, source } = yield* fixture();
          const output = paths.join(root, "seed");

          const result = yield* runSeed(source, output, [
            "--origin",
            "https://agent:secret@github.com/acme/agentos.git",
          ]);

          assert.strictEqual(result.exitCode, 1);
          assert.include(result.stderr, "credential-free");
          assert.notInclude(result.stderr, "agent:secret");
          assert.isFalse(yield* fileSystem.exists(output));
        })),
    );

    it.effect(
      "removes the private staging directory when the source has no fetchable HEAD",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const { root, source } = yield* fixture(false);
          const output = paths.join(root, "seed");

          const result = yield* runSeed(source, output, [
            "--origin",
            "https://github.com/akua-dev/agentos.git",
          ]);

          assert.strictEqual(result.exitCode, 1);
          assert.include(result.stderr, "git fetch failed");
          assert.isFalse(yield* fileSystem.exists(output));
          assert.deepStrictEqual(
            (yield* fileSystem.readDirectory(root)).filter((name) =>
              name.startsWith(".agentos-image-seed-")
            ),
            [],
          );
        })),
    );
  });
});
