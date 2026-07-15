#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PiDefaultsModel = {
  id: string;
  provider: string;
};

export type PiDefaultsContext = {
  model?: PiDefaultsModel;
  modelRegistry: {
    find(provider: string, id: string): PiDefaultsModel | undefined;
    hasConfiguredAuth(model: PiDefaultsModel): boolean;
  };
};

export type PiDefaultsEvent = "model_select" | "session_start";

type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

type PiDefaultsHandler = (
  event: unknown,
  context: PiDefaultsContext,
) => void | Promise<void>;

export type PiDefaultsApi = {
  on(event: PiDefaultsEvent, handler: PiDefaultsHandler): void;
  setModel(model: PiDefaultsModel): Promise<boolean>;
  setThinkingLevel(level: PiThinkingLevel): void;
};

export async function installPiDefaultReconciler(
  pi: PiDefaultsApi,
  settingsPath: string,
) {
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
    string,
    unknown
  >;
  const provider = settings.defaultProvider;
  const modelId = settings.defaultModel;
  const thinkingLevel = settings.defaultThinkingLevel;
  if (
    typeof provider !== "string" ||
    typeof modelId !== "string" ||
    !isThinkingLevel(thinkingLevel)
  ) {
    return;
  }

  let reconciling = false;
  let settled = false;
  const reconcile = async (context: PiDefaultsContext) => {
    if (reconciling || settled) return;
    const target = context.modelRegistry.find(provider, modelId);
    if (!target || !context.modelRegistry.hasConfiguredAuth(target)) return;

    reconciling = true;
    try {
      const alreadySelected =
        context.model?.provider === provider && context.model.id === modelId;
      if (!alreadySelected && !(await pi.setModel(target))) return;
      pi.setThinkingLevel(thinkingLevel);
      settled = true;
    } finally {
      reconciling = false;
    }
  };

  pi.on("session_start", (_event, context) => reconcile(context));
  pi.on("model_select", (_event, context) => reconcile(context));
}

export default async function install(pi: PiDefaultsApi) {
  const home = process.env.HOME;
  const piAgentDirectory =
    process.env.PI_CODING_AGENT_DIR ??
    (home ? join(home, ".pi", "agent") : undefined);
  if (!piAgentDirectory) return;
  await installPiDefaultReconciler(
    pi,
    join(piAgentDirectory, "settings.json"),
  );
}

function isThinkingLevel(value: unknown): value is PiThinkingLevel {
  return (
    typeof value === "string" &&
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      value,
    )
  );
}
