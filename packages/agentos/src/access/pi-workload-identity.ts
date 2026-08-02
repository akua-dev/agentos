import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
} from "effect";

import { AGENTOS_EGRESS_TOKEN_PATH } from "./identity.ts";
import { runAgentOSPiProgram } from "../pi-host-adapter.ts";
import { environmentConfigLayer } from "../shared/platform.ts";

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

const PiWorkloadIdentityEnvironment = Config.all({
  assignmentId: Config.option(Config.string("AGENTOS_ASSIGNMENT_ID")),
  gatewayUrl: Config.option(Config.string("AI_GATEWAY_URL")),
  mode: Config.option(Config.string("AGENTOS_PI_PROVIDER_MODE")),
  tokenFile: Config.option(Config.string(AGENTOS_EGRESS_TOKEN_FILE_ENV)),
}).pipe(Effect.map(({ assignmentId, gatewayUrl, mode, tokenFile }) => ({
  AGENTOS_ASSIGNMENT_ID: Option.getOrUndefined(assignmentId),
  AI_GATEWAY_URL: Option.getOrUndefined(gatewayUrl),
  AGENTOS_PI_PROVIDER_MODE: Option.getOrUndefined(mode),
  [AGENTOS_EGRESS_TOKEN_FILE_ENV]: Option.getOrUndefined(tokenFile),
})));

const piWorkloadIdentityPlatform = Layer.merge(
  BunFileSystem.layer,
  environmentConfigLayer(),
);

export const registerPiWorkloadIdentityEffect = Effect.fn(
  "agentos.access.registerPiWorkloadIdentity",
)(function*(
  pi: ExtensionAPI,
  options: PiWorkloadIdentityOptions = {},
) {
  yield* Effect.sync(() => {
    pi.on("before_provider_headers", (event, context) =>
      runAgentOSPiProgram(
        resolvePiWorkloadIdentity(context.model, options).pipe(
          Effect.tap((resolution) =>
            Effect.sync(() => applyResolution(event.headers, resolution))
          ),
          Effect.asVoid,
          Effect.provide(piWorkloadIdentityPlatform),
        ),
      ));
  });
});

export function registerPiWorkloadIdentity(
  pi: ExtensionAPI,
  options: PiWorkloadIdentityOptions = {},
) {
  return runAgentOSPiProgram(registerPiWorkloadIdentityEffect(pi, options));
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
) {
  return Effect.gen(function*() {
    const environment = options.environment ??
      (yield* PiWorkloadIdentityEnvironment);
    const gatewayUrl = normalizeUrl(environment.AI_GATEWAY_URL);
    if (!usesAgentOSGateway(model, environment, gatewayUrl)) {
      return { active: false } satisfies PiWorkloadIdentityResolution;
    }

    const assignmentId = environment.AGENTOS_ASSIGNMENT_ID;
    if (assignmentId !== undefined && !ASSIGNMENT_ID.test(assignmentId)) {
      return { active: true } satisfies PiWorkloadIdentityResolution;
    }

    const tokenFile =
      options.tokenFile ??
      environment[AGENTOS_EGRESS_TOKEN_FILE_ENV] ??
      AGENTOS_EGRESS_TOKEN_PATH;
    const token = yield* readProjectedToken(tokenFile);
    if (token === undefined) {
      return { active: true } satisfies PiWorkloadIdentityResolution;
    }
    return {
      active: true,
      headers: {
        authorization: `Bearer ${token}`,
        ...(assignmentId === undefined
          ? {}
          : { "x-agentos-assignment-id": assignmentId }),
      },
    } satisfies PiWorkloadIdentityResolution;
  });
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

function readProjectedToken(path: string) {
  return Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = Option.getOrUndefined(
      yield* fileSystem.readFileString(path).pipe(Effect.option),
    );
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
  });
}

function applyResolution(
  headers: Record<string, string | null | undefined>,
  resolution: PiWorkloadIdentityResolution,
) {
  if (!resolution.active) return;
  for (const name of Object.keys(headers)) {
    if (isGatewaySecurityHeader(name)) headers[name] = null;
  }
  for (const [name, value] of Object.entries(resolution.headers ?? {})) {
    headers[name] = value;
  }
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
