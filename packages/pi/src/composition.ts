import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type AgentOSNameClaimsV1 = {
  version: 1;
  tools?: readonly string[];
  commands?: readonly string[];
  skills?: readonly string[];
  messages?: readonly string[];
  entries?: readonly string[];
};

export type AgentOSRegistrationV1 = {
  version: 1;
  id: string;
  names: AgentOSNameClaimsV1;
  register(pi: ExtensionAPI): void | Promise<void>;
};

const claimKinds = [
  "tools",
  "commands",
  "skills",
  "messages",
  "entries",
] as const;

const singularClaimKind = {
  tools: "tool",
  commands: "command",
  skills: "skill",
  messages: "message",
  entries: "entry",
} as const;

export function preflightAgentOSComposition(
  registrations: readonly AgentOSRegistrationV1[],
): void {
  const registrationIds = new Set<string>();
  const owners = new Map<string, string>();

  for (const registration of registrations) {
    assertVersion(registration.version, `registration "${registration.id}"`);
    assertQualifiedName(registration.id, "registration id");
    if (registrationIds.has(registration.id)) {
      throw new Error(`duplicate AgentOS registration id "${registration.id}"`);
    }
    registrationIds.add(registration.id);
    assertVersion(
      registration.names.version,
      `name claims for "${registration.id}"`,
    );

    for (const kind of claimKinds) {
      for (const name of registration.names[kind] ?? []) {
        assertClaimName(name, singularClaimKind[kind]);
        const key = `${kind}:${name}`;
        const prior = owners.get(key);
        if (prior) {
          throw new Error(
            `AgentOS ${singularClaimKind[kind]} "${name}" is claimed by both "${prior}" and "${registration.id}"`,
          );
        }
        owners.set(key, registration.id);
      }
    }
  }
}

export function registerAgentOSRuntime(
  pi: ExtensionAPI,
  registrations: readonly AgentOSRegistrationV1[],
): void | Promise<void> {
  preflightAgentOSComposition(registrations);

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

function assertVersion(version: unknown, owner: string): asserts version is 1 {
  if (version !== 1) {
    throw new Error(`${owner} uses unsupported AgentOS composition version`);
  }
}

export function assertQualifiedName(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9@._:/-]+$/.test(value)
  ) {
    throw new Error(
      `${label} must be a package-qualified name of at most 128 characters`,
    );
  }
}

function assertClaimName(value: unknown, kind: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9@._:/-]+$/.test(value)
  ) {
    throw new Error(
      `AgentOS ${kind} name must be non-empty, namespaced, and at most 128 characters`,
    );
  }
}
