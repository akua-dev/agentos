import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Cause, Effect, Schema } from "effect";

import {
  PiSkillNameSchema,
  QualifiedNameSchema,
  type AgentOSStartupContributionV1,
} from "./shared/contracts.ts";
import {
  decodeOrValidationError,
  makeValidationError,
} from "./shared/errors.ts";
import { runAgentOSPiProgram } from "./pi-host-adapter.ts";

export type { AgentOSStartupContributionV1 } from "./shared/contracts.ts";

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
const Version1 = Schema.Literal(1);
const textEncoder = new TextEncoder();
const defaultStartupReasons: readonly SessionStartEvent["reason"][] = [
  "startup",
  "reload",
];

export const buildAgentOSStartupPromptEffect = Effect.fn(
  "agentos.startup.buildPrompt",
)(function*(contributions: readonly AgentOSStartupContributionV1[]) {
  if (contributions.length > MAX_CONTRIBUTIONS) {
    return yield* makeValidationError(
      "limit_exceeded",
      "startup_contribution",
      "contributions",
      `AgentOS startup accepts at most ${MAX_CONTRIBUTIONS} contributions`,
    );
  }
  const ids = new Set<string>();
  const instructions: string[] = [];
  let instructionBytes = 0;
  for (const contribution of contributions) {
    yield* decodeOrValidationError(
      Version1,
      contribution.version,
      makeValidationError(
        "unsupported_version",
        "startup_contribution",
        "version",
        `unsupported startup contribution version for "${contribution.id}"`,
      ),
    );
    const id = yield* decodeOrValidationError(
      QualifiedNameSchema,
      contribution.id,
      makeValidationError(
        "invalid_name",
        "startup_contribution",
        "id",
        `startup contribution id must be at most ${MAX_ID_CHARACTERS} characters and package-qualified`,
      ),
    );
    if (ids.has(id)) {
      return yield* makeValidationError(
        "duplicate_name",
        "startup_contribution",
        "id",
        `duplicate startup contribution id "${id}"`,
      );
    }
    ids.add(id);
    const skill = yield* decodeOrValidationError(
      PiSkillNameSchema,
      contribution.skill,
      makeValidationError(
        "invalid_name",
        "startup_contribution",
        "skill",
        "startup contribution skill must be a valid Pi Skill name of at most 64 lowercase letters, numbers, and non-consecutive hyphens",
      ),
    );
    const instruction = yield* decodeOrValidationError(
      Schema.NonEmptyString,
      contribution.instruction,
      makeValidationError(
        "invalid_shape",
        "startup_contribution",
        "instruction",
        `startup contribution "${id}" instruction must not be empty`,
      ),
    );
    const bytes = textEncoder.encode(instruction).byteLength;
    if (bytes > MAX_INSTRUCTION_BYTES) {
      return yield* makeValidationError(
        "limit_exceeded",
        "startup_contribution",
        "instruction",
        `startup contribution "${id}" instruction exceeds ${MAX_INSTRUCTION_BYTES} UTF-8 bytes`,
      );
    }
    instructionBytes += bytes;
    if (instructionBytes > MAX_TOTAL_INSTRUCTION_BYTES) {
      return yield* makeValidationError(
        "limit_exceeded",
        "startup_contribution",
        "instruction",
        `AgentOS startup instructions exceed ${MAX_TOTAL_INSTRUCTION_BYTES} UTF-8 bytes`,
      );
    }
    instructions.push(
      [`Load $${skill} and reconcile ${id}:`, instruction].join("\n"),
    );
  }
  return instructions.join("\n\n");
});

