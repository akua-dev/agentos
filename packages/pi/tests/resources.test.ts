import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  discoverAgentOSSkillNames,
  resolveAgentOSResources,
  registerAgentOSResources,
} from "../src/index.ts";
import { createFakePi } from "./fake-pi.ts";

describe("AgentOS resource composition", () => {
  test("discovers native Skill names from delivered SKILL.md metadata", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentos-pi-skills-"));
    try {
      const skillDirectory = resolve(root, "directory-name");
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(
        resolve(skillDirectory, "SKILL.md"),
        [
          "---",
          "name: metadata-name",
          "description: A delivered Skill.",
          "---",
          "",
          "# Skill",
          "",
        ].join("\n"),
        "utf8",
      );

      expect(await discoverAgentOSSkillNames([root])).toEqual([
        "metadata-name",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("matches Pi discovery for root files, nested Skill roots, and ignores", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentos-pi-native-skills-"));
    try {
      await Promise.all([
        mkdir(resolve(root, "nested", "valid"), { recursive: true }),
        mkdir(resolve(root, "nested", "arbitrary"), { recursive: true }),
        mkdir(resolve(root, "ignored"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          resolve(root, "root-skill.md"),
          [
            "---",
            "name: root-skill",
            "description: A root Markdown Skill.",
            "---",
          ].join("\n"),
          "utf8",
        ),
        writeFile(
          resolve(root, "nested", "valid", "SKILL.md"),
          [
            "---",
            "name: nested-skill",
            "description: A nested Skill root.",
            "---",
          ].join("\n"),
          "utf8",
        ),
        writeFile(
          resolve(root, "nested", "arbitrary", "not-a-skill.md"),
          [
            "---",
            "name: must-not-load",
            "description: Nested arbitrary Markdown is not a Pi Skill.",
            "---",
          ].join("\n"),
          "utf8",
        ),
        writeFile(
          resolve(root, "ignored", "SKILL.md"),
          [
            "---",
            "name: ignored-skill",
            "description: Pi ignore rules hide this Skill.",
            "---",
          ].join("\n"),
          "utf8",
        ),
        writeFile(resolve(root, ".ignore"), "ignored/\n", "utf8"),
      ]);

      expect(await discoverAgentOSSkillNames([root])).toEqual([
        "nested-skill",
        "root-skill",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects native Skill diagnostics and distinct duplicate owners", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "agentos-pi-invalid-skills-"));
    try {
      await Promise.all([
        mkdir(resolve(root, "missing-description"), { recursive: true }),
        mkdir(resolve(root, "first"), { recursive: true }),
        mkdir(resolve(root, "second"), { recursive: true }),
      ]);
      await writeFile(
        resolve(root, "missing-description", "SKILL.md"),
        ["---", "name: incomplete-skill", "---"].join("\n"),
        "utf8",
      );
      await expect(discoverAgentOSSkillNames([root])).rejects.toThrow(
        "description is required",
      );

      await rm(resolve(root, "missing-description"), {
        recursive: true,
        force: true,
      });
      for (const owner of ["first", "second"]) {
        await writeFile(
          resolve(root, owner, "SKILL.md"),
          [
            "---",
            "name: duplicate-skill",
            `description: The ${owner} owner.`,
            "---",
          ].join("\n"),
          "utf8",
        );
      }
      await expect(discoverAgentOSSkillNames([root])).rejects.toThrow(
        'name "duplicate-skill" collision',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolves only package-contained role resource paths", async () => {
    const baseDirectory = resolve(import.meta.dir, "fixtures", "distribution");
    const resources = resolveAgentOSResources({
      version: 1,
      baseDirectory,
      skillPaths: ["roles/firstmate/skills"],
    });
    expect(resources.skillPaths).toEqual([
      resolve(baseDirectory, "roles/firstmate/skills"),
    ]);

    const fake = createFakePi();
    registerAgentOSResources(fake.pi, resources);
    expect(await fake.emit("resources_discover", {
      type: "resources_discover",
      cwd: "/workspace",
      reason: "startup",
    })).toEqual([{ skillPaths: resources.skillPaths }]);
  });

  test("rejects path traversal before attaching a hook", () => {
    const fake = createFakePi();
    expect(() =>
      registerAgentOSResources(
        fake.pi,
        resolveAgentOSResources({
          version: 1,
          baseDirectory: "/distribution",
          skillPaths: ["../outside"],
        }),
      ),
    ).toThrow("escapes the distribution resource root");
    expect(fake.registrations).toEqual([]);
  });
});
