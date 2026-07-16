import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repository = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const createImageSeed = join(repository, "runtime", "create-image-seed.ts");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("AgentOS image Git seed", () => {
  test("creates a credential-free shallow clone at the exact source commit", async () => {
    const { root, source } = await makeRepository();
    const output = join(root, "seed");

    const result = await runSeed(source, output, [
      "--origin",
      "https://github.com/acme/agentos.git",
      "--upstream",
      "https://github.com/akua-dev/agentos.git",
    ]);

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "" });
    expect((await $`git -C ${output} rev-parse HEAD`.text()).trim()).toBe(
      (await $`git -C ${source} rev-parse HEAD`.text()).trim(),
    );
    expect((await $`git -C ${output} rev-list --count HEAD`.text()).trim()).toBe(
      "1",
    );
    expect(await readFile(join(output, ".git", "shallow"), "utf8")).not.toBe("");
    expect(
      (await $`git -C ${output} config --get remote.origin.url`.text()).trim(),
    ).toBe(
      "https://github.com/acme/agentos.git",
    );
    expect(
      (await $`git -C ${output} config --get remote.upstream.url`.text()).trim(),
    ).toBe(
      "https://github.com/akua-dev/agentos.git",
    );
  });

  test("rejects source changes that are not in the selected commit", async () => {
    const { root, source } = await makeRepository();
    await writeFile(join(source, "unfinished.txt"), "not committed\n", "utf8");

    const result = await runSeed(source, join(root, "seed"), [
      "--origin",
      "https://github.com/akua-dev/agentos.git",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be clean");
  });

  test("rejects credentials embedded in a configured remote", async () => {
    const { root, source } = await makeRepository();

    const result = await runSeed(source, join(root, "seed"), [
      "--origin",
      "https://agent:secret@github.com/acme/agentos.git",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("credential-free");
  });
});

async function makeRepository() {
  const root = await mkdtemp(join(tmpdir(), "agentos-image-seed-"));
  temporaryDirectories.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await $`git -C ${source} init --quiet`;
  await $`git -C ${source} config user.name AgentOS`;
  await $`git -C ${source} config user.email agentos@example.invalid`;
  await writeFile(join(source, "old.txt"), "old history\n", "utf8");
  await $`git -C ${source} add old.txt`;
  await $`git -C ${source} commit --quiet --message old`;
  await rm(join(source, "old.txt"));
  await writeFile(join(source, "current.txt"), "current tree\n", "utf8");
  await $`git -C ${source} add --all`;
  await $`git -C ${source} commit --quiet --message current`;
  return { root, source };
}

async function runSeed(source: string, output: string, remoteArguments: string[]) {
  const child = Bun.spawn(
    [process.execPath, createImageSeed, "--source", source, "--output", output, ...remoteArguments],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}
