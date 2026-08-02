#!/usr/bin/env bun

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Stdio,
  Stream,
} from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

export type ImageSeedOptions = {
  readonly origin: string;
  readonly output: string;
  readonly source: string;
  readonly upstream?: string;
};

export class ImageSeedError extends Schema.TaggedErrorClass<ImageSeedError>()(
  "ImageSeedError",
  { message: Schema.String },
) {}

function imageSeedError(message: string) {
  return ImageSeedError.make({ message });
}

function usageError() {
  return imageSeedError(
    "Usage: create-image-seed.ts --source <checkout> --output <directory> --origin <url> [--upstream <url>]",
  );
}

export const parseImageSeedArguments = Effect.fn(
  "agentos.imageSeed.parseArguments",
)(function*(arguments_: ReadonlyArray<string>) {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined) {
      return yield* usageError();
    }
    values.set(name.slice(2), value);
  }
  const origin = values.get("origin");
  const output = values.get("output");
  const source = values.get("source");
  const upstream = values.get("upstream");
  const expectedSize = upstream === undefined ? 3 : 4;
  if (
    origin === undefined ||
    output === undefined ||
    source === undefined ||
    !origin.trim() ||
    !output.trim() ||
    !source.trim() ||
    (upstream !== undefined && !upstream.trim()) ||
    values.size !== expectedSize
  ) {
    return yield* usageError();
  }
  return { origin, output, source, upstream } satisfies ImageSeedOptions;
});

const assertCredentialFreeRemote = Effect.fn(
  "agentos.imageSeed.credentialFreeRemote",
)(function*(name: string, value: string) {
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return;

  const url = Option.getOrUndefined(
    Schema.decodeUnknownOption(Schema.URLFromString)(value),
  );
  const credentialFreeHttps =
    url?.protocol === "https:" && !url.username && !url.password;
  const credentialFreeSsh = url?.protocol === "ssh:" && !url.password;
  if (!credentialFreeHttps && !credentialFreeSsh) {
    return yield* imageSeedError(
      `${name} must use a credential-free HTTPS or SSH URL`,
    );
  }
});

const runGit = Effect.fn("agentos.imageSeed.runGit")(function*(
  operation: string,
  arguments_: ReadonlyArray<string>,
) {
  return yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* ChildProcess.make("git", arguments_, {
      stderr: "pipe",
      stdout: "pipe",
    }).pipe(
      Effect.mapError(() => imageSeedError(`Could not start git ${operation}`)),
    );
    const [exitCode, stderr, stdout] = yield* Effect.all([
      child.exitCode.pipe(Effect.map(Number)),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
    ], { concurrency: "unbounded" }).pipe(
      Effect.mapError(() => imageSeedError(`Could not read git ${operation}`)),
    );
    if (exitCode !== 0) {
      const diagnostic = stderr.trim();
      return yield* imageSeedError(
        diagnostic
          ? `git ${operation} failed: ${diagnostic}`
          : `git ${operation} failed`,
      );
    }
    return stdout;
  }));
});

export const createImageSeed = Effect.fn("agentos.imageSeed.create")(
  function*(options: ImageSeedOptions) {
    yield* assertCredentialFreeRemote("origin", options.origin);
    if (options.upstream !== undefined) {
      yield* assertCredentialFreeRemote("upstream", options.upstream);
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const outputExists = yield* fileSystem.exists(options.output).pipe(
      Effect.mapError(() =>
        imageSeedError(`Could not inspect ${options.output}`)
      ),
    );
    if (outputExists) {
      return yield* imageSeedError(`${options.output} already exists`);
    }

    const status = yield* runGit("status", [
      "-C",
      options.source,
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (status.trim()) {
      return yield* imageSeedError(
        "AgentOS image source must be clean and committed",
      );
    }

    const parent = paths.dirname(options.output);
    yield* fileSystem.makeDirectory(parent, { recursive: true }).pipe(
      Effect.mapError(() => imageSeedError(`Could not prepare ${parent}`)),
    );
    const sourceUrl = yield* paths.toFileUrl(paths.resolve(options.source)).pipe(
      Effect.mapError(() => imageSeedError("Image source path is invalid")),
    );

    const temporary = yield* fileSystem.makeTempDirectory({
      directory: parent,
      prefix: ".agentos-image-seed-",
    }).pipe(
      Effect.mapError(() => imageSeedError(`Could not prepare ${parent}`)),
    );
    yield* Effect.gen(function*() {
      yield* runGit("init", ["init", "--quiet", temporary]);
      yield* runGit("fetch", [
        "-C",
        temporary,
        "fetch",
        "--quiet",
        "--depth",
        "1",
        "--no-tags",
        sourceUrl.href,
        "HEAD",
      ]);
      yield* runGit("checkout", [
        "-C",
        temporary,
        "checkout",
        "--quiet",
        "--detach",
        "FETCH_HEAD",
      ]);
      yield* runGit("remote add origin", [
        "-C",
        temporary,
        "remote",
        "add",
        "origin",
        options.origin,
      ]);
      if (
        options.upstream !== undefined &&
        options.upstream !== options.origin
      ) {
        yield* runGit("remote add upstream", [
          "-C",
          temporary,
          "remote",
          "add",
          "upstream",
          options.upstream,
        ]);
      }
      yield* fileSystem.rename(temporary, options.output).pipe(
        Effect.mapError(() =>
          imageSeedError(`Could not publish image seed ${options.output}`)
        ),
      );
    }).pipe(
      Effect.ensuring(
        fileSystem.remove(temporary, {
          force: true,
          recursive: true,
        }).pipe(Effect.ignore),
      ),
    );
  },
);

function writeError(message: string) {
  return Effect.gen(function*() {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(`${message}\n`).pipe(
      Stream.run(stdio.stderr()),
      Effect.mapError(() => imageSeedError("Could not write image seed error")),
    );
  });
}

export const createImageSeedMain = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio;
  const options = yield* parseImageSeedArguments(yield* stdio.args);
  yield* createImageSeed(options);
}).pipe(
  Effect.catch((error) =>
    writeError(error.message).pipe(
      Effect.andThen(Effect.fail(error)),
    )
  ),
);

if (import.meta.main) {
  BunRuntime.runMain(
    createImageSeedMain.pipe(Effect.provide(BunServices.layer)),
    { disableErrorReporting: true },
  );
}
