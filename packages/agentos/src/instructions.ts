import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";

import {
  NonBlankStringSchema,
  QualifiedNameSchema,
  type AgentOSInstructionSourceV1,
} from "./shared/contracts.ts";
import {
  decodeOrValidationError,
  makeValidationError,
} from "./shared/errors.ts";

export type { AgentOSInstructionSourceV1 } from "./shared/contracts.ts";

const Version1 = Schema.Literal(1);

export const buildAgentOSInstructionsEffect = Effect.fn(
  "agentos.instructions.build",
)(function*(sources: readonly AgentOSInstructionSourceV1[]) {
  const ids = new Set<string>();
  const instructions: string[] = [];
  for (const source of sources) {
    yield* decodeOrValidationError(
      Version1,
      source.version,
      makeValidationError(
        "unsupported_version",
        "instruction_source",
        "version",
        `instruction source "${source.id}" uses unsupported version`,
      ),
    );
    yield* decodeOrValidationError(
      QualifiedNameSchema,
      source.id,
      makeValidationError(
        "invalid_name",
        "instruction_source",
        "id",
        "instruction source id must be a package-qualified name of at most 128 characters",
      ),
    );
    if (ids.has(source.id)) {
      return yield* makeValidationError(
        "duplicate_name",
        "instruction_source",
        "id",
        `duplicate instruction source id "${source.id}"`,
      );
    }
    ids.add(source.id);
    const content = yield* decodeOrValidationError(
      NonBlankStringSchema,
      source.content,
      makeValidationError(
        "invalid_shape",
        "instruction_source",
        "content",
        `instruction source "${source.id}" must not be empty`,
      ),
    );
    instructions.push(
      [
        `<agentos-instructions id="${source.id}">`,
        content.trim(),
        "</agentos-instructions>",
      ].join("\n"),
    );
  }
  return instructions.join("\n\n");
});

export const registerAgentOSInstructionsEffect = Effect.fn(
  "agentos.instructions.register",
)(function*(
  pi: ExtensionAPI,
  sources: readonly AgentOSInstructionSourceV1[],
) {
  const instructions = yield* buildAgentOSInstructionsEffect(sources);
  if (!instructions) return;

  yield* Effect.sync(() => {
    pi.on("before_agent_start", (event) => {
      if (event.systemPrompt.includes(instructions)) {
        return { systemPrompt: event.systemPrompt };
      }
      return {
        systemPrompt: `${event.systemPrompt.trimEnd()}\n\n${instructions}`,
      };
    });
  });
});
