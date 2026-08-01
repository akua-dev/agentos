import { createRoutingState } from "./routing-state.ts";
import { makeAIRoutingStateLayer } from "./state.ts";
import type { RoutingConfig } from "./types.ts";

export function makeAIRoutingStateLive(
  path: string,
  config: RoutingConfig,
) {
  return makeAIRoutingStateLayer(() => createRoutingState(path, config));
}
