import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../../../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function run(
  command: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function copyProductionInstallInputs(destination: string) {
  const rootPackage = JSON.parse(
    await readFile(join(repository, "package.json"), "utf8"),
  );
  const files = [
    "package.json",
    "bun.lock",
    "clis/github-app-token/package.json",
    "clis/github-app-token/github-app-token.ts",
    "clis/pg-listen/package.json",
    "clis/pg-listen/pg-listen.ts",
    "database/package.json",
    "packages/agentos/package.json",
    "services/ai-gateway/package.json",
    "services/otel-collector/package.json",
    ...(rootPackage.workspaces.includes("website/apps/docs")
      ? ["website/apps/docs/package.json"]
      : []),
  ];
  await Promise.all(
    files.map(async (file) => {
      const output = join(destination, file);
      await mkdir(dirname(output), { recursive: true });
      await copyFile(join(repository, file), output);
    }),
  );
}

async function declaredWorkspaceManifests() {
  const rootPackage = JSON.parse(
    await readFile(join(repository, "package.json"), "utf8"),
  ) as { workspaces: string[] };
  const manifests = new Set<string>();
  for (const workspace of rootPackage.workspaces) {
    const glob = new Bun.Glob(`${workspace}/package.json`);
    for await (const manifest of glob.scan({
      cwd: repository,
      onlyFiles: true,
    })) {
      manifests.add(manifest);
    }
  }
  return [...manifests].sort();
}

test("the Docker install stages include every Bun workspace manifest", async () => {
  const dockerfile = await readFile(join(repository, "Dockerfile"), "utf8");
  const manifests = await declaredWorkspaceManifests();

  for (const stage of [
    "agentos-runtime-dependencies",
    "agentos-package-build",
  ]) {
    const start = dockerfile.indexOf(` AS ${stage}\n`);
    expect(start, `Dockerfile stage ${stage} must exist`).toBeGreaterThanOrEqual(
      0,
    );
    const nextStage = dockerfile.indexOf("\nFROM ", start + 1);
    const contents = dockerfile.slice(
      start,
      nextStage === -1 ? undefined : nextStage,
    );
    const missing = manifests.filter(
      (manifest) => !contents.includes(`COPY ${manifest} ${manifest}`),
    );
    expect(missing, `${stage} is missing workspace manifests`).toEqual([]);
  }
});

test("the production image can prepare a persistent Mate home", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "agentos-production-runtime-"));
  temporaryDirectories.push(sandbox);
  const installation = join(sandbox, "installation");
  const imageRoot = join(sandbox, "image", "opt", "agentos");
  const home = join(sandbox, "home");
  const fakeBin = join(sandbox, "bin");
  await Promise.all([
    mkdir(installation, { recursive: true }),
    mkdir(join(imageRoot, "packages", "agentos"), { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
  ]);
  await copyProductionInstallInputs(installation);

  const install = await run(
    [
      process.execPath,
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--no-progress",
      "--production",
      "--filter",
      "@agentos/root",
      "--filter",
      "@akua-dev/agentos",
      "--filter",
      "@agentos/github-app-token",
      "--filter",
      "@agentos/pg-listen",
      "--filter",
      "@agentos/ai-gateway",
    ],
    { cwd: installation },
  );
  expect(install.exitCode, install.stderr).toBe(0);

  await Promise.all([
    rename(join(installation, "node_modules"), join(imageRoot, "node_modules")),
    rename(
      join(installation, "packages", "agentos", "node_modules"),
      join(imageRoot, "packages", "agentos", "node_modules"),
    ),
    copyFile(
      join(installation, "packages", "agentos", "package.json"),
      join(imageRoot, "packages", "agentos", "package.json"),
    ),
    cp(
      join(repository, "packages", "agentos", "dist"),
      join(imageRoot, "packages", "agentos", "dist"),
      { recursive: true },
    ),
    cp(
      join(repository, "packages", "agentos", "runtime"),
      join(imageRoot, "packages", "agentos", "runtime"),
      { recursive: true },
    ),
  ]);
  await Promise.all(
    ["mise", "herdr"].map(async (command) => {
      const path = join(fakeBin, command);
      await writeFile(path, "#!/usr/bin/env bun\n", "utf8");
      await chmod(path, 0o755);
    }),
  );

  const checkout = join(home, "projects", "agentos");
  const distributionRoot = join(checkout, "packages", "agentos");
  const roleDirectory = join(
    distributionRoot,
    "resources",
    "roles",
    "firstmate",
  );
  const env = { ...process.env };
  delete env.NODE_PATH;
  delete env.AGENTOS_PGPASS_SOURCE;
  delete env.PI_CODING_AGENT_DIR;
  Object.assign(env, {
    AGENTOS_AGENT_CWD: roleDirectory,
    AGENTOS_AGENT_ROLE: "first_mate",
    AGENTOS_DISTRIBUTION_ROOT: distributionRoot,
    AGENTOS_RELEASE_ROOT: repository,
    HOME: home,
    MISE_SYSTEM_CONFIG_FILE: join(repository, "mise.toml"),
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  });

  const prepared = await run(
    [
      process.execPath,
      join(imageRoot, "packages", "agentos", "runtime", "prepare-home.ts"),
    ],
    { cwd: imageRoot, env },
  );

  expect(prepared).toEqual({ exitCode: 0, stderr: "", stdout: "" });
  expect(await readFile(join(home, "memory", "MEMORY.md"), "utf8")).toBe(
    "# Memory index\n",
  );
}, 30_000);
