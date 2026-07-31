import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENTOS_AI_METRICS } from "../src/telemetry/contract.ts";

const root = join(
  import.meta.dir,
  "..",
  "skills",
  "agentos-observability",
);

async function reference(name: string) {
  return await readFile(join(root, "references", name), "utf8");
}

describe("AgentOS observability operator skill", () => {
  test("covers every contract metric with backend-neutral dashboards", async () => {
    const dashboards = await reference("dashboards.md");
    for (const metric of Object.values(AGENTOS_AI_METRICS)) {
      expect(dashboards).toContain(`\`${metric}\``);
    }
    expect(dashboards).not.toMatch(
      /group(?:ed|ing)? by .*(?:request|trace|span|attempt|session|provider).*id/i,
    );
  });

  test("links every alert to a runbook and never groups on correlation IDs", async () => {
    const alerts = await reference("alerts.md");
    const runbooks = await reference("runbooks.md");
    const links = [
      ...alerts.matchAll(/\[Runbook\]\(runbooks\.md#([a-z0-9-]+)\)/g),
    ];
    expect(links.length).toBeGreaterThanOrEqual(6);
    for (const match of links) {
      expect(runbooks).toContain(`id="${match[1]}"`);
    }
    expect(alerts).not.toMatch(
      /group by[^|\n]*(?:request|trace|span|attempt|session|provider).*id/i,
    );
    for (const term of [
      "Collector export",
      "PVC pressure",
      "missing telemetry",
      "429",
      "503",
      "stream",
    ]) {
      expect(alerts).toContain(term);
    }
  });

  test("defines a paired extension-control matrix instead of inferring from one -ne run", async () => {
    const skill = await readFile(join(root, "SKILL.md"), "utf8");
    const matrix = await reference("control-matrix.md");
    expect(skill).toContain("references/control-matrix.md");
    expect(skill).toContain("Do not declare root cause from an unpaired");
    expect(matrix).toContain("same pod");
    expect(matrix).toContain("same model");
    expect(matrix).toContain("fresh");
    expect(matrix).toContain("resumed");
    expect(matrix).toContain(
      "pi -ne -e /opt/agentos/packages/agentos/extensions/agentos-observability.ts",
    );
  });
});
