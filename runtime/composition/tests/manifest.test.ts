import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestMaterialDirectory } from "../digest.ts";
import {
  canonicalCompositionJson,
  digestCompositionManifest,
  parseCompositionManifest,
  type CompositionManifest,
} from "../manifest.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function material(
  id: string,
  kind: "instructions" | "skill",
) {
  return {
    id,
    kind,
    origin: {
      kind: "git",
      locator: "github.com/example/company-capabilities",
      path: `materials/${id}`,
      revision: "0123456789abcdef",
    },
    digest: `sha256:${"a".repeat(64)}`,
    entrypoint:
      kind === "skill"
        ? "SKILL.md"
        : "instructions.md",
  };
}

function manifest(): CompositionManifest {
  return {
    version: 1,
    composer: {
      id: "agentos-composition",
      origin: {
        kind: "git",
        locator: "github.com/akua-dev/agentos",
        revision: "0123456789abcdef",
        path: "agents/.agents/skills/agentos-composition",
      },
      digest: `sha256:${"b".repeat(64)}`,
    },
    materials: [
      material("instructions", "instructions"),
      material("delivery", "skill"),
    ],
    harness: "pi",
    settings: {
      model: "gpt-5.6-sol",
      effort: "xhigh",
      fast_mode: true,
      compaction: { strategy: "server" },
      context_limit: 200_000,
      image: "registry.example/agent@sha256:1234",
    },
    capability_requirements: [
      {
        id: "github:repository",
        access: "contents:write,pull_requests:write",
        authority_ref: "captain:github-app",
      },
    ],
  };
}

describe("composition manifest preflight", () => {
  test("accepts an open settings object inside the closed envelope", () => {
    const candidate = manifest();
    expect(parseCompositionManifest(candidate)).toEqual(candidate);
  });

  test("keeps external composers and material origins storage-neutral", () => {
    const candidate: CompositionManifest = {
      ...manifest(),
      composer: {
        id: "company-composer",
        origin: {
          kind: "filesystem",
          locator: "/approved/company-policy",
          revision: "policy-v7",
        },
        digest: `sha256:${"c".repeat(64)}`,
      },
      materials: [
        material("delivery", "skill"),
        {
          ...material("support", "instructions"),
          origin: {
            kind: "object-store",
            locator: "company-capabilities",
            revision: "version-42",
            path: "support",
            object_version: "immutable-42",
          },
        },
      ],
    };

    expect(parseCompositionManifest(candidate)).toEqual(candidate);
  });

  test("rejects values that cannot survive exact JSON storage", () => {
    const lossy = {
      ...manifest(),
      settings: { effort: "high", lossy: undefined },
    };

    expect(() =>
      parseCompositionManifest(lossy),
    ).toThrow("JSON values");
    expect(() =>
      digestCompositionManifest(lossy as unknown as CompositionManifest),
    ).toThrow("JSON values");
  });

  test("rejects executable, ambiguous and unsafe composition material", () => {
    const candidates: unknown[] = [
      { ...manifest(), version: 2 },
      { ...manifest(), settings: [] },
      {
        ...manifest(),
        fast_mode: true,
      },
      {
        ...manifest(),
        materials: [{ ...material("invalid", "skill"), kind: "mise_config" }],
      },
      {
        ...manifest(),
        materials: [
          { ...material("invalid", "skill"), kind: "harness_extension" },
        ],
      },
      {
        ...manifest(),
        materials: [
          material("duplicate", "skill"),
          material("duplicate", "skill"),
        ],
      },
      {
        ...manifest(),
        materials: [
          { ...material("escape", "skill"), entrypoint: "../SKILL.md" },
        ],
      },
      {
        ...manifest(),
        materials: [
          { ...material("nested", "skill"), entrypoint: "nested/SKILL.md" },
        ],
      },
      {
        ...manifest(),
        materials: [material("invalid_skill", "skill")],
      },
      {
        ...manifest(),
        materials: [
          {
            ...material("blank-origin", "skill"),
            origin: { kind: "git", locator: "   " },
          },
        ],
      },
    ];

    for (const candidate of candidates) {
      expect(() => parseCompositionManifest(candidate)).toThrow();
    }
  });

  test("canonicalizes equivalent JSON independently of object key order", () => {
    const original = manifest();
    const reordered = {
      harness: original.harness,
      materials: original.materials.map((item) => ({
        entrypoint: item.entrypoint,
        digest: item.digest,
        origin: {
          revision: item.origin.revision,
          path: item.origin.path,
          locator: item.origin.locator,
          kind: item.origin.kind,
        },
        kind: item.kind,
        id: item.id,
        ...("harness" in item ? { harness: item.harness } : {}),
      })),
      version: original.version,
      capability_requirements: original.capability_requirements,
      settings: original.settings,
      composer: original.composer,
    };

    expect(
      canonicalCompositionJson(parseCompositionManifest(reordered)),
    ).toBe(canonicalCompositionJson(parseCompositionManifest(original)));
    expect(
      digestCompositionManifest(parseCompositionManifest(reordered)),
    ).toBe(digestCompositionManifest(parseCompositionManifest(original)));

    expect(
      digestCompositionManifest({
        ...original,
        settings: { ...original.settings, effort: "medium" },
      }),
    ).not.toBe(digestCompositionManifest(original));
  });
});

