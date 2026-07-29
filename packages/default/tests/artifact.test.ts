import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi } from "../../pi/tests/fake-pi.ts";

const repository = resolve(import.meta.dir, "../../..");
const piPackage = join(repository, "packages", "pi");
const defaultPackage = join(repository, "packages", "default");
const composerFixture = join(
  piPackage,
  "tests",
  "fixtures",
  "external-composer",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function run(
  command: string[],
  options: { cwd: string; env?: Record<string, string | undefined> },
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

async function pack(packageDirectory: string, destination: string) {
  const result = await run(
    ["bun", "pm", "pack", "--destination", destination, "--quiet"],
    { cwd: packageDirectory },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Could not pack ${packageDirectory}: ${result.stderr}`);
  }
  return result.stdout.trim().split("\n").at(-1)!;
}

async function installedPiCommands(
  roleDirectory: string,
  agentDirectory: string,
): Promise<string[]> {
  const child = Bun.spawn(
    [
      "pi",
      "--mode",
      "rpc",
      "--no-session",
      "--offline",
      "--no-context-files",
      "--approve",
    ],
    {
      cwd: roleDirectory,
      env: {
        ...process.env,
        AGENTOS_AGENT_ROLE: "first_mate",
        PI_CODING_AGENT_DIR: agentDirectory,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  child.stdin.write(
    `${JSON.stringify({ id: "commands", type: "get_commands" })}\n`,
  );
  child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Installed Pi package exited ${exitCode}: ${stderr || stdout}`);
  }
  const response = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((message) => message.id === "commands");
  if (!response?.success) {
    throw new Error(`Installed Pi package returned no commands: ${stderr || stdout}`);
  }
  return response.data.commands.map(
    ({ name }: { name: string }) => name,
  ) as string[];
}

describe("publishable AgentOS Pi artifacts", () => {
  test("pack, install, typecheck, and load without the source worktree", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agentos-artifacts-"));
    temporaryDirectories.push(sandbox);
    const artifacts = join(sandbox, "artifacts");
    const installation = join(sandbox, "installation");
    const composer = join(installation, "composer");
    await Promise.all([
      mkdir(artifacts, { recursive: true }),
      mkdir(composer, { recursive: true }),
    ]);

    const piTarball = await pack(piPackage, artifacts);
    const defaultTarball = await pack(defaultPackage, artifacts);
    await Promise.all([
      copyFile(
        join(composerFixture, "index.ts"),
        join(composer, "index.ts"),
      ),
      copyFile(
        join(composerFixture, "package.json"),
        join(composer, "package.json"),
      ),
      copyFile(
        join(composerFixture, "tsconfig.json"),
        join(composer, "tsconfig.json"),
      ),
    ]);
    await writeFile(
      join(installation, "package.json"),
      `${JSON.stringify(
        {
          name: "agentos-artifact-fixture",
          private: true,
          workspaces: ["composer"],
          dependencies: {
            "@agentos/default": `file:${defaultTarball}`,
            "@agentos/pi": `file:${piTarball}`,
            "@earendil-works/pi-ai": "0.81.1",
            "@earendil-works/pi-coding-agent": "0.81.1",
          },
          overrides: {
            "@agentos/pi": `file:${piTarball}`,
          },
          devDependencies: {
            "@types/bun": "1.3.14",
            typescript: "7.0.2",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const install = await run(
      ["bun", "install", "--ignore-scripts", "--no-progress"],
      { cwd: installation },
    );
    expect(install.exitCode).toBe(0);
    expect(install.stderr).not.toContain("error:");

    const compile = await run(
      [
        join(installation, "node_modules", ".bin", "tsc"),
        "--project",
        join(composer, "tsconfig.json"),
      ],
      { cwd: installation },
    );
    expect(compile).toEqual({ exitCode: 0, stderr: "", stdout: "" });

    const installedPi = join(
      installation,
      "node_modules",
      "@agentos",
      "pi",
    );
    const installedDefault = join(
      installation,
      "node_modules",
      "@agentos",
      "default",
    );
    const piManifest = JSON.parse(
      await readFile(join(installedPi, "package.json"), "utf8"),
    );
    const defaultManifest = JSON.parse(
      await readFile(join(installedDefault, "package.json"), "utf8"),
    );
    expect(piManifest.keywords).toBeUndefined();
    expect(piManifest.pi).toBeUndefined();
    expect(defaultManifest.pi).toEqual({
      extensions: ["./extensions/agentos.ts"],
      skills: ["./skills"],
    });
    expect(defaultManifest.dependencies).toEqual({ "@agentos/pi": "0.1.0" });
    await Promise.all(
      [
        join(installedPi, "dist", "index.js"),
        join(installedPi, "dist", "index.d.ts"),
        join(installedDefault, "extensions", "agentos.ts"),
        join(installedDefault, "composition", "firstmate.ts"),
        join(installedDefault, "composition", "secondmate.ts"),
        join(installedDefault, "skills", "agentos-customization", "SKILL.md"),
        join(
          installedDefault,
          "resources",
          "roles",
          "firstmate",
          "instructions.md",
        ),
        join(
          installedDefault,
          "resources",
          "roles",
          "firstmate",
          "mise.toml",
        ),
        join(
          installedDefault,
          "resources",
          "roles",
          "firstmate",
          "kubernetes",
          "base",
          "kustomization.yaml",
        ),
        join(
          installedDefault,
          "resources",
          "crewmates",
          "default",
          "BRIEF.md",
        ),
        join(
          installedDefault,
          "resources",
          "crewmates",
          "default",
          "images",
          "artifact-fs",
          "Dockerfile",
        ),
      ].map((path) => access(path)),
    );
    await expect(access(join(installedDefault, "prompts"))).rejects.toThrow();
    await expect(
      access(
        join(
          installedDefault,
          "resources",
          "roles",
          "firstmate",
          "kubernetes",
          "tests",
        ),
      ),
    ).rejects.toThrow();

    const priorRole = process.env.AGENTOS_AGENT_ROLE;
    process.env.AGENTOS_AGENT_ROLE = "first_mate";
    try {
      const installedEntrypoint = await import(
        `${pathToFileURL(
          join(installedDefault, "extensions", "agentos.ts"),
        ).href}?artifact=${Date.now()}`
      );
      const fake = createFakePi();
      await installedEntrypoint.default(fake.pi);
      const [instructions] = await fake.emit("before_agent_start", {
        type: "before_agent_start",
        prompt: "hello",
        systemPrompt: "Pi base.",
        systemPromptOptions: { cwd: "/workspace" },
      });
      const startupHandler = fake.handlers.get("session_start")?.at(-1);
      expect(startupHandler).toBeFunction();
      await startupHandler!({
        type: "session_start",
        reason: "startup",
      }, fake.context);
      expect(
        (instructions as { systemPrompt: string }).systemPrompt,
      ).toContain("You are First Mate.");
      expect(fake.messages).toHaveLength(1);
      expect(fake.messages[0]?.message.content).toContain(
        "Load $agentos-supervision",
      );
    } finally {
      if (priorRole === undefined) delete process.env.AGENTOS_AGENT_ROLE;
      else process.env.AGENTOS_AGENT_ROLE = priorRole;
    }

    const commands = await installedPiCommands(
      join(
        installedDefault,
        "resources",
        "roles",
        "firstmate",
      ),
      join(sandbox, "pi-agent"),
    );
    expect(commands).toContain("background-commands");
    expect(commands).toContain("memory");
    expect(commands).toContain("skill:agentos-supervision");
    expect(commands).toContain("skill:agentos-bootstrap");
    expect(commands).not.toContain("agentos-default-first-mate-startup");
  }, 30_000);
});
