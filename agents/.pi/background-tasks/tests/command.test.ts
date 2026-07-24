import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startBackgroundCommand } from "../command.ts";
import type { BackgroundCommandRequest } from "../types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function outputPath() {
  const directory = await mkdtemp(join(tmpdir(), "agentos-command-"));
  temporaryDirectories.push(directory);
  return join(directory, "output.log");
}

describe("startBackgroundCommand", () => {
  test("does not report a start until the requested readiness output appears", async () => {
    const controller = new AbortController();
    const starting = startBackgroundCommand(
      {
        command:
          "printf booting; sleep 0.05; printf listening >&2; sleep 0.02",
        description: "Wait until the listener is registered",
        readyOutput: "listening",
        readyTimeout: 500,
      },
      {
        outputPath: await outputPath(),
        tailBytes: 1_024,
        maxOutputBytes: 1_024 * 1_024,
        terminateGraceMs: 20,
        signal: controller.signal,
      },
    );

    expect(
      await Promise.race([
        starting.then(() => true),
        Bun.sleep(20).then(() => false),
      ]),
    ).toBe(false);

    const handle = await starting;
    expect(await handle.completion).toMatchObject({
      state: "succeeded",
      exitCode: 0,
    });
  });

  test("fails startup and stops the process when readiness times out", async () => {
    const controller = new AbortController();

    await expect(
      startBackgroundCommand(
        {
          command: "sleep 0.1",
          description: "Wait for missing readiness output",
          readyOutput: "listening",
          readyTimeout: 20,
        },
        {
          outputPath: await outputPath(),
          tailBytes: 1_024,
          maxOutputBytes: 1_024 * 1_024,
          terminateGraceMs: 20,
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow(
      'Background command did not produce readiness output "listening" within 20ms',
    );
  });

  test("keeps an unmarked deadline as a failure", async () => {
    const controller = new AbortController();
    const handle = await startBackgroundCommand(
      {
        command: "sleep 10",
        description: "Run a bounded command",
        timeout: 20,
      },
      {
        outputPath: await outputPath(),
        tailBytes: 1_024,
        maxOutputBytes: 1_024 * 1_024,
        terminateGraceMs: 20,
        signal: controller.signal,
      },
    );

    expect(await handle.completion).toMatchObject({
      state: "failed",
      summary: "Background command timed out",
      error: "Command exceeded 20ms",
    });
  });

  test("treats every broker deadline as failure", async () => {
    const controller = new AbortController();
    const handle = await startBackgroundCommand(
      {
        command: "sleep 10",
        description: "Wait for a condition",
        timeout: 20,
        timeoutBehavior: "expire",
      } as BackgroundCommandRequest,
      {
        outputPath: await outputPath(),
        tailBytes: 1_024,
        maxOutputBytes: 1_024 * 1_024,
        terminateGraceMs: 20,
        signal: controller.signal,
      },
    );

    expect(await handle.completion).toMatchObject({
      state: "failed",
      summary: "Background command timed out",
      error: "Command exceeded 20ms",
    });
  });
});
