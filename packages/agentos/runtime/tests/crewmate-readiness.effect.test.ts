import * as BunServices from "@effect/platform-bun/BunServices";
import { CrewmateReadinessState } from "@akua-dev/agentos";
import { assert, describe, layer } from "@effect/vitest";
import {
  Crypto,
  Effect,
  Encoding,
  FileSystem,
  Path,
  Schema,
} from "effect";

import {
  confirmCrewmateReadiness,
  type CrewmateConfirmationRuntime,
} from "../crewmate-readiness";

const cwd = "/home/agent/worktrees/delivery";
const session = "agentos-crewmate";
const pane = "w1:p1";
const briefPath = "/home/agent/brief.md";
const brief = "Deliver the assigned change and preserve evidence.\n";

function environment(digest: string) {
  return {
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
  };
}

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

const briefDigest = Effect.gen(function*() {
  const crypto = yield* Crypto.Crypto;
  return Encoding.encodeHex(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(brief)),
  );
});

describe("Effect crewmate launch readiness confirmation", () => {
  layer(BunServices.layer)((it) => {
    it.effect(
      "writes one private confirmation bound to identity, brief, harness, session, and process",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const digest = yield* briefDigest;
          const input = environment(digest);
          const stateDirectory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "agentos-crewmate-confirmation-",
          });
          const state = yield* confirmCrewmateReadiness(
            input,
            runtime(),
            stateDirectory,
          );

          assert.deepStrictEqual(state, {
            agentId: input.AGENTOS_AGENT_ID,
            assignmentId: input.AGENTOS_ASSIGNMENT_ID,
            briefSha256: digest,
            harness: "codex",
            herdrSession: session,
            processId: 4242,
            taskId: input.AGENTOS_TASK_ID,
            version: 1,
          });
          const persisted = yield* fileSystem.readFileString(
            paths.join(stateDirectory, "readiness", "crewmate.json"),
          );
          assert.deepStrictEqual(
            yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(CrewmateReadinessState),
            )(persisted),
            state,
          );
        })),
    );

    it.effect(
      "fails closed on a stale brief or wrong live harness without writing state",
      () =>
        Effect.scoped(Effect.gen(function*() {
          const fileSystem = yield* FileSystem.FileSystem;
          const paths = yield* Path.Path;
          const input = environment(yield* briefDigest);
          const staleRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "agentos-crewmate-confirmation-",
          });
          const staleError = yield* confirmCrewmateReadiness(
            input,
            runtime({ brief: `${brief}stale\n` }),
            staleRoot,
          ).pipe(Effect.flip);
          assert.strictEqual(staleError.message, "brief_digest_mismatch");

          const harnessRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "agentos-crewmate-confirmation-",
          });
          const harnessError = yield* confirmCrewmateReadiness(
            input,
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
          ).pipe(Effect.flip);
          assert.strictEqual(harnessError.message, "harness_mismatch");
          assert.isFalse(
            yield* fileSystem.exists(
              paths.join(harnessRoot, "readiness", "crewmate.json"),
            ),
          );
        })),
    );
  });
});
