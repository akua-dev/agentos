import type {
  OAuthCredentials,
  OAuthDeviceCodeInfo,
} from "@earendil-works/pi-ai/oauth";
import {
  Context,
  Effect,
  Redacted,
  Result,
} from "effect";

import {
  type AIGatewayConfig,
  AIGatewayEntrypointError,
  type AIGatewayServeConfig,
  requireAIGatewayServeConfig,
} from "./config.ts";
import { ManagedAccountVault } from "./state.ts";

export class AIGatewayCliOutput extends Context.Service<
  AIGatewayCliOutput,
  {
    readonly line: (value: string) => Effect.Effect<void>;
    readonly error: (value: string) => Effect.Effect<void>;
  }
>()("agentos/ai-gateway/CliOutput") {}

export class AIGatewayOAuth extends Context.Service<
  AIGatewayOAuth,
  {
    readonly login: (
      onDeviceCode: (info: OAuthDeviceCodeInfo) => Effect.Effect<void>,
    ) => Effect.Effect<OAuthCredentials, AIGatewayEntrypointError>;
  }
>()("agentos/ai-gateway/OAuth") {}

export class AIGatewayRuntime extends Context.Service<
  AIGatewayRuntime,
  {
    readonly serve: (
      config: AIGatewayServeConfig,
    ) => Effect.Effect<void, AIGatewayEntrypointError>;
  }
>()("agentos/ai-gateway/Runtime") {}

export class AIGatewayStatusClient extends Context.Service<
  AIGatewayStatusClient,
  {
    readonly read: (
      port: number,
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<string, AIGatewayEntrypointError>;
  }
>()("agentos/ai-gateway/StatusClient") {}

export const runAIGatewayCli = Effect.fn(
  "agentos.aiGateway.runCli",
)(function*(args: ReadonlyArray<string>, config: AIGatewayConfig) {
  const output = yield* AIGatewayCliOutput;
  const oauth = yield* AIGatewayOAuth;
  const runtime = yield* AIGatewayRuntime;
  const status = yield* AIGatewayStatusClient;
  const vault = yield* ManagedAccountVault;
  const command = args[0] ?? "help";

  if (command === "login") {
    return yield* exitStatus(command, output, Effect.gen(function*() {
      const label = args.slice(1).join(" ").trim() || "Codex account";
      const loggedIn = yield* oauth.login((info) =>
        Effect.all([
          output.line(`Open ${info.verificationUri}`),
          output.line(`Enter code ${info.userCode}`),
        ], { discard: true })
      );
      const id = yield* vault.addFromOAuth(label, loggedIn);
      yield* output.line(`Added ${label} (${id})`);
    }));
  }

  if (command === "list") {
    return yield* exitStatus(command, output, Effect.gen(function*() {
      const accounts = yield* vault.list;
      if (accounts.length === 0) {
        yield* output.line("No Codex accounts configured");
        return;
      }
      yield* Effect.forEach(
        accounts,
        (account) =>
          output.line(
            `${account.id}\t${account.label}\t${
              account.needsReauth ? "needs_reauth" : "ready"
            }`,
          ),
        { discard: true },
      );
    }));
  }

  if (command === "status") {
    const token = operatorCredential(config);
    if (Redacted.value(token) === "") {
      yield* output.error(
        "AI_GATEWAY_OPERATOR_TOKEN or legacy AI_GATEWAY_TOKEN is required for status",
      );
      return 1;
    }
    return yield* exitStatus(command, output, Effect.gen(function*() {
      const body = yield* status.read(config.port, token);
      yield* output.line(body);
    }));
  }

  if (command === "remove") {
    const id = args[1];
    if (id === undefined || id.length === 0) {
      yield* output.error(
        "remove requires an opaque account ID from ai-gateway list",
      );
      return 2;
    }
    const removed = yield* Effect.result(vault.remove(id));
    if (Result.isFailure(removed)) {
      yield* output.error(
        `ai-gateway ${command} failed (${removed.failure._tag})`,
      );
      return 1;
    }
    if (!removed.success) {
      yield* output.error(`No managed account exists for ${id}`);
      return 1;
    }
    yield* output.line(`Removed ${id}`);
    return 0;
  }

  if (command === "serve") {
    const serveConfigResult = yield* Effect.result(
      requireAIGatewayServeConfig(config),
    );
    if (Result.isFailure(serveConfigResult)) {
      yield* output.error(
        serveConfigResult.failure.code === "client_identity_unavailable"
          ? "AI_GATEWAY_TOKEN is required to serve"
          : "ai-gateway serve failed (AIGatewayEntrypointError)",
      );
      return 1;
    }
    const serveConfig = serveConfigResult.success;
    return yield* exitStatus(command, output, Effect.gen(function*() {
      yield* output.line(
        `ai-gateway listening on ${serveConfig.hostname}:${serveConfig.port}`,
      );
      yield* runtime.serve(serveConfig);
    }));
  }

  yield* output.line(
    "Usage: ai-gateway <serve|login [label]|list|status|remove <id>>",
  );
  return command === "help" || command === "--help" || command === "-h"
    ? 0
    : 2;
});

function operatorCredential(
  config: AIGatewayConfig,
): Redacted.Redacted<string> {
  return Redacted.value(config.operatorToken) === ""
    ? config.clientToken
    : config.operatorToken;
}

function exitStatus<A, E extends { readonly _tag: string }, R>(
  command: string,
  output: AIGatewayCliOutput["Service"],
  operation: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function*() {
    const result = yield* Effect.result(operation);
    if (Result.isFailure(result)) {
      yield* output.error(
        `ai-gateway ${command} failed (${result.failure._tag})`,
      );
      return 1;
    }
    return 0;
  });
}
