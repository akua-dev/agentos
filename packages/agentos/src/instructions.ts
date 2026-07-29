import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { assertQualifiedName } from "./preflight.ts";

export type AgentOSInstructionSourceV1 = {
  version: 1;
  id: string;
  content: string;
};

export function buildAgentOSInstructions(
  sources: readonly AgentOSInstructionSourceV1[],
): string {
  const ids = new Set<string>();
  return sources
    .map((source) => {
      if (source.version !== 1) {
        throw new Error(
          `instruction source "${source.id}" uses unsupported version`,
        );
      }
      assertQualifiedName(source.id, "instruction source id");
      if (ids.has(source.id)) {
        throw new Error(`duplicate instruction source id "${source.id}"`);
      }
      ids.add(source.id);
      if (typeof source.content !== "string" || !source.content.trim()) {
        throw new Error(`instruction source "${source.id}" must not be empty`);
      }
      return [
        `<agentos-instructions id="${source.id}">`,
        source.content.trim(),
        "</agentos-instructions>",
      ].join("\n");
    })
    .join("\n\n");
}

export function registerAgentOSInstructions(
  pi: ExtensionAPI,
  sources: readonly AgentOSInstructionSourceV1[],
): void {
  const instructions = buildAgentOSInstructions(sources);
  if (!instructions) return;

  pi.on("before_agent_start", (event) => {
    if (event.systemPrompt.includes(instructions)) {
      return { systemPrompt: event.systemPrompt };
    }
    return {
      systemPrompt: `${event.systemPrompt.trimEnd()}\n\n${instructions}`,
    };
  });
}
