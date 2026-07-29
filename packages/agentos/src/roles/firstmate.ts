import {
  loadPackagedRoleSetup,
  type DefaultRoleSetupV1,
} from "./shared.ts";

export function loadFirstMateSetup(): Promise<DefaultRoleSetupV1> {
  return loadPackagedRoleSetup("first_mate", "firstmate");
}