describe("composition material digest", () => {
  test("orders paths by raw UTF-8 bytes rather than host locale", async () => {
    const directory = await temporaryDirectory("agentos-composition-order-");
    await writeFile(join(directory, "a.txt"), "a\n", "utf8");
    await writeFile(join(directory, "Z.txt"), "z\n", "utf8");

    const expected = createHash("sha256");
    for (const [path, contents] of [
      ["Z.txt", "z\n"],
      ["a.txt", "a\n"],
    ] as const) {
      expected.update("file\0");
      expected.update(path, "utf8");
      expected.update("\0regular\0");
      expected.update(String(Buffer.byteLength(contents)));
      expected.update("\0");
      expected.update(contents, "utf8");
      expected.update("\0");
    }

    expect(await digestMaterialDirectory(directory)).toBe(
      `sha256:${expected.digest("hex")}`,
    );
  });

  test("is deterministic across creation order and changes with executable intent", async () => {
    const first = await temporaryDirectory("agentos-composition-digest-a-");
    const second = await temporaryDirectory("agentos-composition-digest-b-");

    await mkdir(join(first, "nested"), { recursive: true });
    await writeFile(join(first, "nested", "b.txt"), "second\n", "utf8");
    await writeFile(join(first, "a.txt"), "first\n", "utf8");

    await writeFile(join(second, "a.txt"), "first\n", "utf8");
    await mkdir(join(second, "nested"), { recursive: true });
    await writeFile(join(second, "nested", "b.txt"), "second\n", "utf8");

    const before = await digestMaterialDirectory(first);
    expect(await digestMaterialDirectory(second)).toBe(before);

    await chmod(join(second, "nested", "b.txt"), 0o755);
    expect(await digestMaterialDirectory(second)).not.toBe(before);
  });

  test("rejects symlinks instead of hashing an escaping or mutable target", async () => {
    const directory = await temporaryDirectory("agentos-composition-link-");
    await writeFile(join(directory, "target.txt"), "target\n", "utf8");
    await symlink("target.txt", join(directory, "link.txt"));

    await expect(digestMaterialDirectory(directory)).rejects.toThrow(
      "symlink",
    );
  });

  test("rejects a same-size file change while streaming its digest", async () => {
    const directory = await temporaryDirectory("agentos-composition-race-");
    const path = join(directory, "large.bin");
    await writeFile(path, "");
    await truncate(path, 64 * 1024 * 1024);

    const handle = await open(path, "r+");
    let keepChanging = true;
    const changing = (async () => {
      let byte = 0;
      while (keepChanging) {
        await handle.write(Uint8Array.of(byte++ % 256), 0, 1, 0);
        await handle.sync();
        await Bun.sleep(1);
      }
      await handle.close();
    })();

    try {
      await expect(digestMaterialDirectory(directory)).rejects.toThrow(
        "changed while hashing",
      );
    } finally {
      keepChanging = false;
      await changing;
    }
  });

  test("rejects a material root replaced while its files are being hashed", async () => {
    const parent = await temporaryDirectory("agentos-composition-root-race-");
    const directory = join(parent, "material");
    const movedDirectory = join(parent, "material-before-replacement");
    const replacement = join(parent, "replacement");
    await mkdir(directory);
    await mkdir(replacement);

    for (const root of [directory, replacement]) {
      await writeFile(join(root, "000-large.bin"), "");
      await truncate(join(root, "000-large.bin"), 128 * 1024 * 1024);
      await writeFile(join(root, "SKILL.md"), "same bytes\n", "utf8");
    }

    const digesting = digestMaterialDirectory(directory);
    await Bun.sleep(5);
    await rename(directory, movedDirectory);
    await symlink(replacement, directory, "dir");

    await expect(digesting).rejects.toThrow(
      /changed while hashing|changed path identity|resolves outside/,
    );
  });

  test("rejects a file added below an already-scanned nested directory", async () => {
    const directory = await temporaryDirectory(
      "agentos-composition-nested-race-",
    );
    const nested = join(directory, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "000-large.bin"), "");
    await truncate(join(nested, "000-large.bin"), 128 * 1024 * 1024);

    const digesting = digestMaterialDirectory(directory);
    await Bun.sleep(5);
    await writeFile(join(nested, "late.md"), "not in the snapshot\n", "utf8");

    await expect(digesting).rejects.toThrow(/changed while hashing/);
  });
});

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
