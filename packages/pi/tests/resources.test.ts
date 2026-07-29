import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import {
  resolveAgentOSResources,
  registerAgentOSResources,
} from "../src/index.ts";
import { createFakePi } from "./fake-pi.ts";

describe("AgentOS resource composition", () => {
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
