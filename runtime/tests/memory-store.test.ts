import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMateMemoryStore,
  type TopicWrite,
} from "../memory/store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function temporaryHome() {
  const home = await mkdtemp(join(tmpdir(), "agentos-memory-"));
  temporaryDirectories.push(home);
  return home;
}

function topic(
  overrides: Partial<TopicWrite> & Pick<TopicWrite, "relativePath">,
): TopicWrite {
  return {
    body: "Use concise progress reports.",
    metadata: {
      node_type: "memory",
      type: "feedback",
      scope: "captain",
      source_principal: "captain",
      observed_at: "2026-07-28T08:00:00.000Z",
      modified: "2026-07-28T08:00:00.000Z",
      pinned: false,
    },
    ...overrides,
  };
}

describe("Mate memory storage", () => {
  test("bootstraps an empty bounded index without replacing existing memory", async () => {
    const home = await temporaryHome();
    const store = createMateMemoryStore(home);

    await store.ensureLayout();
    expect(await readFile(join(home, "memory", "MEMORY.md"), "utf8")).toBe(
      "# Memory index\n",
    );

    await writeFile(
      join(home, "memory", "MEMORY.md"),
      "# Memory index\n- Keep me\n",
      "utf8",
    );
    await store.ensureLayout();
    expect(await readFile(join(home, "memory", "MEMORY.md"), "utf8")).toBe(
      "# Memory index\n- Keep me\n",
    );
  });

  test("round-trips the exact typed topic contract and stamps native edits", async () => {
    const home = await temporaryHome();
    const store = createMateMemoryStore(home);
    await store.ensureLayout();

    await store.writeTopic(topic({ relativePath: "topics/reporting.md" }));
    const parsed = await store.readTopic("topics/reporting.md");
    expect(parsed.metadata).toEqual({
      node_type: "memory",
      type: "feedback",
      scope: "captain",
      source_principal: "captain",
      observed_at: "2026-07-28T08:00:00.000Z",
      modified: "2026-07-28T08:00:00.000Z",
      pinned: false,
    });
    expect(parsed.body).toBe("Use concise progress reports.");

    const original = await readFile(
      join(home, "memory", "topics", "reporting.md"),
      "utf8",
    );
    await writeFile(
      join(home, "memory", "topics", "reporting.md"),
      original.replace("concise", "outcome-first"),
      "utf8",
    );
    const stamped = await store.validateAndStamp("topics/reporting.md", {
      now: new Date("2026-07-28T09:00:00.000Z"),
    });
    expect(stamped.metadata.modified).toBe("2026-07-28T09:00:00.000Z");
    expect(stamped.body).toContain("outcome-first");
  });

  test("rejects invalid metadata, path escape, and symlink traversal", async () => {
    const home = await temporaryHome();
    const store = createMateMemoryStore(home);
    await store.ensureLayout();

    await expect(
      store.writeTopic(
        topic({
          relativePath: "../escape.md",
        }),
      ),
    ).rejects.toThrow("topics/");
    await expect(
      store.writeTopic(
        topic({
          relativePath: "topics/invalid.md",
          metadata: {
            ...topic({ relativePath: "topics/x.md" }).metadata,
            type: "secret" as "feedback",
          },
        }),
      ),
    ).rejects.toThrow("type");

    const outside = join(home, "outside");
    await mkdir(outside);
    await symlink(outside, join(home, "memory", "topics", "linked"));
    await expect(
      store.writeTopic(topic({ relativePath: "topics/linked/escape.md" })),
    ).rejects.toThrow("symbolic link");

    const outsideTopic = join(outside, "topic.md");
    await writeFile(
      outsideTopic,
      "---\nnode_type: memory\ntype: reference\nscope: fleet\nsource_principal: attacker\nobserved_at: 2026-07-28T08:00:00.000Z\nmodified: 2026-07-28T08:00:00.000Z\npinned: false\n---\nDo not load me.\n",
      "utf8",
    );
    await symlink(
      outsideTopic,
      join(home, "memory", "topics", "alias.md"),
    );
    await expect(store.readTopic("topics/alias.md")).rejects.toThrow(
      "symbolic link",
    );

    await unlink(join(home, "memory", "MEMORY.md"));
    await symlink(outsideTopic, join(home, "memory", "MEMORY.md"));
    await expect(store.ensureLayout()).rejects.toThrow("symbolic link");
  });

  test("loads a bounded index and the newest pinned topics deterministically", async () => {
    const home = await temporaryHome();
    const store = createMateMemoryStore(home, {
      maxIndexBytes: 48,
      maxIndexLines: 3,
      maxPinnedTopics: 2,
    });
    await store.ensureLayout();
    await store.writeIndex("# Memory index\nline 2\nline 3\nline 4\n");
    await store.writeTopic(
      topic({
        relativePath: "topics/older.md",
        metadata: {
          ...topic({ relativePath: "topics/x.md" }).metadata,
          modified: "2026-07-26T08:00:00.000Z",
          pinned: true,
        },
      }),
    );
    await store.writeTopic(
      topic({
        relativePath: "topics/newest.md",
        metadata: {
          ...topic({ relativePath: "topics/x.md" }).metadata,
          modified: "2026-07-28T08:00:00.000Z",
          pinned: true,
        },
      }),
    );
    await store.writeTopic(
      topic({
        relativePath: "topics/middle.md",
        metadata: {
          ...topic({ relativePath: "topics/x.md" }).metadata,
          modified: "2026-07-27T08:00:00.000Z",
          pinned: true,
        },
      }),
    );

    const startup = await store.readStartupContext();
    expect(startup.index).toBe("# Memory index\nline 2\nline 3\n");
    expect(startup.degraded).toContain(
      "MEMORY.md exceeds the 3-line loading limit",
    );
    expect(startup.pinned.map(({ relativePath }) => relativePath)).toEqual([
      "topics/newest.md",
      "topics/middle.md",
    ]);
    expect(startup.degraded).toContain(
      "3 pinned topics exceed the 2-topic loading limit",
    );
  });

  test("stops reading MEMORY.md at the released byte boundary", async () => {
    const home = await temporaryHome();
    const prefix = "# Memory index\nsafe prefix\n";
    const store = createMateMemoryStore(home, {
      maxIndexBytes: Buffer.byteLength(prefix),
    });
    await store.ensureLayout();
    await writeFile(
      join(home, "memory", "MEMORY.md"),
      Buffer.concat([
        Buffer.from(prefix),
        Buffer.from([0xff]),
        Buffer.alloc(1_000_000, 0x61),
      ]),
    );

    const startup = await store.readStartupContext();

    expect(startup.index).toBe(prefix);
    expect(startup.degraded).toContain(
      `MEMORY.md exceeds the ${Buffer.byteLength(prefix)}-byte loading limit`,
    );
    expect(startup.degraded).not.toContain("MEMORY.md is not valid UTF-8");
  });

  test("fails visibly on invalid UTF-8 and enforces the topic-file limit", async () => {
    const home = await temporaryHome();
    const store = createMateMemoryStore(home, { maxTopicFiles: 1 });
    await store.ensureLayout();
    await store.writeTopic(topic({ relativePath: "topics/one.md" }));
    await expect(
      store.writeTopic(topic({ relativePath: "topics/two.md" })),
    ).rejects.toThrow("1-topic limit");

    await writeFile(
      join(home, "memory", "MEMORY.md"),
      new Uint8Array([0xc3, 0x28]),
    );
    const startup = await store.readStartupContext();
    expect(startup.index).toBe("");
    expect(startup.degraded).toContain("MEMORY.md is not valid UTF-8");
  });
});
