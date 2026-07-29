import {
  loadPackagedRoleSetup,
  type DefaultRoleSetupV1,
} from "./default.ts";

export function loadSecondMateSetup(): Promise<DefaultRoleSetupV1> {
  return loadPackagedRoleSetup("second_mate", "secondmate");
}
