import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  preflightAgentOSComposition,
  registerAgentOSRuntime,
  type AgentOSRegistrationV1,
} from "@agentos/pi";

import { createFakePi } from "../../pi/tests/fake-pi.ts";
import { additiveRegistration } from "./fixtures/additive-package/registration.ts";
import { replacementRegistration } from "./fixtures/replacement-package/registration.ts";

type PiPackageSetting =
  | string
  | {
      source: string;
      autoload?: boolean;
      extensions?: string[];
      skills?: string[];
    };

const defaultPackage = resolve(import.meta.dir, "..");
const additivePackage = resolve(
  import.meta.dir,
  "fixtures",
  "additive-package",
);
const replacementPackage = resolve(
  import.meta.dir,
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

async function commandNames(
  packages: PiPackageSetting[],
): Promise<string[]> {
  const sandbox = await mkdtemp(join(tmpdir(), "agentos-ecosystem-"));
  temporaryDirectories.push(sandbox);
  const project = join(sandbox, "project");
  const agentDirectory = join(sandbox, "agent");
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(
    join(project, ".pi", "settings.json"),
    `${JSON.stringify({ packages }, null, 2)}\n`,
    "utf8",
  );

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
      cwd: project,
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
    throw new Error(`Pi RPC exited ${exitCode}: ${stderr || stdout}`);
  }
  const response = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((message) => message.id === "commands");
  if (!response?.success) {
    throw new Error(`Pi returned no command catalog: ${stderr || stdout}`);
  }
  return response.data.commands.map(
    ({ name }: { name: string }) => name,
  ) as string[];
}

describe("native Pi ecosystem composition", () => {
  test("loads an independent additive package beside the default distribution", async () => {
    const commands = await commandNames([defaultPackage, additivePackage]);

    expect(commands).toContain("background-commands");
    expect(commands).toContain("memory");
    expect(commands).toContain("example-ecosystem-status");
    expect(commands).toContain("skill:agentos-supervision");
    expect(commands).toContain("skill:example-additive");
  });

  test("replaces the executable owner while retaining one selected default Skill", async () => {
    const commands = await commandNames([
      {
        source: defaultPackage,
        autoload: false,
        extensions: [],
        skills: ["skills/agentos-supervision"],
      },
      replacementPackage,
    ]);

    expect(commands).toContain("example-ecosystem-status");
    expect(commands).toContain("skill:example-replacement");
    expect(commands).toContain("skill:agentos-supervision");
    expect(commands).not.toContain("background-commands");
    expect(commands).not.toContain("memory");
    expect(commands).not.toContain("skill:agentos-bootstrap");
  });

  test("rejects standalone-and-composed duplicate ownership before registration", () => {
    const fake = createFakePi();
    const composedAdapter: AgentOSRegistrationV1 = {
      ...additiveRegistration,
      id: "@example/composed:additive-adapter",
    };

    expect(() => {
      const selection = [
        composedAdapter,
        replacementRegistration,
      ] as const;
      preflightAgentOSComposition(selection);
      registerAgentOSRuntime(fake.pi, selection);
    }).toThrow(
      'AgentOS command "example-ecosystem-status" is claimed by both',
    );
    expect(fake.registrations).toEqual([]);
  });
});
