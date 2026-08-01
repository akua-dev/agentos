import { readFile } from "node:fs/promises";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { AGENTOS_EGRESS_TOKEN_PATH } from "./identity.ts";
import { runPromiseLegacy } from "../shared/legacy.ts";

export const AGENTOS_EGRESS_TOKEN_FILE_ENV = "AGENTOS_EGRESS_TOKEN_FILE";

const JWT_LIKE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ASSIGNMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PROJECTED_TOKEN_BYTES = 16 * 1024;

export interface PiWorkloadIdentityOptions {
  environment?: Readonly<Record<string, string | undefined>>;
  tokenFile?: string;
}

export type PiWorkloadIdentityResolution =
  | { readonly active: false }
  | {
      readonly active: true;
      readonly headers?: Readonly<Record<string, string>>;
    };

export interface PiGatewayModel {
  readonly provider?: string;
  readonly baseUrl?: string;
}

export function registerPiWorkloadIdentity(
  pi: ExtensionAPI,
  options: PiWorkloadIdentityOptions = {},
) {
  const environment = options.environment ?? process.env;
  const gatewayUrl = normalizeUrl(environment.AI_GATEWAY_URL);
  const tokenFile =
    options.tokenFile ??
    environment[AGENTOS_EGRESS_TOKEN_FILE_ENV] ??
    AGENTOS_EGRESS_TOKEN_PATH;

  pi.on("before_provider_headers", async (event, context) => {
    if (!usesAgentOSGateway(context.model, environment, gatewayUrl)) return;

    // Clear both supported legacy credentials before any fallible work. Pi
    // intentionally swallows extension errors, so retaining either value here
    // would turn a projected-token failure into an authentication bypass.
    for (const name of Object.keys(event.headers)) {
      if (isGatewaySecurityHeader(name)) event.headers[name] = null;
    }

    const resolution = await runPromiseLegacy(
      resolvePiWorkloadIdentity(context.model, {
        environment,
        tokenFile,
      }),
    );
    if (!resolution.active || resolution.headers === undefined) return;

    for (const [name, value] of Object.entries(resolution.headers)) {
      event.headers[name] = value;
    }
  });
}

function usesAgentOSGateway(
  model: PiGatewayModel | undefined,
  environment: Readonly<Record<string, string | undefined>>,
  gatewayUrl: string | undefined,
): boolean {
  return (
    environment.AGENTOS_PI_PROVIDER_MODE === "ai-gateway" &&
    gatewayUrl !== undefined &&
    model?.provider === "openai-codex" &&
    normalizeUrl(model.baseUrl) === gatewayUrl
  );
}

export function resolvePiWorkloadIdentity(
  model: PiGatewayModel | undefined,
  options: PiWorkloadIdentityOptions = {},
): Effect.Effect<PiWorkloadIdentityResolution> {
  const environment = options.environment ?? process.env;
  const gatewayUrl = normalizeUrl(environment.AI_GATEWAY_URL);
  if (!usesAgentOSGateway(model, environment, gatewayUrl)) {
    return Effect.succeed({ active: false });
  }

  const assignmentId = environment.AGENTOS_ASSIGNMENT_ID;
  if (assignmentId !== undefined && !ASSIGNMENT_ID.test(assignmentId)) {
    return Effect.succeed({ active: true });
  }

  const tokenFile =
    options.tokenFile ??
    environment[AGENTOS_EGRESS_TOKEN_FILE_ENV] ??
    AGENTOS_EGRESS_TOKEN_PATH;
  return readProjectedToken(tokenFile).pipe(
    Effect.map((token): PiWorkloadIdentityResolution => {
      if (token === undefined) return { active: true };
      return {
        active: true,
        headers: {
          authorization: `Bearer ${token}`,
          ...(assignmentId === undefined
            ? {}
            : { "x-agentos-assignment-id": assignmentId }),
        },
      };
    }),
  );
}

export function isGatewaySecurityHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "x-ai-gateway-token" ||
    normalized === "x-agentos-assignment-id" ||
    normalized.startsWith("x-agentos-authz-")
  );
}

function readProjectedToken(path: string): Effect.Effect<string | undefined> {
  return Effect.promise(async () => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  }).pipe(
    Effect.map((contents) => {
      if (
        contents === undefined ||
        contents.length === 0 ||
        contents.length > MAX_PROJECTED_TOKEN_BYTES ||
        contents.trim() !== contents ||
        !JWT_LIKE.test(contents)
      ) {
        return undefined;
      }
      return contents;
    }),
  );
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export default registerPiWorkloadIdentity;
