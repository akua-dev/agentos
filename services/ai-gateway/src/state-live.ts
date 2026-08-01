import { makeEffectAIRoutingStateLayer } from "./effect-routing-state.ts";
import type { RoutingConfig } from "./types.ts";

export function makeAIRoutingStateLive(
  path: string,
  config: RoutingConfig,
) {
  return makeEffectAIRoutingStateLayer(path, config);
}
