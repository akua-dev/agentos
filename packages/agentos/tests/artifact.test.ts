import { afterEach, describe, expect, test } from "bun:test";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createFakePi } from "./fake-pi.ts";

const repository = resolve(import.meta.dir, "../../..");
const agentosPackage = join(repository, "packages", "agentos");
const extensionFixture = join(
  agentosPackage,
  "tests",
  "fixtures",
  "external-extension",
);
const replacementFixture = join(
  agentosPackage,
  "tests",
  "fixtures",
  "replacement-package",
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

async function piCommands(
  roleDirectory: string,
  agentDirectory: string,
  role?: "first_mate" | "second_mate",
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
        AGENTOS_AGENT_ROLE: role,
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
    const extensionAuthor = join(installation, "extension-author");
    const replacement = join(installation, "replacement");
    await Promise.all([
      mkdir(artifacts, { recursive: true }),
      mkdir(extensionAuthor, { recursive: true }),
      cp(replacementFixture, replacement, { recursive: true }),
    ]);

    const agentosTarball = await pack(agentosPackage, artifacts);
    await Promise.all([
      copyFile(
        join(extensionFixture, "index.ts"),
        join(extensionAuthor, "index.ts"),
      ),
      copyFile(
        join(extensionFixture, "package.json"),
        join(extensionAuthor, "package.json"),
      ),
      copyFile(
        join(extensionFixture, "tsconfig.json"),
        join(extensionAuthor, "tsconfig.json"),
      ),
      writeFile(
        join(replacement, "package.json"),
        `${JSON.stringify(
          {
            name: "@example/agentos-replacement",
            version: "1.0.0",
            private: true,
            type: "module",
            keywords: ["pi-package"],
            pi: {
              extensions: ["./extensions/replacement.ts"],
              skills: ["./skills"],
            },
            dependencies: {
              "@akua-dev/agentos": `file:${agentosTarball}`,
            },
            peerDependencies: {
              "@earendil-works/pi-ai": "0.81.1",
              "@earendil-works/pi-coding-agent": "0.81.1",
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      ),
    ]);
    await writeFile(
      join(installation, "package.json"),
      `${JSON.stringify(
        {
          name: "agentos-artifact-fixture",
          private: true,
          workspaces: ["extension-author", "replacement"],
          dependencies: {
            "@akua-dev/agentos": `file:${agentosTarball}`,
            "@earendil-works/pi-ai": "0.81.1",
            "@earendil-works/pi-coding-agent": "0.81.1",
          },
          overrides: {
            "@akua-dev/agentos": `file:${agentosTarball}`,
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
    if (install.exitCode !== 0) {
      throw new Error(`Artifact installation failed: ${install.stderr}`);
    }
    expect(install.exitCode).toBe(0);
    expect(install.stderr).not.toContain("error:");

    const compile = await run(
      [
        join(installation, "node_modules", ".bin", "tsc"),
        "--project",
        join(extensionAuthor, "tsconfig.json"),
      ],
      { cwd: installation },
    );
    expect(compile).toEqual({ exitCode: 0, stderr: "", stdout: "" });

    const installedAgentOS = join(
      installation,
      "node_modules",
      "@akua-dev",
      "agentos",
    );
    const manifest = JSON.parse(
      await readFile(join(installedAgentOS, "package.json"), "utf8"),
    );
    expect(manifest.name).toBe("@akua-dev/agentos");
    expect(manifest.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    });
    expect(manifest.pi).toEqual({
      extensions: ["./extensions/agentos.ts"],
      skills: ["./skills"],
    });
    expect(manifest.dependencies).toEqual({
      "@opentelemetry/api": "1.9.1",
      "@opentelemetry/exporter-metrics-otlp-http": "0.221.0",
      "@opentelemetry/exporter-trace-otlp-http": "0.221.0",
      "@opentelemetry/sdk-metrics": "2.10.0",
      "@opentelemetry/sdk-node": "0.221.0",
      yaml: "2.9.0",
      zod: "4.4.3",
    });
    await Promise.all(
      [
        join(installedAgentOS, "dist", "index.js"),
        join(installedAgentOS, "dist", "index.d.ts"),
        join(installedAgentOS, "dist", "roles", "firstmate.js"),
        join(installedAgentOS, "dist", "roles", "secondmate.js"),
        join(installedAgentOS, "extensions", "agentos.ts"),
        join(
          installedAgentOS,
          "extensions",
          "agentos-observability.ts",
        ),
        join(installedAgentOS, "runtime", "create-image-seed.ts"),
        join(installedAgentOS, "skills", "agentos-customization", "SKILL.md"),
        join(
          installedAgentOS,
          "skills",
          "agentos-observability",
          "SKILL.md",
        ),
        join(
          installedAgentOS,
          "skills",
          "agentos-observability",
          "agents",
          "openai.yaml",
        ),
        join(
          installedAgentOS,
          "skills",
          "agentos-observability",
          "references",
          "control-matrix.md",
        ),
        join(
          installedAgentOS,
          "skills",
          "agentos-observability",
          "references",
          "dashboards.md",
        ),
        join(
          installedAgentOS,
          "skills",
          "agentos-observability",
          "references",
          "alerts.md",
        ),
        join(
          installedAgentOS,
          "skills",
          "agentos-observability",
          "references",
          "runbooks.md",
        ),
        join(installedAgentOS, "skills", "agentos-upgrade", "SKILL.md"),
        join(
          installedAgentOS,
          "skills",
          "agentos-upgrade",
          "agents",
          "openai.yaml",
        ),
        join(
          installedAgentOS,
          "skills",
          "agentos-upgrade",
          "references",
          "database.md",
        ),
        join(
          installedAgentOS,
          "skills",
          "agentos-upgrade",
          "references",
          "one-mate.md",
        ),
        join(
          installedAgentOS,
          "skills",
          "agentos-upgrade",
          "references",
          "fleet.md",
        ),
        join(
          installedAgentOS,
          "resources",
          "roles",
          "firstmate",
          "instructions.md",
        ),
        join(
          installedAgentOS,
          "resources",
          "roles",
          "firstmate",
          "mise.toml",
        ),
        join(
          installedAgentOS,
          "resources",
          "roles",
          "firstmate",
          "kubernetes",
          "base",
          "kustomization.yaml",
        ),
        join(
          installedAgentOS,
          "resources",
          "crewmates",
          "default",
          "BRIEF.md",
        ),
        join(
          installedAgentOS,
          "resources",
          "crewmates",
          "default",
          "images",
          "artifact-fs",
          "Dockerfile",
        ),
      ].map((path) => access(path)),
    );
    await expect(access(join(installedAgentOS, "prompts"))).rejects.toThrow();
    await expect(
      access(join(installedAgentOS, "dist", "runtime.js")),
    ).rejects.toThrow();
    await expect(
      access(join(installedAgentOS, "dist", "roles", "shared.js")),
    ).rejects.toThrow();
    await expect(
      access(
        join(
          installedAgentOS,
          "resources",
          "roles",
          "firstmate",
          "kubernetes",
          "tests",
        ),
      ),
    ).rejects.toThrow();

    const nativeResourceRoots = [
      join(installedAgentOS, "resources", "roles", "firstmate"),
      join(installedAgentOS, "resources", "roles", "secondmate"),
      join(installedAgentOS, "resources", "crewmates", "default"),
    ];
    for (const resourceRoot of nativeResourceRoots) {
      const mise = Bun.TOML.parse(
        await readFile(join(resourceRoot, "mise.toml"), "utf8"),
      ) as { tasks: Record<string, { file: string }> };
      await Promise.all(
        Object.values(mise.tasks).map(({ file }) =>
          access(resolve(resourceRoot, file)),
        ),
      );
    }

    const nativeKubernetesRoots = [
      join(
        installedAgentOS,
        "resources",
        "roles",
        "firstmate",
        "kubernetes",
        "base",
      ),
      join(
        installedAgentOS,
        "resources",
        "roles",
        "secondmate",
        "kubernetes",
        "base",
      ),
      join(
        installedAgentOS,
        "resources",
        "crewmates",
        "default",
        "kubernetes",
        "base",
      ),
    ];
    for (const kubernetesRoot of nativeKubernetesRoots) {
      const rendered = await run(
        ["kubectl", "kustomize", kubernetesRoot],
        { cwd: installation },
      );
      expect(rendered).toEqual({
        exitCode: 0,
        stderr: "",
        stdout: expect.any(String),
      });
    }

    const priorRole = process.env.AGENTOS_AGENT_ROLE;
    process.env.AGENTOS_AGENT_ROLE = "first_mate";
    try {
      const installedEntrypoint = await import(
        `${pathToFileURL(
          join(installedAgentOS, "extensions", "agentos.ts"),
        ).href}?artifact=${Date.now()}`
      );
      const fake = createFakePi({
        systemPrompt:
          "<available_skills><skill><name>agentos-supervision</name></skill></available_skills>",
      });
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

    const commands = await piCommands(
      join(
        installedAgentOS,
        "resources",
        "roles",
        "firstmate",
      ),
      join(sandbox, "pi-agent"),
      "first_mate",
    );
    expect(commands).toContain("background-commands");
    expect(commands).toContain("memory");
    expect(commands).toContain("skill:agentos-supervision");
    expect(commands).toContain("skill:agentos-observability");
    expect(commands).toContain("skill:agentos-bootstrap");
    expect(commands).toContain("skill:agentos-upgrade");
    const secondMateCommands = await piCommands(
      join(
        installedAgentOS,
        "resources",
        "roles",
        "secondmate",
      ),
      join(sandbox, "second-mate-pi-agent"),
      "second_mate",
    );
    expect(secondMateCommands).toContain("background-commands");
    expect(secondMateCommands).toContain("memory");
    expect(secondMateCommands).toContain("skill:agentos-supervision");
    expect(secondMateCommands).toContain("skill:agentos-observability");
    expect(secondMateCommands).toContain("skill:agentos-upgrade");
    expect(secondMateCommands).not.toContain("skill:agentos-bootstrap");
    const replacementProject = join(sandbox, "replacement-project");
    await mkdir(join(replacementProject, ".pi"), { recursive: true });
    await writeFile(
      join(replacementProject, ".pi", "settings.json"),
      `${JSON.stringify({ packages: [replacement] }, null, 2)}\n`,
      "utf8",
    );
    const replacementCommands = await piCommands(
      replacementProject,
      join(sandbox, "replacement-pi-agent"),
    );
    expect(replacementCommands).toContain("example-ecosystem-status");
    expect(replacementCommands).toContain("skill:example-replacement");
    expect(replacementCommands).not.toContain("background-commands");
    expect(replacementCommands).not.toContain("memory");
    expect(replacementCommands).not.toContain("skill:agentos-supervision");

    await rm(
      join(
        installedAgentOS,
        "resources",
        "roles",
        "firstmate",
        "skills",
      ),
      { recursive: true, force: true },
    );
    const incompleteEntrypoint = await import(
      `${pathToFileURL(
        join(installedAgentOS, "extensions", "agentos.ts"),
      ).href}?incomplete=${Date.now()}`
    );
    const priorIncompleteRole = process.env.AGENTOS_AGENT_ROLE;
    process.env.AGENTOS_AGENT_ROLE = "first_mate";
    try {
      await expect(
        incompleteEntrypoint.default(createFakePi().pi),
      ).rejects.toThrow("Required First-Mate Skill directory is unavailable");
    } finally {
      if (priorIncompleteRole === undefined) {
        delete process.env.AGENTOS_AGENT_ROLE;
      } else {
        process.env.AGENTOS_AGENT_ROLE = priorIncompleteRole;
      }
    }
  }, 30_000);
});
