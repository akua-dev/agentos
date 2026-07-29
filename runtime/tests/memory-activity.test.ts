import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryActivityStore,
  redact,
  shouldDream,
} from "@akua-dev/agentos-pi";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function temporaryHome() {
  const home = await mkdtemp(join(tmpdir(), "agentos-memory-activity-"));
  temporaryDirectories.push(home);
  return home;
}

describe("Mate memory activity projection", () => {
  test("stores bounded redacted human, response, and tool-name projections only", async () => {
    const home = await temporaryHome();
    const activity = createMemoryActivityStore(home, {
      maxFileBytes: 320,
      now: () => new Date("2026-07-28T08:00:00.000Z"),
    });

    await activity.append("session/unsafe", {
      kind: "human",
      text: "Use token=sk-secret-value and password: hunter2 for this request.",
    });
    await activity.append("session/unsafe", {
      kind: "assistant",
      text: "I used Authorization: Bearer abcdefghijklmnop.",
    });
    await activity.append("session/unsafe", {
      kind: "tool",
      toolName: "read",
    });
    await activity.append("session/unsafe", {
      kind: "tool",
      toolName: "bash --with-arguments-that-must-not-survive",
    });

    const projection = await activity.readRecent(3);
    expect(Buffer.byteLength(projection)).toBeLessThanOrEqual(320);
    expect(projection).toContain("> Use token=[REDACTED]");
    expect(projection).toContain("< I used Authorization: [REDACTED]");
    expect(projection).toContain(". read");
    expect(projection).not.toContain("sk-secret-value");
    expect(projection).not.toContain("hunter2");
    expect(projection).not.toContain("--with-arguments");
  });

  test("bounds recent activity including framing and multibyte content", async () => {
    const home = await temporaryHome();
    const activity = createMemoryActivityStore(home, {
      maxFileBytes: 120,
      maxSessionFiles: 2,
      now: () => new Date("2026-07-28T08:00:00.000Z"),
    });

    await activity.append("first", {
      kind: "human",
      text: "é".repeat(200),
    });
    await activity.append("second", {
      kind: "assistant",
      text: "界".repeat(200),
    });

    const projection = await activity.readRecent(3);
    expect(Buffer.byteLength(projection)).toBeLessThanOrEqual(240);
    expect(projection).toContain("## ");
    expect(projection).toContain("é");
    expect(projection).toContain("界");
  });

  test("does not commit activity when the final commit guard rejects", async () => {
    const home = await temporaryHome();
    const activity = createMemoryActivityStore(home, {
      now: () => new Date("2026-07-28T08:00:00.000Z"),
    });

    await expect(
      activity.append(
        "paused",
        { kind: "human", text: "must not persist" },
        {
          beforeCommit: () => {
            throw new Error("paused");
          },
        },
      ),
    ).rejects.toThrow("paused");
    expect(await activity.readRecent(3)).toBe("");
  });

  test("redacts quoted credential values", () => {
    const projection = redact(
      '{"password":"hunter2", "api_key": "api-secret-value"}',
    );

    expect(projection).not.toContain("hunter2");
    expect(projection).not.toContain("api-secret-value");
  });

  test("rejects nested symbolic-link activity paths", async () => {
    const home = await temporaryHome();
    const outside = join(home, "outside");
    await mkdir(outside);
    const activity = createMemoryActivityStore(home, {
      now: () => new Date("2026-07-28T08:00:00.000Z"),
    });
    await activity.ensureLayout();
    await symlink(outside, join(activity.logsRoot, "2026"));

    await expect(
      activity.append("escape", { kind: "human", text: "do not write" }),
    ).rejects.toThrow("symbolic link");
    expect(await readdir(outside)).toEqual([]);
  });

  test("rejects malformed UTF-8 activity before returning it", async () => {
    const home = await temporaryHome();
    const activity = createMemoryActivityStore(home, {
      now: () => new Date("2026-07-28T08:00:00.000Z"),
    });
    await activity.ensureLayout();
    const day = join(activity.logsRoot, "2026", "07", "28");
    await mkdir(day, { recursive: true });
    await writeFile(join(day, "corrupt.md"), new Uint8Array([0xff]));

    await expect(activity.readRecent(3)).rejects.toThrow("not valid UTF-8");
  });

  test("tracks distinct completed prior sessions and requires both Dream thresholds", async () => {
    const home = await temporaryHome();
    const activity = createMemoryActivityStore(home);
    await activity.ensureState(new Date("2026-07-26T08:00:00.000Z"));
    for (let index = 0; index < 5; index += 1) {
      await activity.completeSession(
        `prior-${index}`,
        new Date(`2026-07-27T0${index}:00:00.000Z`),
      );
    }
    await activity.completeSession(
      "current",
      new Date("2026-07-28T07:00:00.000Z"),
    );
    await activity.completeSession(
      "prior-0",
      new Date("2026-07-28T07:30:00.000Z"),
    );

    const state = await activity.readState();
    expect(state.completedSessions).toHaveLength(6);
    expect(
      shouldDream(state, {
        currentSessionId: "current",
        now: new Date("2026-07-28T08:00:00.000Z"),
        minHours: 24,
        minPriorSessions: 5,
      }),
    ).toBe(true);
    expect(
      shouldDream(state, {
        currentSessionId: "current",
        now: new Date("2026-07-27T07:00:00.000Z"),
        minHours: 24,
        minPriorSessions: 5,
      }),
    ).toBe(false);
    expect(
      shouldDream(state, {
        currentSessionId: "current",
        now: new Date("2026-07-28T08:00:00.000Z"),
        minHours: 24,
        minPriorSessions: 6,
      }),
    ).toBe(false);
  });

  test("claims one live lock and atomically recovers a lock older than one hour", async () => {
    const home = await temporaryHome();
    const first = createMemoryActivityStore(home, {
      now: () => new Date("2026-07-28T08:00:00.000Z"),
    });
    const claim = await first.claimDreamLock("process-a");
    expect(claim).toMatchObject({ acquired: true, staleRecovered: false });
    expect(await first.claimDreamLock("process-b")).toEqual({
      acquired: false,
      staleRecovered: false,
    });

    const later = createMemoryActivityStore(home, {
      now: () => new Date("2026-07-28T09:00:01.000Z"),
    });
    const recovered = await later.claimDreamLock("process-c");
    expect(recovered).toMatchObject({
      acquired: true,
      staleRecovered: true,
    });
    if (recovered.acquired) await later.releaseDreamLock(recovered);
    await expect(
      readFile(join(home, "memory", ".consolidate-lock"), "utf8"),
    ).rejects.toThrow();
  });

  test("does not let a non-owner release a replaced lock", async () => {
    const home = await temporaryHome();
    const activity = createMemoryActivityStore(home);
    await activity.ensureLayout();
    await writeFile(
      join(home, "memory", ".consolidate-lock"),
      JSON.stringify({
        owner: "new-owner",
        token: "new-token",
        startedAt: "2026-07-28T08:00:00.000Z",
      }),
      "utf8",
    );
    await activity.releaseDreamLock({
      acquired: true,
      staleRecovered: false,
      owner: "old-owner",
      token: "old-token",
      startedAt: "2026-07-28T07:00:00.000Z",
    });
    expect(
      JSON.parse(
        await readFile(join(home, "memory", ".consolidate-lock"), "utf8"),
      ).token,
    ).toBe("new-token");
  });

  test("refuses a symbolic-link memory root", async () => {
    const home = await temporaryHome();
    const outside = join(home, "outside");
    await mkdir(outside);
    await symlink(outside, join(home, "memory"));

    const activity = createMemoryActivityStore(home);
    await expect(activity.ensureLayout()).rejects.toThrow("symbolic link");
  });

  test("refuses a symbolic-link coordination state file", async () => {
    const home = await temporaryHome();
    const outside = join(home, "outside-state.json");
    const activity = createMemoryActivityStore(home);
    await activity.ensureLayout();
    await writeFile(
      outside,
      JSON.stringify({ version: 1, firstSeenAt: "2026-07-28T08:00:00.000Z", completedSessions: [] }),
      "utf8",
    );
    await symlink(outside, activity.statePath);

    await expect(activity.readState()).rejects.toThrow("symbolic link");
  });

  test("stops reading the activity projection when its read guard changes", async () => {
    const home = await temporaryHome();
    const activity = createMemoryActivityStore(home, {
      now: () => new Date("2026-07-28T08:00:00.000Z"),
    });
    await activity.append("first", { kind: "human", text: "first activity" });
    await activity.append("second", { kind: "human", text: "second activity" });
    let reads = 0;

    await expect(
      activity.readRecent(3, {
        beforeRead: () => {
          reads += 1;
          if (reads === 11) throw new Error("pause generation changed");
        },
      }),
    ).rejects.toThrow("pause generation changed");
  });

  test("does not read a symbolic-link Dream lock outside the Mate home", async () => {
    const home = await temporaryHome();
    const outside = join(home, "outside-lock.json");
    const activity = createMemoryActivityStore(home);
    await activity.ensureLayout();
    await writeFile(
      outside,
      JSON.stringify({
        owner: "outside",
        token: "outside",
        startedAt: "2026-07-28T08:00:00.000Z",
      }),
      "utf8",
    );
    await symlink(outside, join(home, "memory", ".consolidate-lock"));

    await expect(activity.claimDreamLock("inside")).rejects.toThrow(
      "symbolic link",
    );
  });

  test("honors a Dream marker commit guard", async () => {
    const home = await temporaryHome();
    const activity = createMemoryActivityStore(home);
    await activity.ensureState(new Date("2026-07-28T08:00:00.000Z"));

    await expect(
      activity.markDreamSuccess(new Date("2026-07-28T09:00:00.000Z"), {
        beforeCommit: () => {
          throw new Error("pause generation changed");
        },
      }),
    ).rejects.toThrow("pause generation changed");
    expect((await activity.readState()).lastSuccessfulDreamAt).toBeUndefined();
  });

  test("preserves concurrent session and Dream state updates", async () => {
    const home = await temporaryHome();
    const activity = createMemoryActivityStore(home);
    await activity.ensureState(new Date("2026-07-28T08:00:00.000Z"));

    await Promise.all([
      activity.completeSession("session-1", new Date("2026-07-28T09:00:00.000Z")),
      activity.markDreamDiscovery(new Date("2026-07-28T10:00:00.000Z")),
    ]);

    const state = await activity.readState();
    expect(state.completedSessions).toEqual([
      { sessionId: "session-1", completedAt: "2026-07-28T09:00:00.000Z" },
    ]);
    expect(state.lastDreamDiscoveryAt).toBe("2026-07-28T10:00:00.000Z");
  });
});
