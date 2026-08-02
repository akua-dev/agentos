import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { describe, expect, it } from "@effect/vitest";
import {
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Path,
  Ref,
  Scope,
} from "effect";

import {
  createMemoryActivityStore,
  redact,
  shouldDream,
  type MemoryActivityOptions,
} from "../../src/memory/activity.ts";

const platformLayer = Layer.mergeAll(
  BunCrypto.layer,
  BunFileSystem.layer,
  BunPath.layer,
);

function fixture(options: MemoryActivityOptions = {}) {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "agentos-memory-activity-",
    });
    const activity = yield* createMemoryActivityStore(home, options);
    return { activity, fileSystem, home, paths };
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

const fixedNow = Effect.succeed(new Date("2026-07-28T08:00:00.000Z"));

describe("Mate memory Effect activity store", () => {
  it.effect("stores only bounded, redacted projections with UTF-8-safe framing", () =>
    run(Effect.gen(function*() {
      const { activity } = yield* fixture({
        maxFileBytes: 320,
        now: fixedNow,
      });
      yield* activity.append("session/unsafe", {
        kind: "human",
        text: "Use token=sk-secret-value and password: hunter2 for this request.",
      });
      yield* activity.append("session/unsafe", {
        kind: "assistant",
        text: "I used Authorization: Bearer abcdefghijklmnop.",
      });
      yield* activity.append("session/unsafe", {
        kind: "tool",
        toolName: "read",
      });
      yield* activity.append("session/unsafe", {
        kind: "tool",
        toolName: "bash --with-arguments-that-must-not-survive",
      });

      const projection = yield* activity.readRecent(3);
      expect(Buffer.byteLength(projection)).toBeLessThanOrEqual(320);
      expect(projection).toContain("> Use token=[REDACTED]");
      expect(projection).toContain("< I used Authorization: [REDACTED]");
      expect(projection).toContain(". read");
      expect(projection).not.toContain("sk-secret-value");
      expect(projection).not.toContain("hunter2");
      expect(projection).not.toContain("--with-arguments");
      const quoted = redact(
        '{"password":"hunter2", "api_key": "secret-value"}',
      );
      expect(quoted).not.toContain("hunter2");
      expect(quoted).not.toContain("secret-value");

      const multibyte = yield* fixture({
        maxFileBytes: 120,
        maxSessionFiles: 2,
        now: fixedNow,
      });
      yield* multibyte.activity.append("first", {
        kind: "human",
        text: "é".repeat(200),
      });
      yield* multibyte.activity.append("second", {
        kind: "assistant",
        text: "界".repeat(200),
      });
      const bounded = yield* multibyte.activity.readRecent(3);
      expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(240);
      expect(bounded).toContain("## ");
      expect(bounded).toContain("é");
      expect(bounded).toContain("界");
    })),
  );

  it.effect("fails closed on mutation/read guards, invalid UTF-8, and linked log paths", () =>
    run(Effect.gen(function*() {
      const { activity } = yield* fixture({
        now: fixedNow,
      });
      const rejected = yield* activity.append(
        "paused",
        { kind: "human", text: "must not persist" },
        { beforeCommit: Effect.fail(new Error("paused")) },
      ).pipe(Effect.flip);
      expect(rejected.code).toBe("guard_failed");
      expect(yield* activity.readRecent(3)).toBe("");

      const linkedFixture = yield* fixture({ now: fixedNow });
      yield* linkedFixture.activity.ensureLayout();
      const outside = linkedFixture.paths.join(linkedFixture.home, "outside");
      yield* linkedFixture.fileSystem.makeDirectory(outside);
      yield* linkedFixture.fileSystem.symlink(
        outside,
        linkedFixture.paths.join(linkedFixture.activity.logsRoot, "2026"),
      );
      const linked = yield* linkedFixture.activity.append("escape", {
        kind: "human",
        text: "do not write",
      }).pipe(Effect.flip);
      expect(linked.code).toBe("unsafe_path");
      expect(yield* linkedFixture.fileSystem.readDirectory(outside)).toEqual([]);

      const corrupt = yield* fixture({ now: fixedNow });
      yield* corrupt.activity.ensureLayout();
      const day = corrupt.paths.join(
        corrupt.activity.logsRoot,
        "2026",
        "07",
        "28",
      );
      yield* corrupt.fileSystem.makeDirectory(day, { recursive: true });
      yield* corrupt.fileSystem.writeFile(
        corrupt.paths.join(day, "corrupt.md"),
        new Uint8Array([0xff]),
      );
      const invalid = yield* corrupt.activity.readRecent(3).pipe(Effect.flip);
      expect(invalid.code).toBe("invalid_utf8");

      const guarded = yield* fixture({ now: fixedNow });
      yield* guarded.activity.append("first", {
        kind: "human",
        text: "first activity",
      });
      yield* guarded.activity.append("second", {
        kind: "human",
        text: "second activity",
      });
      const reads = yield* Ref.make(0);
      const beforeRead = Ref.updateAndGet(reads, (value) => value + 1).pipe(
        Effect.flatMap((value) =>
          value >= 3
            ? Effect.fail(new Error("pause generation changed"))
            : Effect.void
        ),
      );
      const stopped = yield* guarded.activity.readRecent(3, {
        beforeRead,
      }).pipe(Effect.flip);
      expect(stopped.code).toBe("guard_failed");
    })),
  );

  it.effect("tracks Dream eligibility and serializes concurrent state mutations", () =>
    run(Effect.gen(function*() {
      const { activity } = yield* fixture();
      yield* activity.ensureState(new Date("2026-07-26T08:00:00.000Z"));
      yield* Effect.forEach(
        Array.from({ length: 5 }, (_, index) => index),
        (index) =>
          activity.completeSession(
            `prior-${index}`,
            new Date(`2026-07-27T0${index}:00:00.000Z`),
          ),
        { discard: true },
      );
      yield* activity.completeSession(
        "current",
        new Date("2026-07-28T07:00:00.000Z"),
      );
      yield* activity.completeSession(
        "prior-0",
        new Date("2026-07-28T07:30:00.000Z"),
      );
      const state = yield* activity.readState();
      expect(state.completedSessions).toHaveLength(6);
      expect(shouldDream(state, {
        currentSessionId: "current",
        now: new Date("2026-07-28T08:00:00.000Z"),
        minHours: 24,
        minPriorSessions: 5,
      })).toBe(true);
      expect(shouldDream(state, {
        currentSessionId: "current",
        now: new Date("2026-07-27T07:00:00.000Z"),
        minHours: 24,
        minPriorSessions: 5,
      })).toBe(false);
      expect(shouldDream(state, {
        currentSessionId: "current",
        now: new Date("2026-07-28T08:00:00.000Z"),
        minHours: 24,
        minPriorSessions: 6,
      })).toBe(false);

      const concurrent = yield* fixture();
      yield* concurrent.activity.ensureState(
        new Date("2026-07-28T08:00:00.000Z"),
      );
      yield* Effect.all([
        concurrent.activity.completeSession(
          "session-1",
          new Date("2026-07-28T09:00:00.000Z"),
        ),
        concurrent.activity.markDreamDiscovery(
          new Date("2026-07-28T10:00:00.000Z"),
        ),
      ], { concurrency: "unbounded", discard: true });
      const updated = yield* concurrent.activity.readState();
      expect(updated.completedSessions).toEqual([
        { sessionId: "session-1", completedAt: "2026-07-28T09:00:00.000Z" },
      ]);
      expect(updated.lastDreamDiscoveryAt).toBe("2026-07-28T10:00:00.000Z");

      const marker = yield* concurrent.activity.markDreamSuccess(
        new Date("2026-07-28T11:00:00.000Z"),
        { beforeCommit: Effect.fail(new Error("pause generation changed")) },
      ).pipe(Effect.flip);
      expect(marker.code).toBe("guard_failed");
      expect((yield* concurrent.activity.readState()).lastSuccessfulDreamAt)
        .toBeUndefined();
    })),
  );

  it.effect("keeps Dream locks exclusive, recovers stale locks, and protects ownership", () =>
    run(Effect.gen(function*() {
      const firstFixture = yield* fixture({ now: fixedNow });
      const first = firstFixture.activity;
      const claim = yield* first.claimDreamLock("process-a");
      expect(claim).toMatchObject({ acquired: true, staleRecovered: false });
      expect(yield* first.claimDreamLock("process-b")).toEqual({
        acquired: false,
        staleRecovered: false,
      });

      const later = yield* createMemoryActivityStore(firstFixture.home, {
        now: Effect.succeed(new Date("2026-07-28T09:00:01.000Z")),
      });
      const recovered = yield* later.claimDreamLock("process-c");
      expect(recovered).toMatchObject({ acquired: true, staleRecovered: true });
      yield* later.releaseDreamLock(recovered);
      expect(yield* firstFixture.fileSystem.exists(
        firstFixture.paths.join(
          firstFixture.home,
          "memory",
          ".consolidate-lock",
        ),
      )).toBe(false);

      const ownership = yield* fixture();
      yield* ownership.activity.ensureLayout();
      const lockPath = ownership.paths.join(
        ownership.home,
        "memory",
        ".consolidate-lock",
      );
      yield* ownership.fileSystem.writeFileString(
        lockPath,
        '{"owner":"new-owner","token":"new-token","startedAt":"2026-07-28T08:00:00.000Z"}\n',
      );
      yield* ownership.activity.releaseDreamLock({
        acquired: true,
        staleRecovered: false,
        owner: "old-owner",
        token: "old-token",
        startedAt: "2026-07-28T07:00:00.000Z",
      });
      expect(yield* ownership.fileSystem.readFileString(lockPath))
        .toContain('"token":"new-token"');

      yield* ownership.fileSystem.writeFileString(
        lockPath,
        '{"owner":"owner","token":"token","startedAt":"not-an-iso-date"}\n',
      );
      yield* ownership.activity.releaseDreamLock({
        acquired: true,
        staleRecovered: false,
        owner: "owner",
        token: "token",
        startedAt: "2026-07-28T08:00:00.000Z",
      });
      expect(yield* ownership.fileSystem.exists(lockPath)).toBe(true);
    })),
  );

  it.effect("rejects symbolic links at every coordination boundary", () =>
    run(Effect.gen(function*() {
      const root = yield* fixture();
      const outsideRoot = root.paths.join(root.home, "outside-root");
      yield* root.fileSystem.makeDirectory(outsideRoot);
      yield* root.fileSystem.symlink(
        outsideRoot,
        root.paths.join(root.home, "memory"),
      );
      expect((yield* root.activity.ensureLayout().pipe(Effect.flip)).code)
        .toBe("unsafe_path");

      const state = yield* fixture();
      const outsideState = state.paths.join(state.home, "outside-state.json");
      yield* state.activity.ensureLayout();
      yield* state.fileSystem.writeFileString(
        outsideState,
        '{"version":1,"firstSeenAt":"2026-07-28T08:00:00.000Z","completedSessions":[]}',
      );
      yield* state.fileSystem.symlink(outsideState, state.activity.statePath);
      expect((yield* state.activity.readState().pipe(Effect.flip)).code)
        .toBe("unsafe_path");

      const lock = yield* fixture();
      const outsideLock = lock.paths.join(lock.home, "outside-lock.json");
      yield* lock.activity.ensureLayout();
      yield* lock.fileSystem.writeFileString(
        outsideLock,
        '{"owner":"outside","token":"outside","startedAt":"2026-07-28T08:00:00.000Z"}',
      );
      yield* lock.fileSystem.symlink(
        outsideLock,
        lock.paths.join(lock.home, "memory", ".consolidate-lock"),
      );
      expect((yield* lock.activity.claimDreamLock("inside").pipe(Effect.flip)).code)
        .toBe("unsafe_path");
    })),
  );
});
