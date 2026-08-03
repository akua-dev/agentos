import type {
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

export type AgentOSPiCommandProgram<E> = (
  arguments_: string,
  context: ExtensionCommandContext,
) => Effect.Effect<void, E>;

/**
 * The one-way runtime boundary required by Pi's Promise-only command ABI.
 * AgentOS command implementations stay as Effect programs; Pi owns the Promise.
 */
export function defineAgentOSPiCommandHandler<E>(
  program: AgentOSPiCommandProgram<E>,
): RegisteredCommand["handler"] {
  return (arguments_, context) => Effect.runPromise(program(arguments_, context));
}
