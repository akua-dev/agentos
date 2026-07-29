import {
  loadPackagedRoleComposition,
  type DefaultRoleCompositionV1,
} from "./shared.ts";

export const firstMateSkillNames = Object.freeze([
  "agentos-bootstrap",
  "agentos-secondmates",
]);

export function loadFirstMateComposition(): Promise<DefaultRoleCompositionV1> {
  return loadPackagedRoleComposition(
    "first_mate",
    "firstmate",
    firstMateSkillNames,
  );
}
