import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BoundedTaskOutput,
  TaskOutputLimitError,
} from "../output.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function output(options?: { tailBytes?: number; maxBytes?: number }) {
  const directory = await mkdtemp(join(tmpdir(), "agentos-background-output-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "task.log");
  return {
    path,
    sink: await BoundedTaskOutput.open(path, options),
  };
}

describe("BoundedTaskOutput", () => {
  test("persists complete output while retaining only a bounded byte tail", async () => {
    const { path, sink } = await output({ tailBytes: 5, maxBytes: 100 });

    await sink.write(Buffer.from("abc"));
    await sink.write(Buffer.from("defgh"));
    await sink.close();

    expect(await readFile(path, "utf8")).toBe("abcdefgh");
    expect(sink.tail()).toBe("defgh");
    expect(sink.bytesWritten).toBe(8);
    expect(sink.truncated).toBe(true);
  });

  test("stops at the hard file cap without writing the overflowing bytes", async () => {
    const { path, sink } = await output({ tailBytes: 20, maxBytes: 5 });

    await sink.write(Buffer.from("abc"));
    await expect(sink.write(Buffer.from("def"))).rejects.toBeInstanceOf(
      TaskOutputLimitError,
    );
    await sink.close();

    expect(await readFile(path, "utf8")).toBe("abcde");
    expect(sink.bytesWritten).toBe(5);
    expect(sink.limitReached).toBe(true);
  });
});
