# Discord ingress boundary

This package owns only the optional Discord Gateway connection and persistence
of accepted raw events through the released AgentOS PostgreSQL ingestion
Function.

- Keep Discord as a human surface, never Fleet authority.
- Persist before model wake. Do not prompt a model, create Tasks or Inbox,
  interpret messages, send replies, or add a provider outbox.
- Keep `pg-listen agentos_events` plus the generic background-command
  completion message as the only Pi wake path. This service never calls Pi or
  adds a Discord-specific wake.
- Keep Gateway resume state in memory only. PostgreSQL owns accepted durable
  evidence and reconciliation; do not add a cursor table, queue, cache file or
  another database schema.
- Accept only configured guild/category traffic, explicit bot mentions and
  direct messages. Ignore bot and webhook authors to prevent feedback loops.
- Preserve complete accepted Gateway dispatches except temporary provider
  credentials. Redact an interaction token before persistence, name the
  redacted field in request metadata, and retain the real token in memory only
  long enough to acknowledge the interaction after persistence.
- Recognize only the generic `agentos:<follow-up|steer|stop>:<opaque>` component
  envelope. Preserve the requested delivery class as evidence; do not implement
  its conversational semantics or claim immediate Pi steering or cancellation.
- Read credentials from the approved environment or mode-restricted files and
  never log tokens, PostgreSQL URLs or message payloads.
- Keep provider and database failures visible. Gateway reconnect and resume are
  protocol lifecycle, not authority to hide a failed event ingestion.
- Test routing and lifecycle through public interfaces; never assert that
  source files contain chosen strings.
