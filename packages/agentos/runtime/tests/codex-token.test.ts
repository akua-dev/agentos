import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { readCodexWorkloadToken } from "../codex-token.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true })
    ),
  );
});

describe("Codex workload credential helper", () => {
  test("reads each rotated token and rejects malformed or unavailable input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentos-codex-token-"));
    directories.push(directory);
    const path = join(directory, "token");
    await writeFile(path, "header.first.signature", { mode: 0o440 });
    expect(await Effect.runPromise(readCodexWorkloadToken(path))).toBe(
      "header.first.signature",
    );

    await chmod(path, 0o640);
    await writeFile(path, "header.rotated.signature");
    expect(await Effect.runPromise(readCodexWorkloadToken(path))).toBe(
      "header.rotated.signature",
    );

    await writeFile(path, " malformed ");
    await expect(Effect.runPromise(readCodexWorkloadToken(path))).rejects.toThrow(
      "projected workload token is invalid",
    );
    await expect(
      Effect.runPromise(readCodexWorkloadToken(join(directory, "missing"))),
    ).rejects.toThrow("projected workload token is unavailable");
  });
});
