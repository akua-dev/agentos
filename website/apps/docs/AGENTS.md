# AgentOS public website boundary

This file governs the landing page, Docs, Learn and supporting content under
`website/apps/docs/`. It adds public-evidence rules to the repository boundary
in the root `AGENTS.md`.

## Use real AgentOS examples

Every example that represents AgentOS behavior must derive from an observed
real run: published benchmark evidence or an authorized AgentOS cluster or
session. This includes sample prompts and briefs, Mate or Agent messages, Task
and Assignment state, decisions, reports, terminal excerpts, operational
narratives and screenshots.

- Never invent or composite behavioral examples. Do not rewrite a real example
  to add an event, decision, authority, result or capability that was not
  observed.
- Faithful editing may shorten irrelevant material, normalize formatting and
  replace identifying names. It must preserve the behavior, sequence,
  ownership and authority boundary being demonstrated.
- Before committing, remove credentials, secrets, tokens, personal identities,
  organizations, customers, repository and project names, cluster and namespace
  names, internal hosts and URLs, account and resource IDs, local paths,
  proprietary data and unrelated private context.
- Record provenance in the delivering pull request: source class, observation
  date, exact AgentOS revision when known and the sanitization performed. Link
  public evidence directly. Never put a private evidence locator, access detail
  or unsanitized excerpt in Git or the public pull request.
- If no safe real evidence is available, omit the example and explain the
  contract directly. Do not fill the gap with a hypothetical scenario.
- When changing an existing behavioral example, verify its provenance, replace
  it with sanitized real evidence or remove it in the same change. Existing
  website prose is not proof that an example came from a real run.

Exact copy-and-paste product instructions and literal command, API, schema or
configuration syntax are product contracts rather than observed behavior. They
may be copied from their canonical authority without cluster provenance; do not
present them as observed output.
