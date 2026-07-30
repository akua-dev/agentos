import { Schema } from "effect"
import { CandidateExplanation } from "./model.ts"

export class NoEligibleAccountsError extends Schema.TaggedErrorClass<NoEligibleAccountsError>()(
  "NoEligibleAccountsError",
  {
    explanations: Schema.Array(CandidateExplanation),
    message: Schema.String
  }
) {}

export class RoutingStateError extends Schema.TaggedErrorClass<RoutingStateError>()(
  "RoutingStateError",
  {
    message: Schema.String
  }
) {}