export const preflightAgentOSStartupEffect = Effect.fn(
  "agentos.startup.preflight",
)(function*(options: AgentOSStartupOptions) {
  if (options.enabled === false) return;
  yield* decodeOrValidationError(
    Schema.NonEmptyString.pipe(
      Schema.check(
        Schema.makeFilter((value) => value.trim().length > 0, {
          expected: "a non-blank prompt",
        }),
      ),
    ),
    options.prompt,
    makeValidationError(
      "invalid_shape",
      "startup",
      "prompt",
      "AgentOS startup prompt must not be empty",
    ),
  );
  yield* decodeOrValidationError(
    QualifiedNameSchema,
    options.customType,
    makeValidationError(
      "invalid_name",
      "startup",
      "customType",
      "AgentOS startup custom message type must be a package-qualified name of at most 128 characters",
    ),
  );
  const skills = yield* decodeOrValidationError(
    Schema.Array(Schema.Unknown),
    options.requiredSkills,
    makeValidationError(
      "invalid_shape",
      "startup",
      "requiredSkills",
      "AgentOS startup required Skills must be an array",
    ),
  );
  if (skills.length === 0) {
    return yield* makeValidationError(
      "invalid_shape",
      "startup",
      "requiredSkills",
      "AgentOS startup requires at least one preloaded Pi Skill",
    );
  }
  const requiredSkills = new Set<string>();
  for (const skill of skills) {
    const decoded = yield* decodeOrValidationError(
      PiSkillNameSchema,
      skill,
      makeValidationError(
        "invalid_name",
        "startup",
        "requiredSkills",
        "AgentOS startup required Skill must be a valid Pi Skill name of at most 64 lowercase letters, numbers, and non-consecutive hyphens",
      ),
    );
    if (requiredSkills.has(decoded)) {
      return yield* makeValidationError(
        "duplicate_name",
        "startup",
        "requiredSkills",
        `duplicate AgentOS startup required Skill "${decoded}"`,
      );
    }
    requiredSkills.add(decoded);
  }
});

export const registerAgentOSStartupEffect = Effect.fn(
  "agentos.startup.register",
)(function*(pi: ExtensionAPI, options: AgentOSStartupOptions) {
  yield* preflightAgentOSStartupEffect(options);
  if (options.enabled === false) return;
  const reasons = new Set<SessionStartEvent["reason"]>(
    options.reasons ?? defaultStartupReasons,
  );
  let triggered = false;

  yield* Effect.sync(() => {
    pi.on("session_start", (event, context) => {
      const handler = handleSessionStartEffect(
        pi,
        options,
        event,
        context,
        reasons,
        triggered,
        () => {
          triggered = true;
        },
      );
      return runStartupHandler(handler, options.onError);
    });
  });
});

const handleSessionStartEffect = Effect.fn(
  "agentos.startup.handleSessionStart",
)(function*(
  pi: ExtensionAPI,
  options: AgentOSStartupOptions,
  event: SessionStartEvent,
  context: ExtensionContext,
  reasons: ReadonlySet<SessionStartEvent["reason"]>,
  triggered: boolean,
  markTriggered: () => void,
) {
  if (triggered || !reasons.has(event.reason) || !context.isIdle()) {
    return;
  }
  yield* Effect.sync(markTriggered);
  const systemPrompt = yield* Effect.try({
    try: () => context.getSystemPrompt(),
    catch: (cause) => cause,
  });
  for (const skill of options.requiredSkills) {
    if (!hasAvailableSkill(systemPrompt, skill)) {
      return yield* makeValidationError(
        "invalid_shape",
        "startup",
        "requiredSkills",
        `AgentOS startup requires Pi to preload Skill "${skill}" before session_start`,
      );
    }
  }
  yield* Effect.try({
    try: () =>
      pi.sendMessage(
        {
          customType: options.customType,
          content: options.prompt,
          display: options.display ?? true,
          details: { reason: event.reason },
        },
        { deliverAs: "followUp", triggerTurn: true },
      ),
    catch: (cause) => cause,
  });
});

function runStartupHandler(
  handler: Effect.Effect<void, unknown>,
  onError: ((error: unknown) => void) | undefined,
): Promise<void> {
  if (onError === undefined) return runAgentOSPiProgram(handler);
  return runAgentOSPiProgram(
    handler.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => onError(Cause.squash(cause))),
      ),
    ),
  );
}

function hasAvailableSkill(systemPrompt: string, skill: string): boolean {
  const catalog = systemPrompt.match(
    /<available_skills>[\s\S]*?<\/available_skills>/,
  )?.[0];
  return catalog?.includes(`<name>${skill}</name>`) ?? false;
}
