import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import { createHash } from "node:crypto";
import compositionManifestSchemaDocument from "./manifest-v1.schema.json";

export const compositionMaterialKinds = [
  "instructions",
  "skill",
] as const;

export type CompositionMaterialKind =
  (typeof compositionMaterialKinds)[number];

export type CompositionOrigin = {
  kind: string;
  locator: string;
  path?: string;
  revision?: string;
  [key: string]: unknown;
};

export type CompositionReference = {
  id: string;
  origin: CompositionOrigin;
  digest: string;
  [key: string]: unknown;
};

export type CompositionMaterial = CompositionReference & {
  kind: CompositionMaterialKind;
  entrypoint: string;
};

export type CompositionCapabilityRequirement = {
  id: string;
  access: string;
  authority_ref?: string;
  [key: string]: unknown;
};

export type CompositionManifest = {
  version: 1;
  harness: string;
  materials: CompositionMaterial[];
  composer?: CompositionReference;
  profile?: CompositionReference;
  settings?: Record<string, unknown>;
  capability_requirements?: CompositionCapabilityRequirement[];
};

export const compositionManifestSchema = compositionManifestSchemaDocument;

const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
  compositionManifestSchema,
);
export function parseCompositionManifest(value: unknown): CompositionManifest {
  if (!containsOnlyExactJsonValues(value)) {
    throw new Error(
      "Invalid composition manifest: manifest must contain only exact JSON values",
    );
  }

  if (!validate(value)) {
    throw new Error(`Invalid composition manifest: ${formatErrors(validate.errors)}`);
  }

  const manifest = value as CompositionManifest;
  const ids = new Set<string>();
  for (const material of manifest.materials) {
    if (ids.has(material.id)) {
      throw new Error(
        `Invalid composition manifest: duplicate material ID ${material.id}`,
      );
    }
    ids.add(material.id);
  }

  return manifest;
}

export function canonicalCompositionJson(
  manifest: CompositionManifest,
): string {
  return JSON.stringify(sortJson(parseCompositionManifest(manifest)));
}

export function digestCompositionManifest(
  manifest: CompositionManifest,
): string {
  return `sha256:${createHash("sha256")
    .update(canonicalCompositionJson(manifest), "utf8")
    .digest("hex")}`;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "unknown validation failure";
  return errors
    .map(({ instancePath, message }) => `${instancePath || "/"} ${message}`)
    .join("; ");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function containsOnlyExactJsonValues(root: unknown): boolean {
  const ancestors = new WeakSet<object>();
  const pending: Array<{ value: unknown; leaving?: true }> = [{ value: root }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const value = current.value;
    if (current.leaving) {
      ancestors.delete(value as object);
      continue;
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (Array.isArray(value)) {
      if (ancestors.has(value)) return false;
      ancestors.add(value);
      pending.push({ value, leaving: true });

      const ownKeys = Reflect.ownKeys(value);
      let itemCount = 0;
      for (const key of ownKeys) {
        if (key === "length") continue;
        if (typeof key !== "string") return false;
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          String(index) !== key ||
          index >= value.length
        ) {
          return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          return false;
        }
        itemCount += 1;
        pending.push({ value: descriptor.value });
      }
      if (itemCount !== value.length) return false;
      continue;
    }
    if (typeof value !== "object") return false;

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    pending.push({ value, leaving: true });

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        return false;
      }
      pending.push({ value: descriptor.value });
    }
  }

  return true;
}
