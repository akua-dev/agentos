import type {
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

export type AgentOSPiCommandProgram<E> = (
  arguments_: string,
  context: ExtensionCommandContext,
) => Effect.Effect<void, E>;
export type AgentOSPiExtensionProgram<E> = (
  pi: ExtensionAPI,
) => Effect.Effect<void, E>;

/** The sole one-way Promise adapter for Pi and provider callback ABIs. */
export function runAgentOSPiProgram<A, E>(
  program: Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(program);
}

/**
 * The one-way runtime boundary required by Pi's Promise-only command ABI.
 * AgentOS command implementations stay as Effect programs; Pi owns the Promise.
 */
export function defineAgentOSPiCommandHandler<E>(
  program: AgentOSPiCommandProgram<E>,
): RegisteredCommand["handler"] {
  return (arguments_, context) =>
    runAgentOSPiProgram(program(arguments_, context));
}

/** Defines a Pi extension without moving registration logic outside Effect. */
export function defineAgentOSPiExtension<E>(
  program: AgentOSPiExtensionProgram<E>,
) {
  return (pi: ExtensionAPI): Promise<void> => runAgentOSPiProgram(program(pi));
}
