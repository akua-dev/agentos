import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { digestMaterialDirectory } from "../../../runtime/composition/digest.ts";
import {
  canonicalCompositionJson,
  digestCompositionManifest,
  type CompositionManifest,
} from "../../../runtime/composition/manifest.ts";

const cli = resolve(import.meta.dir, "../composition-verify.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("composition-verify", () => {
  test("exposes the narrow validation boundary without a bundle", async () => {
    const result = await run("--help");

    expect(result).toEqual({
      exitCode: 0,
      stdout: expect.stringContaining(
        "It does not fetch, copy, install, load or activate anything.",
      ),
      stderr: "",
    });
  });

  test("verifies the exact manifest and every selected material", async () => {
    const { bundle, manifest } = await createBundle();
    const expectedDigest = digestCompositionManifest(manifest);

    const result = await run(bundle, "--manifest-digest", expectedDigest);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      manifest_digest: expectedDigest,
      materials: 1,
    });
  });

  test("rejects material changed after the manifest was resolved", async () => {
    const { bundle, manifest } = await createBundle();
    await writeFile(
      join(bundle, "materials", "delivery", "SKILL.md"),
      "# Changed after selection\n",
      "utf8",
    );

    const result = await run(
      bundle,
      "--manifest-digest",
      digestCompositionManifest(manifest),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("material digest mismatch");
  });

  test("rejects unselected material instead of exposing accidental context", async () => {
    const { bundle } = await createBundle();
    await mkdir(join(bundle, "materials", "unselected"));
    await writeFile(
      join(bundle, "materials", "unselected", "SKILL.md"),
      "# Must not load\n",
      "utf8",
    );

    const result = await run(bundle);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unselected material");
  });

  test("rejects malformed UTF-8 instead of hashing replacement characters", async () => {
    const bundle = await mkdtemp(join(tmpdir(), "composition-bundle-"));
    temporaryDirectories.push(bundle);
    await writeFile(
      join(bundle, "manifest.json"),
      Buffer.concat([
        Buffer.from(
          '{"version":1,"harness":"codex","materials":[],"settings":{"note":"',
          "utf8",
        ),
        Buffer.from([0xff]),
        Buffer.from('"}}\n', "utf8"),
      ]),
    );

    const result = await run(bundle);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("valid UTF-8");
  });

  test("rejects a Skill whose frontmatter name differs from its material ID", async () => {
    const { bundle } = await createBundle({ skillName: "other-delivery" });

    const result = await run(bundle);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Skill name other-delivery does not match material ID delivery",
    );
  });

  test("rejects a Skill without a model-visible description", async () => {
    const { bundle } = await createBundle({ description: "" });

    const result = await run(bundle);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Skill delivery requires a non-empty description",
    );
  });

  test("rejects a material ID that is not a valid Skill name", async () => {
    const { bundle } = await createBundle({
      materialId: "delivery.v2",
      skillName: "delivery.v2",
    });

    const result = await run(bundle);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Skill delivery.v2 has an invalid Skill name");
  });

  test("rejects a Skill description too large for native discovery", async () => {
    const { bundle } = await createBundle({ description: "a".repeat(1025) });

    const result = await run(bundle);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Skill delivery description exceeds 1024 characters",
    );
  });

  test("rejects Skill frontmatter whose closing delimiter exceeds the bounded prefix", async () => {
    const { bundle } = await createBundle({
      additionalFrontmatter: `padding: ${"a".repeat(64 * 1024)}`,
    });

    const result = await run(bundle);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Skill entrypoint requires YAML frontmatter within 65536 bytes",
    );
  });

  test("accepts valid UTF-8 whose body crosses the frontmatter prefix boundary", async () => {
    const header =
      "---\nname: delivery\ndescription: Deliver reviewed work.\n---\n";
    const { bundle } = await createBundle({
      body: `${"a".repeat(65535 - Buffer.byteLength(header))}€`,
    });

    const result = await run(bundle);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});

async function createBundle(
  options: {
    materialId?: string;
    skillName?: string;
    description?: string;
    additionalFrontmatter?: string;
    body?: string;
  } = {},
) {
  const bundle = await mkdtemp(join(tmpdir(), "composition-bundle-"));
  temporaryDirectories.push(bundle);
  const materialId = options.materialId ?? "delivery";
  const materialDirectory = join(bundle, "materials", materialId);
  await mkdir(materialDirectory, { recursive: true });
  const skillName = options.skillName ?? materialId;
  const description = options.description ?? "Deliver reviewed work.";
  const additionalFrontmatter = options.additionalFrontmatter
    ? `${options.additionalFrontmatter}\n`
    : "";
  const body = options.body ?? "";
  await writeFile(
    join(materialDirectory, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: ${description}\n${additionalFrontmatter}---\n${body}`,
    "utf8",
  );

  const manifest: CompositionManifest = {
    version: 1,
    harness: "codex",
    materials: [
      {
        id: materialId,
        kind: "skill",
        origin: {
          kind: "git",
          locator: "github.com/example/company",
          revision: "0123456789abcdef",
          path: "skills/delivery",
        },
        digest: await digestMaterialDirectory(materialDirectory),
        entrypoint: "SKILL.md",
      },
    ],
    settings: { effort: "medium" },
  };
  await writeFile(
    join(bundle, "manifest.json"),
    `${canonicalCompositionJson(manifest)}\n`,
    "utf8",
  );
  return { bundle, manifest };
}

async function run(...arguments_: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...arguments_], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
