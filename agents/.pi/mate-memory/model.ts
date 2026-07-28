import { complete } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { StartupMemoryContext } from "../../../runtime/memory/store.ts";
import { RELEVANT_SELECTION_SYSTEM_PROMPT } from "./prompts.ts";

export interface RelevantSelectionInput {
  prompt: string;
  startup: StartupMemoryContext;
  model: Model<any> | undefined;
  modelRegistry: ModelRegistry;
  signal?: AbortSignal;
}

export type RelevantTopicSelector = (
  input: RelevantSelectionInput,
) => Promise<string[]>;

export const selectRelevantTopics: RelevantTopicSelector = async (input) => {
  if (!input.model || input.startup.inventory.length === 0) return [];
  const auth = await input.modelRegistry.getApiKeyAndHeaders(input.model);
  if (!auth.ok) throw new Error(auth.error);
  const response = await complete(
    input.model,
    {
      systemPrompt: RELEVANT_SELECTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            request: input.prompt,
            index: input.startup.index,
            inventory: input.startup.inventory,
          }),
          timestamp: Date.now(),
        },
      ],
    },
    {
      ...auth,
      signal: input.signal,
      temperature: 0,
      maxTokens: 1_024,
    },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? "memory selector failed");
  }
  const text = response.content
    .filter(
      (part): part is Extract<(typeof response.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map(({ text }) => text)
    .join("");
  const parsed = JSON.parse(text) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !("paths" in parsed) ||
    !Array.isArray(parsed.paths) ||
    !parsed.paths.every((path) => typeof path === "string")
  ) {
    throw new Error("memory selector returned an invalid path response");
  }
  return parsed.paths;
};
