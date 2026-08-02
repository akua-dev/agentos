import * as BunServices from "@effect/platform-bun/BunServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import {
  discoverAgentOSSkillNamesEffect,
  registerAgentOSResourcesEffect,
  resolveAgentOSResourcesEffect,
} from "../src/resources.ts";
import { makePiTestHarness } from "./pi-test-harness.ts";

const DiscoveredResources = Schema.Array(Schema.Struct({
  skillPaths: Schema.Array(Schema.String),
}));

describe("AgentOS resource resolution", () => {
  it.effect("discovers native Skill names from delivered SKILL.md metadata", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-pi-skills-",
      });
      const skillDirectory = paths.resolve(root, "directory-name");
      yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
      yield* fileSystem.writeFileString(
        paths.resolve(skillDirectory, "SKILL.md"),
        [
          "---",
          "name: metadata-name",
          "description: A delivered Skill.",
          "---",
          "",
          "# Skill",
          "",
        ].join("\n"),
      );

      assert.deepStrictEqual(
        yield* discoverAgentOSSkillNamesEffect([root], root),
        ["metadata-name"],
      );
    }).pipe(Effect.provide(BunServices.layer))));

  it.effect("matches Pi discovery for root files, nested Skill roots, and ignores", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-pi-native-skills-",
      });
      yield* Effect.forEach(
        ["nested/valid", "nested/arbitrary", "ignored"],
        (directory) => fileSystem.makeDirectory(paths.resolve(root, directory), {
          recursive: true,
        }),
        { concurrency: "unbounded" },
      );
      yield* Effect.all([
        fileSystem.writeFileString(
          paths.resolve(root, "root-skill.md"),
          [
            "---",
            "name: root-skill",
            "description: A root Markdown Skill.",
            "---",
          ].join("\n"),
        ),
        fileSystem.writeFileString(
          paths.resolve(root, "nested", "valid", "SKILL.md"),
          [
            "---",
            "name: nested-skill",
            "description: A nested Skill root.",
            "---",
          ].join("\n"),
        ),
        fileSystem.writeFileString(
          paths.resolve(root, "nested", "arbitrary", "not-a-skill.md"),
          [
            "---",
            "name: must-not-load",
            "description: Nested arbitrary Markdown is not a Pi Skill.",
            "---",
          ].join("\n"),
        ),
        fileSystem.writeFileString(
          paths.resolve(root, "ignored", "SKILL.md"),
          [
            "---",
            "name: ignored-skill",
            "description: Pi ignore rules hide this Skill.",
            "---",
          ].join("\n"),
        ),
        fileSystem.writeFileString(paths.resolve(root, ".ignore"), "ignored/\n"),
      ], { concurrency: "unbounded" });

      assert.deepStrictEqual(
        yield* discoverAgentOSSkillNamesEffect([root], root),
        ["nested-skill", "root-skill"],
      );
    }).pipe(Effect.provide(BunServices.layer))));

  it.effect("rejects native Skill diagnostics and distinct duplicate owners", () =>
    Effect.scoped(Effect.gen(function*() {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "agentos-pi-invalid-skills-",
      });
      yield* Effect.forEach(
        ["missing-description", "first", "second"],
        (directory) => fileSystem.makeDirectory(paths.resolve(root, directory), {
          recursive: true,
        }),
        { concurrency: "unbounded" },
      );
      const incomplete = paths.resolve(root, "missing-description", "SKILL.md");
      yield* fileSystem.writeFileString(
        incomplete,
        ["---", "name: incomplete-skill", "---"].join("\n"),
      );
      const missingDescription = yield* discoverAgentOSSkillNamesEffect(
        [root],
        root,
      ).pipe(Effect.flip);
      assert.include(missingDescription.message, "description is required");

      yield* fileSystem.remove(paths.resolve(root, "missing-description"), {
        recursive: true,
      });
      yield* Effect.forEach(["first", "second"], (owner) =>
        fileSystem.writeFileString(
          paths.resolve(root, owner, "SKILL.md"),
          [
            "---",
            "name: duplicate-skill",
            `description: The ${owner} owner.`,
            "---",
          ].join("\n"),
        ));
      const duplicate = yield* discoverAgentOSSkillNamesEffect([root], root).pipe(
        Effect.flip,
      );
      assert.include(duplicate.message, 'name "duplicate-skill" collision');
    }).pipe(Effect.provide(BunServices.layer))));

  it.effect("resolves only package-contained role resource paths", () =>
    Effect.gen(function*() {
      const paths = yield* Path.Path;
      const baseDirectory = yield* paths.fromFileUrl(
        new URL("./fixtures/distribution", import.meta.url),
      );
      const resources = yield* resolveAgentOSResourcesEffect({
        version: 1,
        baseDirectory,
        skillPaths: ["roles/firstmate/skills"],
      });
      const expectedSkillPaths = [
        paths.resolve(baseDirectory, "roles/firstmate/skills"),
      ];
      assert.deepStrictEqual(resources.skillPaths, expectedSkillPaths);

      const fake = yield* makePiTestHarness();
      yield* registerAgentOSResourcesEffect(fake.pi, resources);
      const discovered = yield* fake.emit("resources_discover", {
        type: "resources_discover",
        cwd: "/workspace",
        reason: "startup",
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(DiscoveredResources)));
      assert.deepStrictEqual(discovered, [{ skillPaths: expectedSkillPaths }]);
    }).pipe(Effect.provide(BunServices.layer)));

  it.effect("rejects path traversal before attaching a hook", () =>
    Effect.gen(function*() {
      const fake = yield* makePiTestHarness();
      const failure = yield* resolveAgentOSResourcesEffect({
        version: 1,
        baseDirectory: "/distribution",
        skillPaths: ["../outside"],
      }).pipe(Effect.flip);
      assert.include(failure.message, "escapes the distribution resource root");
      assert.strictEqual(fake.extension.handlers.size, 0);
    }).pipe(Effect.provide(BunServices.layer)));
});
