import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPiDefaultReconciler,
  type PiDefaultsApi,
  type PiDefaultsContext,
  type PiDefaultsEvent,
} from "../runtime/pi-defaults.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Mate Pi defaults", () => {
  test("adopts persisted defaults once subscription authentication exists", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "agentos-pi-defaults-"));
    temporaryDirectories.push(sandbox);
    const settingsPath = join(sandbox, "settings.json");
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.6-terra",
        defaultThinkingLevel: "high",
      })}\n`,
      "utf8",
    );

    const target = { id: "gpt-5.6-terra", provider: "openai-codex" };
    const selected: typeof target[] = [];
    const thinking: string[] = [];
    const handlers = new Map<
      PiDefaultsEvent,
      (event: unknown, context: PiDefaultsContext) => void | Promise<void>
    >();
    let authenticated = false;
    const context: PiDefaultsContext = {
      model: { id: "gpt-5.5", provider: "openai-codex" },
      modelRegistry: {
        find: (provider, id) =>
          provider === target.provider && id === target.id ? target : undefined,
        hasConfiguredAuth: () => authenticated,
      },
    };
    const api: PiDefaultsApi = {
      on: (event, handler) => handlers.set(event, handler),
      setModel: async (model) => {
        selected.push(model);
        context.model = model;
        return authenticated;
      },
      setThinkingLevel: (level) => thinking.push(level),
    };

    await installPiDefaultReconciler(api, settingsPath);
    await handlers.get("session_start")?.({}, context);
    expect(selected).toEqual([]);

    authenticated = true;
    await handlers.get("model_select")?.({}, context);
    expect(selected).toEqual([target]);
    expect(thinking).toEqual(["high"]);

    context.model = { id: "gpt-5.4", provider: "openai-codex" };
    await handlers.get("model_select")?.({}, context);
    expect(selected).toEqual([target]);
  });
});
