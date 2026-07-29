import {
  loadPackagedRoleComposition,
  type DefaultRoleCompositionV1,
} from "./shared.ts";

export function loadFirstMateComposition(): Promise<DefaultRoleCompositionV1> {
  return loadPackagedRoleComposition("first_mate", "firstmate");
}
