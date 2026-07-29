import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { BoundedTaskOutput } from "../output.ts";
import { spawnTaskProcess } from "../subprocess.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function sink(name: string, maxBytes = 1024 * 1024) {
  const directory = await mkdtemp(join(tmpdir(), "agentos-subprocess-"));
  temporaryDirectories.push(directory);
  return BoundedTaskOutput.open(join(directory, `${name}.log`), {
    tailBytes: 1_024,
    maxBytes,
  });
}

describe("spawnTaskProcess", () => {
  test("runs without a Bun global, as Pi's Node extension runtime does", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-node-extension-"));
    temporaryDirectories.push(directory);
    const build = await Bun.build({
      entrypoints: [new URL("../subprocess.ts", import.meta.url).pathname],
      format: "esm",
      outdir: directory,
      target: "node",
    });
    expect(build.success).toBe(true);
    const moduleUrl = pathToFileURL(build.outputs[0]!.path).href;
    const runner = join(directory, "runner.mjs");
    await writeFile(
      runner,
      `import { spawnTaskProcess } from ${JSON.stringify(moduleUrl)};
let output = "";
const sink = {
  async write(chunk) { output += Buffer.from(chunk).toString("utf8"); },
  async close() {},
};
const handle = spawnTaskProcess("printf node-compatible", { output: sink });
const result = await handle.completion;
console.log(JSON.stringify({ output, result }));
`,
      "utf8",
    );
    const child = Bun.spawn(["node", runner], { stderr: "pipe", stdout: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      output: "node-compatible",
      result: { exitCode: 0, signal: null },
    });
  });

  test("runs a shell command and captures stdout and stderr", async () => {
    const output = await sink("success");
    const handle = spawnTaskProcess(
      "printf stdout; printf stderr >&2",
      { output },
    );

    const result = await handle.completion;

    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(output.tail()).toContain("stdout");
    expect(output.tail()).toContain("stderr");
  });

  test("recognizes readiness output split across stream chunks", async () => {
    const output = await sink("ready");
    const handle = spawnTaskProcess(
      "printf rea >&2; sleep 0.02; printf dy >&2; sleep 0.02",
      { output, readyOutput: "ready" },
    );

    expect(await handle.readiness).toBe(true);
    expect(output.tail()).toContain("ready");
    expect(await handle.completion).toMatchObject({ exitCode: 0, signal: null });
  });

  test("reports when a process exits before its readiness output", async () => {
    const output = await sink("not-ready");
    const handle = spawnTaskProcess("printf booting", {
      output,
      readyOutput: "ready",
    });

    expect(await handle.readiness).toBe(false);
    expect(await handle.completion).toMatchObject({ exitCode: 0, signal: null });
  });

  test("concurrent stops share one bounded TERM-to-KILL completion", async () => {
    const output = await sink("stop");
    const handle = spawnTaskProcess(
      "trap '' TERM; printf running; while :; do sleep 1; done",
      { output, terminateGraceMs: 20 },
    );

    await Bun.sleep(50);
    const [first, second] = await Promise.all([handle.stop(), handle.stop()]);

    expect(first).toEqual(second);
    expect(first.exitCode).toBeNull();
    expect(first.signal).toBe("SIGKILL");
    expect(output.tail()).toContain("running");
  });

  test("kills a command whose output exceeds the file cap", async () => {
    const output = await sink("limit", 5);
    const handle = spawnTaskProcess("printf 123456789", { output });

    expect(await handle.completion).toMatchObject({ outputLimitReached: true });
    expect(output.bytesWritten).toBe(5);
  });
});
