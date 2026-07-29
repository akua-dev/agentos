import type {
  ExtensionAPI,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { assertPiSkillName, assertQualifiedName } from "./preflight.ts";

export type AgentOSStartupContributionV1 = {
  version: 1;
  id: string;
  skill: string;
  instruction: string;
};

export type AgentOSStartupOptions = {
  prompt: string;
  customType: string;
  requiredSkills: readonly string[];
  enabled?: boolean;
  display?: boolean;
  reasons?: readonly SessionStartEvent["reason"][];
  onError?: (error: unknown) => void;
};

const MAX_CONTRIBUTIONS = 16;
const MAX_ID_CHARACTERS = 128;
const MAX_INSTRUCTION_BYTES = 2_048;
const MAX_TOTAL_INSTRUCTION_BYTES = 16_384;

export function buildAgentOSStartupPrompt(
  contributions: readonly AgentOSStartupContributionV1[],
): string {
  if (contributions.length > MAX_CONTRIBUTIONS) {
    throw new Error(
      `AgentOS startup accepts at most ${MAX_CONTRIBUTIONS} contributions`,
    );
  }
  const ids = new Set<string>();
  let instructionBytes = 0;
  return contributions
    .map((contribution) => {
      if (contribution.version !== 1) {
        throw new Error(
          `unsupported startup contribution version for "${contribution.id}"`,
        );
      }
      if (
        typeof contribution.id !== "string" ||
        contribution.id.length > MAX_ID_CHARACTERS
      ) {
        throw new Error(
          `startup contribution id must be at most ${MAX_ID_CHARACTERS} characters`,
        );
      }
      assertQualifiedName(contribution.id, "startup contribution id");
      if (ids.has(contribution.id)) {
        throw new Error(
          `duplicate startup contribution id "${contribution.id}"`,
        );
      }
      ids.add(contribution.id);
      assertPiSkillName(contribution.skill, "startup contribution skill");
      if (
        typeof contribution.instruction !== "string" ||
        contribution.instruction.length === 0
      ) {
        throw new Error(
          `startup contribution "${contribution.id}" instruction must not be empty`,
        );
      }
      const bytes = Buffer.byteLength(contribution.instruction, "utf8");
      if (bytes > MAX_INSTRUCTION_BYTES) {
        throw new Error(
          `startup contribution "${contribution.id}" instruction exceeds ${MAX_INSTRUCTION_BYTES} UTF-8 bytes`,
        );
      }
      instructionBytes += bytes;
      if (instructionBytes > MAX_TOTAL_INSTRUCTION_BYTES) {
        throw new Error(
          `AgentOS startup instructions exceed ${MAX_TOTAL_INSTRUCTION_BYTES} UTF-8 bytes`,
        );
      }
      return [
        `Load $${contribution.skill} and reconcile ${contribution.id}:`,
        contribution.instruction,
      ].join("\n");
    })
    .join("\n\n");
}

export function preflightAgentOSStartup(
  options: AgentOSStartupOptions,
): void {
  if (options.enabled === false) return;
  if (typeof options.prompt !== "string" || !options.prompt.trim()) {
    throw new Error("AgentOS startup prompt must not be empty");
  }
  assertQualifiedName(options.customType, "AgentOS startup custom message type");
  if (
    !Array.isArray(options.requiredSkills) ||
    options.requiredSkills.length === 0
  ) {
    throw new Error("AgentOS startup requires at least one preloaded Pi Skill");
  }
  const requiredSkills = new Set<string>();
  for (const skill of options.requiredSkills) {
    assertPiSkillName(skill, "AgentOS startup required Skill");
    if (requiredSkills.has(skill)) {
      throw new Error(`duplicate AgentOS startup required Skill "${skill}"`);
    }
    requiredSkills.add(skill);
  }
}

export function registerAgentOSStartup(
  pi: ExtensionAPI,
  options: AgentOSStartupOptions,
): void {
  preflightAgentOSStartup(options);
  if (options.enabled === false) return;
  const reasons = new Set(options.reasons ?? ["startup", "reload"]);
  let triggered = false;

  pi.on("session_start", (event, context) => {
    if (triggered || !reasons.has(event.reason) || !context.isIdle()) return;
    triggered = true;
    try {
      const systemPrompt = context.getSystemPrompt();
      for (const skill of options.requiredSkills) {
        if (!hasAvailableSkill(systemPrompt, skill)) {
          throw new Error(
            `AgentOS startup requires Pi to preload Skill "${skill}" before session_start`,
          );
        }
      }
      pi.sendMessage(
        {
          customType: options.customType,
          content: options.prompt,
          display: options.display ?? true,
          details: { reason: event.reason },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch (error) {
      if (options.onError) {
        options.onError(error);
        return;
      }
      throw error;
    }
  });
}

function hasAvailableSkill(systemPrompt: string, skill: string): boolean {
  const catalog = systemPrompt.match(
    /<available_skills>[\s\S]*?<\/available_skills>/,
  )?.[0];
  return catalog?.includes(`<name>${skill}</name>`) ?? false;
}
