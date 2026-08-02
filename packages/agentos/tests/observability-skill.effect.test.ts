import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { AGENTOS_AI_METRICS } from "../src/telemetry/contract.ts";
import { AGENTOS_RESILIENCE_METRICS } from "../src/telemetry/resilience-runtime.ts";

const platform = Layer.merge(BunFileSystem.layer, BunPath.layer);

function reference(name: string) {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const references = yield* paths.fromFileUrl(
      new URL("../skills/agentos-observability/references/", import.meta.url),
    );
    return yield* fileSystem.readFileString(paths.join(references, name));
  });
}

function skill() {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const paths = yield* Path.Path;
    const path = yield* paths.fromFileUrl(
      new URL("../skills/agentos-observability/SKILL.md", import.meta.url),
    );
    return yield* fileSystem.readFileString(path);
  });
}

layer(platform)("AgentOS observability operator skill", (it) => {
  it.effect("covers every contract metric with backend-neutral dashboards", () =>
    Effect.gen(function*() {
      const dashboards = yield* reference("dashboards.md");
      for (const metric of [
        ...Object.values(AGENTOS_AI_METRICS),
        ...Object.values(AGENTOS_RESILIENCE_METRICS),
      ]) {
        expect(dashboards).toContain(`\`${metric}\``);
      }
      expect(dashboards).not.toMatch(
        /group(?:ed|ing)? by .*(?:request|trace|span|attempt|session|provider).*id/i,
      );
      expect(dashboards).toContain("protected trace search");
      expect(dashboards).toContain("render digest");
    }),
  );

  it.effect("links resilience alerts to runbooks without metric correlation IDs", () =>
    Effect.gen(function*() {
      const alerts = yield* reference("alerts.md");
      const runbooks = yield* reference("runbooks.md");
      const links = [
        ...alerts.matchAll(/\[Runbook\]\(runbooks\.md#([a-z0-9-]+)\)/g),
      ];
      expect(links.length).toBeGreaterThanOrEqual(11);
      for (const match of links) {
        expect(runbooks).toContain(`id="${match[1]}"`);
      }
      expect(alerts).not.toMatch(
        /group by[^|\n]*(?:request|trace|span|operation|attempt|session|provider).*id/i,
      );
      for (const term of [
        "Collector export",
        "PVC pressure",
        "missing telemetry",
        "429",
        "503",
        "stream",
        "conflicting workload plan",
        "retry exhausted",
        "protocol fallback",
        "unobserved resilience",
      ]) {
        expect(alerts).toContain(term);
      }
    }),
  );

  it.effect("documents every bounded resilience cause and evidence source", () =>
    Effect.gen(function*() {
      const runbooks = yield* reference("runbooks.md");
      for (const cause of [
        "invalid_workload_plan",
        "conflicting_workload_plan",
        "render_boundary",
        "apply_boundary",
        "capacity",
        "placement",
        "readiness",
        "provider",
        "listener",
        "protocol_adapter",
        "native_session",
        "policy",
        "reconciliation",
        "retry_exhausted",
      ]) {
        expect(runbooks).toContain(`\`${cause}\``);
      }
      for (const source of [
        "workload plan",
        "runtime journal",
        "semantic readiness",
        "native session",
        "ACP/A2A",
      ]) {
        expect(runbooks).toContain(source);
      }
      expect(runbooks).toContain("Collector failure cannot");
    }),
  );

  it.effect("defines a paired extension-control matrix instead of inferring from one -ne run", () =>
    Effect.gen(function*() {
      const contents = yield* skill();
      const matrix = yield* reference("control-matrix.md");
      expect(contents).toContain("references/control-matrix.md");
      expect(contents).toContain("Do not declare root cause from an unpaired");
      expect(matrix).toContain("same pod");
      expect(matrix).toContain("same model");
      expect(matrix).toContain("fresh");
      expect(matrix).toContain("resumed");
      expect(matrix).toContain(
        "pi -ne -e /opt/agentos/packages/agentos/extensions/agentos-observability.ts",
      );
    }),
  );
});
