import {
  loadPackagedRoleComposition,
  type DefaultRoleCompositionV1,
} from "./shared.ts";

export function loadSecondMateComposition(): Promise<DefaultRoleCompositionV1> {
  return loadPackagedRoleComposition("second_mate", "secondmate", []);
}
