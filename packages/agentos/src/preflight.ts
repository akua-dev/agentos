import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";

import {
  AgentOSNameClaimsV1Schema,
  PiSkillNameSchema,
  QualifiedNameSchema,
  type AgentOSNameClaimsV1,
} from "./shared/contracts.ts";
import {
  AgentOSValidationError,
  decodeOrValidationError,
  makeValidationError as validationError,
} from "./shared/errors.ts";
import { runSyncLegacy } from "./shared/legacy.ts";

export type { AgentOSNameClaimsV1 } from "./shared/contracts.ts";

export type AgentOSRegistrationV1 = {
  version: 1;
  id: string;
  names: AgentOSNameClaimsV1;
  register(pi: ExtensionAPI): void | Promise<void>;
};

type ClaimKind = "tools" | "commands" | "skills" | "messages" | "entries";

const claimKinds: ReadonlyArray<ClaimKind> = [
  "tools",
  "commands",
  "skills",
  "messages",
  "entries",
];

const singularClaimKind: Readonly<Record<ClaimKind, string>> = {
  tools: "tool",
  commands: "command",
  skills: "skill",
  messages: "message",
  entries: "entry",
};

const MAX_PI_SKILL_NAME_CHARACTERS = 64;
const Version1 = Schema.Literal(1);
const RegistrationFunction = Schema.declare(
  (value): value is AgentOSRegistrationV1["register"] =>
    typeof value === "function",
  { identifier: "AgentOSRegistrationFunction" },
);

export const preflightAgentOSRegistrationsEffect = Effect.fn(
  "agentos.preflight.registrations",
)(function*(registrations: readonly AgentOSRegistrationV1[]) {
  const registrationIds = new Set<string>();
  const owners = new Map<string, string>();

  for (const registration of registrations) {
    yield* decodeOrValidationError(
      Version1,
      registration.version,
      validationError(
        "unsupported_version",
        "registration",
        "version",
        `registration "${registration.id}" uses unsupported AgentOS registration version`,
      ),
    );
    yield* validateQualifiedNameEffect(
      registration.id,
      "registration id",
      "registration",
      "id",
    );
    yield* decodeOrValidationError(
      RegistrationFunction,
      registration.register,
      validationError(
        "invalid_shape",
        "registration",
        "register",
        `registration "${registration.id}" must provide a register function`,
      ),
    );
    if (registrationIds.has(registration.id)) {
      return yield* validationError(
        "duplicate_name",
        "registration",
        "id",
        `duplicate AgentOS registration id "${registration.id}"`,
      );
    }
    registrationIds.add(registration.id);
    yield* decodeOrValidationError(
      Version1,
      registration.names.version,
      validationError(
        "unsupported_version",
        "registration",
        "names.version",
        `name claims for "${registration.id}" uses unsupported AgentOS registration version`,
      ),
    );

    for (const kind of claimKinds) {
      const names = yield* decodeOrValidationError(
        Schema.Array(Schema.Unknown),
        registration.names[kind] ?? [],
        validationError(
          "invalid_shape",
          "registration",
          kind,
          `AgentOS ${kind} claims must be an array`,
        ),
      );
      for (const name of names) {
        if (kind === "skills") {
          yield* validatePiSkillNameEffect(
            name,
            singularClaimKind[kind],
            "registration",
            kind,
          );
        } else {
          yield* validateClaimNameEffect(
            name,
            singularClaimKind[kind],
            kind,
          );
        }
        const key = `${kind}:${name}`;
        const prior = owners.get(key);
        if (prior) {
          return yield* validationError(
            "duplicate_name",
            "registration",
            kind,
            `AgentOS ${singularClaimKind[kind]} "${name}" is claimed by both "${prior}" and "${registration.id}"`,
          );
        }
        owners.set(key, registration.id);
      }
    }
  }
});

export const registerAgentOSRuntimeEffect = Effect.fn(
  "agentos.preflight.registerRuntime",
)(function*(
  pi: ExtensionAPI,
  registrations: readonly AgentOSRegistrationV1[],
) {
  yield* preflightAgentOSRegistrationsEffect(registrations);
  for (const registration of registrations) {
    yield* Effect.tryPromise({
      try: () => Promise.resolve(registration.register(pi)),
      catch: () =>
        validationError(
          "registration_failed",
          "registration",
          "register",
          `AgentOS registration "${registration.id}" failed`,
        ),
    });
  }
});

export function preflightAgentOSRegistrations(
  registrations: readonly AgentOSRegistrationV1[],
): void {
  runLegacyValidation(preflightAgentOSRegistrationsEffect(registrations));
}

export function registerAgentOSRuntime(
  pi: ExtensionAPI,
  registrations: readonly AgentOSRegistrationV1[],
): void | Promise<void> {
  preflightAgentOSRegistrations(registrations);

  let pending: Promise<void> | undefined;
  for (const registration of registrations) {
    if (pending) {
      pending = pending.then(() => registration.register(pi));
      continue;
    }
    const result = registration.register(pi);
    if (result && typeof result.then === "function") {
      pending = Promise.resolve(result);
    }
  }
  return pending;
}

export function assertQualifiedName(
  value: unknown,
  label: string,
): asserts value is string {
  runLegacyValidation(
    validateQualifiedNameEffect(value, label, "qualified_name", label),
  );
}

export function assertPiSkillName(
  value: unknown,
  label: string,
): asserts value is string {
  runLegacyValidation(
    validatePiSkillNameEffect(value, label, "pi_skill_name", label),
  );
}

const validateQualifiedNameEffect = Effect.fn(
  "agentos.preflight.qualifiedName",
)(function*(
  value: unknown,
  label: string,
  boundary: string,
  field: string,
) {
  return yield* decodeOrValidationError(
    QualifiedNameSchema,
    value,
    validationError(
      "invalid_name",
      boundary,
      field,
      `${label} must be a package-qualified name of at most 128 characters`,
    ),
  );
});

const validatePiSkillNameEffect = Effect.fn(
  "agentos.preflight.piSkillName",
)(function*(
  value: unknown,
  label: string,
  boundary: string,
  field: string,
) {
  return yield* decodeOrValidationError(
    PiSkillNameSchema,
    value,
    validationError(
      "invalid_name",
      boundary,
      field,
      `${label} must be a valid Pi Skill name of at most ${MAX_PI_SKILL_NAME_CHARACTERS} lowercase letters, numbers, and non-consecutive hyphens`,
    ),
  );
});

const validateClaimNameEffect = Effect.fn(
  "agentos.preflight.claimName",
)(function*(value: unknown, kind: string, field: string) {
  return yield* decodeOrValidationError(
    QualifiedNameSchema,
    value,
    validationError(
      "invalid_name",
      "registration",
      field,
      `AgentOS ${kind} name must be non-empty, namespaced, and at most 128 characters`,
    ),
  );
});

function runLegacyValidation<A>(
  effect: Effect.Effect<A, AgentOSValidationError>,
): A {
  return runSyncLegacy(effect);
}
