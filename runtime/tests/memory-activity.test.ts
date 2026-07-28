import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryActivityStore,
  shouldDream,
} from "../memory/activity.ts";

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
});
