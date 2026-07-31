import { complete } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { StartupMemoryContext } from "../memory/store.ts";
import {
  redactAuxiliaryInput,
  RELEVANT_SELECTION_SYSTEM_PROMPT,
} from "./prompts.ts";
import type { AgentOSTelemetrySource } from "../telemetry/auxiliary.ts";
import {
  safeAssistantFailure,
  safeTokenCount,
  startAgentOSAuxiliaryOperation,
} from "../telemetry/auxiliary.ts";

export interface RelevantSelectionInput {
  prompt: string;
  startup: StartupMemoryContext;
  model: Model<any> | undefined;
  modelRegistry: ModelRegistry;
  signal?: AbortSignal;
  telemetry?: AgentOSTelemetrySource;
  completeImpl?: typeof complete;
}

export type RelevantTopicSelector = (
  input: RelevantSelectionInput,
) => Promise<string[]>;

function relevantTopicId(index: number): string {
  return `topic-${index}`;
}

export function relevantSelectionMessage(
  input: RelevantSelectionInput,
): string {
  return JSON.stringify({
    request: redactAuxiliaryInput(input.prompt),
    index: redactAuxiliaryInput(input.startup.index),
    inventory: input.startup.inventory.map((topic, index) => ({
      id: relevantTopicId(index),
      type: redactAuxiliaryInput(topic.type),
      scope: redactAuxiliaryInput(topic.scope),
      modified: redactAuxiliaryInput(topic.modified),
      pinned: topic.pinned,
    })),
  });
}

export function resolveRelevantTopicIds(
  ids: string[],
  inventory: RelevantSelectionInput["startup"]["inventory"],
): string[] {
  const pathsById = new Map(
    inventory.map((topic, index) => [relevantTopicId(index), topic.relativePath]),
  );
  return ids.flatMap((id) => {
    const path = pathsById.get(id);
    return path ? [path] : [];
  });
}

export const selectRelevantTopics: RelevantTopicSelector = async (input) => {
  if (!input.model || input.startup.inventory.length === 0) return [];
  const auth = await input.modelRegistry.getApiKeyAndHeaders(input.model);
  if (!auth.ok) throw new Error(auth.error);
  const operation = await startAgentOSAuxiliaryOperation(
    input.model,
    input.telemetry,
    "resumed",
  );
  const attempt = operation.startProviderAttempt({
    requestKind: "extension",
    streamMode: "non_streaming",
  });
  const headers = { ...auth.headers };
  attempt.inject(headers);
  let attemptEnded = false;
  try {
    const response = await (input.completeImpl ?? complete)(
      input.model,
      {
        systemPrompt: RELEVANT_SELECTION_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: relevantSelectionMessage(input),
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers,
        env: auth.env,
        signal: input.signal,
        temperature: 0,
        maxTokens: 1_024,
      },
    );
    const failure = safeAssistantFailure(response.stopReason);
    attempt.end({
      status: 200,
      error: failure,
      streamOutcome: failure
        ? response.stopReason === "aborted"
          ? "aborted"
          : "upstream_error"
        : "completed",
      inputTokens: safeTokenCount(response.usage.input),
      outputTokens: safeTokenCount(response.usage.output),
    });
    attemptEnded = true;
    if (failure) {
      throw new Error(
        response.stopReason === "aborted"
          ? "memory selector aborted"
          : "memory selector failed",
      );
    }
    const text = response.content
      .filter(
        (
          part,
        ): part is Extract<
          (typeof response.content)[number],
          { type: "text" }
        > => part.type === "text",
      )
      .map(({ text }) => text)
      .join("");
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !("ids" in parsed) ||
      !Array.isArray(parsed.ids) ||
      !parsed.ids.every((id) => typeof id === "string")
    ) {
      throw new Error("memory selector returned an invalid ID response");
    }
    operation.end({ status: 200 });
    return resolveRelevantTopicIds(parsed.ids, input.startup.inventory);
  } catch (error) {
    if (!attemptEnded) {
      attempt.end({ error, streamOutcome: "upstream_error" });
    }
    operation.end({ error });
    throw error;
  }
};
