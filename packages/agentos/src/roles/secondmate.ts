import {
  loadPackagedRoleSetup,
  type DefaultRoleSetupV1,
} from "./shared.ts";

export function loadSecondMateSetup(): Promise<DefaultRoleSetupV1> {
  return loadPackagedRoleSetup("second_mate", "secondmate");
}
