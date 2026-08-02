import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { describe, expect, it } from "@effect/vitest";
import { Crypto, Effect, FileSystem, Layer, Path, Ref, Scope } from "effect";

import {
  createMateMemoryStore,
  type MateMemoryStore,
  type TopicWrite,
} from "../../src/memory/store.ts";

const platformLayer = Layer.mergeAll(
  BunCrypto.layer,
  BunFileSystem.layer,
  BunPath.layer,
);

function topic(
  relativePath: string,
  modified = "2026-07-28T08:00:00.000Z",
  pinned = false,
): TopicWrite {
  return {
    relativePath,
    metadata: {
      node_type: "memory",
      type: "project",
      scope: "fleet",
      source_principal: "captain",
      observed_at: "2026-07-27T08:00:00.000Z",
      modified,
      pinned,
    },
    body: `Body for ${relativePath}.`,
  };
}

function fixture(
  overrides: Parameters<typeof createMateMemoryStore>[1] = {},
) {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "agentos-memory-store-",
    });
    const store = yield* createMateMemoryStore(home, overrides);
    return { fileSystem, home, paths, store };
  });
}

function run<A, E>(
  effect: Effect.Effect<
    A,
    E,
    Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope
  >,
) {
  return Effect.scoped(effect).pipe(Effect.provide(platformLayer));
}

describe("Mate memory Effect store", () => {
  it.effect("bootstraps without replacing existing memory and round-trips typed topics", () =>
    run(Effect.gen(function*() {
      const { fileSystem, paths, store } = yield* fixture();
      yield* store.ensureLayout();
      const indexPath = paths.join(store.root, "MEMORY.md");
      expect(yield* fileSystem.readFileString(indexPath)).toBe("# Memory index\n");
      yield* fileSystem.writeFileString(indexPath, "# Existing\n");
      yield* store.ensureLayout();
      expect(yield* fileSystem.readFileString(indexPath)).toBe("# Existing\n");

      const written = yield* store.writeTopic(topic("topics/project.md"));
      expect(written.relativePath).toBe("topics/project.md");
      expect((yield* store.readTopic("topics/project.md")).metadata).toEqual(
        topic("topics/project.md").metadata,
      );
      const stamped = yield* store.validateAndStamp("topics/project.md", {
        now: new Date("2026-07-29T09:00:00.000Z"),
      });
      expect(stamped.metadata.modified).toBe("2026-07-29T09:00:00.000Z");
    })),
  );

  it.effect("rejects invalid metadata, path escape, and symbolic-link traversal", () =>
    run(Effect.gen(function*() {
      const { fileSystem, home, paths, store } = yield* fixture();
      const bad = yield* store.writeTopic({
        ...topic("topics/bad.md"),
        metadata: {
          ...topic("topics/bad.md").metadata,
          observed_at: "not-a-date",
        },
      }).pipe(Effect.flip);
      expect(bad.message).toContain("ISO timestamp");
      expect((yield* store.readTopic("../escape.md").pipe(Effect.flip)).code)
        .toBe("invalid_path");

      yield* store.ensureLayout();
      const outside = paths.join(home, "outside");
      yield* fileSystem.makeDirectory(outside);
      yield* fileSystem.symlink(outside, paths.join(store.root, "topics", "linked"));
      const linked = yield* store.readTopic("topics/linked/value.md").pipe(
        Effect.flip,
      );
      expect(linked.code).toBe("unsafe_path");
    })),
  );

  it.effect("loads bounded index and newest pinned topics deterministically", () =>
    run(Effect.gen(function*() {
      const { store } = yield* fixture({
        maxIndexLines: 2,
        maxIndexBytes: 64,
        maxPinnedTopics: 2,
      });
      yield* store.writeIndex("one\ntwo\nthree\n");
      yield* store.writeTopic(topic(
        "topics/old.md",
        "2026-07-27T08:00:00.000Z",
        true,
      ));
      yield* store.writeTopic(topic(
        "topics/new.md",
        "2026-07-29T08:00:00.000Z",
        true,
      ));
      yield* store.writeTopic(topic(
        "topics/middle.md",
        "2026-07-28T08:00:00.000Z",
        true,
      ));
      const startup = yield* store.readStartupContext();
      expect(startup.index).toBe("one\ntwo\n");
      expect(startup.pinned.map(({ relativePath }) => relativePath)).toEqual([
        "topics/new.md",
        "topics/middle.md",
      ]);
      expect(startup.degraded).toEqual(expect.arrayContaining([
        expect.stringContaining("line loading limit"),
        expect.stringContaining("pinned topics"),
      ]));
      expect(startup.inventory.map(({ relativePath }) => relativePath)).toEqual([
        "topics/middle.md",
        "topics/new.md",
        "topics/old.md",
      ]);
    })),
  );

  it.effect("enforces byte and topic ceilings and degrades oversized native files", () =>
    run(Effect.gen(function*() {
      const { fileSystem, paths, store } = yield* fixture({
        maxTopicBytes: 256,
        maxTopicFiles: 1,
      });
      yield* store.writeTopic(topic("topics/one.md"));
      const limit = yield* store.writeTopic(topic("topics/two.md")).pipe(
        Effect.flip,
      );
      expect(limit.code).toBe("limit_exceeded");
      yield* fileSystem.writeFileString(
        paths.join(store.root, "topics", "one.md"),
        "x".repeat(300),
      );
      const startup = yield* store.readStartupContext();
      expect(startup.inventory).toEqual([]);
      expect(startup.degraded[0]).toContain("byte topic limit");
    })),
  );

  it.effect("rejects malformed UTF-8 and stops guarded reads and commits", () =>
    run(Effect.gen(function*() {
      const { fileSystem, paths, store } = yield* fixture();
      yield* store.ensureLayout();
      yield* fileSystem.writeFile(
        paths.join(store.root, "topics", "bad.md"),
        new Uint8Array([0xff, 0xfe]),
      );
      expect((yield* store.readTopic("topics/bad.md").pipe(Effect.flip)).message)
        .toContain("UTF-8");

      const generation = yield* Ref.make(0);
      const guard = Ref.updateAndGet(generation, (value) => value + 1).pipe(
        Effect.flatMap((value) =>
          value >= 2 ? Effect.fail(new Error("paused")) : Effect.void
        ),
      );
      const guarded = yield* store.readStartupContext({
        beforeRead: guard,
      }).pipe(Effect.flip);
      expect(guarded.code).toBe("guard_failed");

      const before = yield* fileSystem.readFileString(
        paths.join(store.root, "MEMORY.md"),
      );
      const blocked = yield* store.writeIndex("replacement", {
        beforeCommit: Effect.fail(new Error("paused")),
      }).pipe(Effect.flip);
      expect(blocked.code).toBe("guard_failed");
      expect(yield* fileSystem.readFileString(paths.join(store.root, "MEMORY.md")))
        .toBe(before);
    })),
  );
});
