import { Schema } from "effect"

export class NoEligibleAccountsError extends Schema.TaggedErrorClass<NoEligibleAccountsError>()(
  "NoEligibleAccountsError",
  {
    message: Schema.String
  }
) {}

export class RoutingStateError extends Schema.TaggedErrorClass<RoutingStateError>()(
  "RoutingStateError",
  {
    message: Schema.String
  }
) {}
