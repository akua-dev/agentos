import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  attestPiProviderReadiness,
  invalidateCoordinationReadiness,
  writeCoordinationReadiness,
  writeCrewmateReadiness,
} from "../../src/readiness-state";

async function temporaryRoot() {
  return mkdtemp(join(tmpdir(), "agentos-readiness-state-"));
}

describe("semantic readiness attestations", () => {
  test("attests only hashes and selected non-secret Pi configuration", async () => {
    const root = await temporaryRoot();
    const piAgentDirectory = join(root, "pi");
    const stateDirectory = join(root, "state");
    await Bun.write(
      join(piAgentDirectory, "settings.json"),
      '{"defaultProvider":"openai-codex","defaultModel":"gpt-5.6-sol"}\n',
    );
    await Bun.write(
      join(piAgentDirectory, "models.json"),
      '{"providers":{}}\n',
    );

    await Effect.runPromise(
      attestPiProviderReadiness({
        environment: {
          AGENTOS_MODEL: "openai-codex/gpt-5.6-sol",
          AGENTOS_PI_PROVIDER_MODE: "direct",
        },
        piAgentDirectory,
        stateDirectory,
      }),
    );

    const path = join(stateDirectory, "pi-provider-readiness.json");
    const source = await readFile(path, "utf8");
    const parsed = JSON.parse(source) as {
      files: Record<string, string | null>;
      mode: string;
      selectedModel: string | null;
      selectedThinking: string | null;
      version: number;
    };
    expect(parsed).toMatchObject({
      mode: "direct",
      selectedModel: "openai-codex/gpt-5.6-sol",
      selectedThinking: null,
      version: 1,
    });
    expect(parsed.files.settingsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.files.modelsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.files.markerSha256).toBeNull();
    expect(source).not.toContain("token");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("tracks listener registration, catch-up, and terminal invalidation", async () => {
    const root = await temporaryRoot();
    const options = {
      agentName: "firstmate",
      herdrSession: "agentos-firstmate",
      listenerProcessId: 9001,
      listenerTaskId: "bg-listener",
      ownerProcessId: 4242,
      stateDirectory: root,
    } as const;

    await Effect.runPromise(
      writeCoordinationReadiness({ ...options, phase: "listening" }),
    );
    const path = join(root, "readiness", "coordination.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      listenerTaskId: "bg-listener",
      listenerProcessId: 9001,
      ownerProcessId: 4242,
      phase: "listening",
      version: 1,
    });

    await Effect.runPromise(
      writeCoordinationReadiness({ ...options, phase: "caught_up" }),
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      phase: "caught_up",
    });

    await Effect.runPromise(
      invalidateCoordinationReadiness(root, "another-task"),
    );
    expect(await Bun.file(path).exists()).toBe(true);
    await Effect.runPromise(
      invalidateCoordinationReadiness(root, "bg-listener"),
    );
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("writes an identity-bound Crewmate launch confirmation", async () => {
    const root = await temporaryRoot();
    await Effect.runPromise(
      writeCrewmateReadiness({
        agentId: "00000000-0000-4000-8000-000000000003",
        assignmentId: "00000000-0000-4000-8000-000000000005",
        briefSha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        harness: "codex",
        herdrSession: "agentos-crewmate",
        processId: 4242,
        stateDirectory: root,
        taskId: "00000000-0000-4000-8000-000000000004",
      }),
    );
    const path = join(root, "readiness", "crewmate.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      agentId: "00000000-0000-4000-8000-000000000003",
      assignmentId: "00000000-0000-4000-8000-000000000005",
      briefSha256:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      harness: "codex",
      herdrSession: "agentos-crewmate",
      processId: 4242,
      taskId: "00000000-0000-4000-8000-000000000004",
      version: 1,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
