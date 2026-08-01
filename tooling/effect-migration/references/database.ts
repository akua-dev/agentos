import { Effect, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

export class AgentRow extends Schema.Class<AgentRow>("AgentRow")({
  id: Schema.String,
  name: Schema.String,
  role: Schema.Literals(["firstmate", "secondmate", "crewmate"])
}) {}

const decodeAgentRows = Schema.decodeUnknownEffect(Schema.Array(AgentRow))

export const findAgentById = Effect.fn("AgentRepository.findById")(function*(agentId: string) {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<unknown>`
    SELECT id, name, role
    FROM agents
    WHERE id = ${agentId}
  `
  return yield* decodeAgentRows(rows)
})

export const renameAgent = Effect.fn("AgentRepository.rename")(function*(agentId: string, name: string) {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(sql`
    UPDATE agents
    SET name = ${name}
    WHERE id = ${agentId}
  `)
})
