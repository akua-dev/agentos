import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  test("runs a shell command through Bun and captures stdout and stderr", async () => {
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
