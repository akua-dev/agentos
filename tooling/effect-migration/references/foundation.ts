import { Config, Context, Effect, Layer, Schema } from "effect"

export class AgentIdentity extends Schema.Class<AgentIdentity>("AgentIdentity")({
  id: Schema.String,
  role: Schema.Literals(["firstmate", "secondmate", "crewmate"])
}) {}

export class IdentityLookupError extends Schema.TaggedErrorClass<IdentityLookupError>()(
  "IdentityLookupError",
  {
    agentId: Schema.String,
    reason: Schema.String
  }
) {}

export class IdentityDirectory extends Context.Service<IdentityDirectory, {
  readonly find: (agentId: string) => Effect.Effect<AgentIdentity, IdentityLookupError>
}>()("agentos/IdentityDirectory") {
  static readonly test = (identities: ReadonlyMap<string, AgentIdentity>) =>
    Layer.succeed(IdentityDirectory)({
      find: Effect.fn("IdentityDirectory.find")(function*(agentId: string) {
        const identity = identities.get(agentId)
        if (identity !== undefined) return identity
        return yield* IdentityLookupError.make({ agentId, reason: "identity_not_found" })
      })
    })
}

export const GatewayConfig = Config.all({
  endpoint: Config.url("AGENTOS_GATEWAY_URL"),
  token: Config.redacted("AGENTOS_GATEWAY_TOKEN"),
  retries: Config.int("AGENTOS_GATEWAY_RETRIES").pipe(Config.withDefault(2))
})

export const gatewayDiagnosticConfig = GatewayConfig.pipe(
  Effect.map(({ endpoint, retries }) => ({
    endpoint,
    retries
  }))
)
