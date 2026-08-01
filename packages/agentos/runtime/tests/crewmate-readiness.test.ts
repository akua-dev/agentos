import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import {
  confirmCrewmateReadiness,
  type CrewmateConfirmationRuntime,
} from "../crewmate-readiness";

const cwd = "/home/agent/worktrees/delivery";
const session = "agentos-crewmate";
const pane = "w1:p1";
const briefPath = "/home/agent/brief.md";
const brief = "Deliver the assigned change and preserve evidence.\n";
const digest = new Bun.CryptoHasher("sha256").update(brief).digest("hex");

const environment = {
  AGENTOS_AGENT_CWD: cwd,
  AGENTOS_AGENT_ID: "00000000-0000-4000-8000-000000000003",
  AGENTOS_AGENT_NAME: "crewmate",
  AGENTOS_AGENT_ROLE: "crewmate",
  AGENTOS_ASSIGNMENT_ID: "00000000-0000-4000-8000-000000000005",
  AGENTOS_BRIEF_PATH: briefPath,
  AGENTOS_BRIEF_SHA256: digest,
  AGENTOS_HARNESS: "codex",
  AGENTOS_TASK_ID: "00000000-0000-4000-8000-000000000004",
  HERDR_SESSION: session,
} as const;

function key(args: ReadonlyArray<string>) {
  return JSON.stringify(args);
}

function runtime(overrides: {
  brief?: string;
  commands?: Readonly<Record<string, { exitCode: number; stdout: string }>>;
} = {}): CrewmateConfirmationRuntime {
  const commands = {
    [key(["herdr", "agent", "list", "--session", session])]: {
      exitCode: 0,
      stdout: `${JSON.stringify({
        result: {
          agents: [
            {
              agent_session: { kind: "id", value: "codex-session" },
              cwd,
              foreground_cwd: cwd,
              name: "crewmate",
              pane_id: pane,
            },
          ],
        },
      })}\n`,
    },
    [key([
      "herdr",
      "agent",
      "explain",
      "crewmate",
      "--json",
      "--session",
      session,
    ])]: {
      exitCode: 0,
      stdout: '{"agent":"codex","state":"working"}\n',
    },
    [key([
      "herdr",
      "pane",
      "process-info",
      "--pane",
      pane,
      "--session",
      session,
    ])]: {
      exitCode: 0,
      stdout: `${JSON.stringify({
        result: {
          process_info: {
            foreground_process_group_id: 4242,
            foreground_processes: [{ argv0: "codex", cwd, pid: 4242 }],
            pane_id: pane,
          },
        },
      })}\n`,
    },
    ...overrides.commands,
  };
  return {
    readText: (path, maximumBytes) =>
      Effect.succeed(
        path === briefPath
          ? (overrides.brief ?? brief).slice(0, maximumBytes)
          : undefined,
      ),
    run: (args) =>
      Effect.succeed(commands[key(args)] ?? { exitCode: 1, stdout: "" }),
  };
}

describe("Crewmate launch readiness confirmation", () => {
  test("writes one private confirmation bound to identity, brief, harness, session, and process", async () => {
    const stateDirectory = await mkdtemp(
      join(tmpdir(), "agentos-crewmate-confirmation-"),
    );
    const state = await Effect.runPromise(
      confirmCrewmateReadiness(environment, runtime(), stateDirectory),
    );

    expect(state).toEqual({
      agentId: environment.AGENTOS_AGENT_ID,
      assignmentId: environment.AGENTOS_ASSIGNMENT_ID,
      briefSha256: digest,
      harness: "codex",
      herdrSession: session,
      processId: 4242,
      taskId: environment.AGENTOS_TASK_ID,
      version: 1,
    });
    expect(
      JSON.parse(
        await readFile(
          join(stateDirectory, "readiness", "crewmate.json"),
          "utf8",
        ),
      ),
    ).toEqual(state);
  });

  test("fails closed on a stale brief or wrong live harness without writing state", async () => {
    const staleRoot = await mkdtemp(
      join(tmpdir(), "agentos-crewmate-confirmation-"),
    );
    await expect(
      Effect.runPromise(
        confirmCrewmateReadiness(
          environment,
          runtime({ brief: `${brief}stale\n` }),
          staleRoot,
        ),
      ),
    ).rejects.toThrow("brief_digest_mismatch");

    const harnessRoot = await mkdtemp(
      join(tmpdir(), "agentos-crewmate-confirmation-"),
    );
    await expect(
      Effect.runPromise(
        confirmCrewmateReadiness(
          environment,
          runtime({
            commands: {
              [key([
                "herdr",
                "agent",
                "explain",
                "crewmate",
                "--json",
                "--session",
                session,
              ])]: {
                exitCode: 0,
                stdout: '{"agent":"pi","state":"working"}\n',
              },
            },
          }),
          harnessRoot,
        ),
      ),
    ).rejects.toThrow("harness_mismatch");
    expect(
      await Bun.file(
        join(harnessRoot, "readiness", "crewmate.json"),
      ).exists(),
    ).toBe(false);
  });
});
