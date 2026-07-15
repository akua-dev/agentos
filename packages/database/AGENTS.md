# AgentOS database package contract

This package is SQL-first. Read the architecture section in `../../README.md` and preserve the database boundary defined there.

## Source of truth

- Files under `migrations/` are the only database schema and security authority.
- Define tables, indexes, constraints, roles, grants, RLS policies, Functions and Triggers in reviewed SQL.
- Keep `drizzle.tooling.ts` empty. It exists only because Drizzle Kit requires a schema path for custom migration creation.
- Do not add Drizzle ORM schemas, generated TypeScript schemas, database clients or CLI database dependencies without a separate approved design.

## Initial data-model boundary

- One PostgreSQL database is one Fleet. Do not add `fleet_id` columns to core tables.
- Keep released objects in `agentos`. First Mate may experiment in `local`, but released migrations must not adopt those objects without review.
- Keep external tracker links in `tasks.external_links`; do not introduce a link table until measured behavior requires one.
- Preserve accepted provider payloads intact in `external_events.payload`. The same event rows own their small burst, claim and reconciliation state; do not add a reconciliation table or background outbox.
- Agents invoke provider CLIs directly and synchronously. PostgreSQL coordinates durable local state but does not hide provider failures behind a service.
- Never hold a transaction open while a model reasons or a provider command runs. In the final short transaction, mutate coupled Tasks and Inbox rows and call the released claim-completion Function so stale work rolls back atomically.

## Migration workflow

- Prepare the pinned migration tooling outside the immutable image with `mise run database:prepare`. The task installs only `@agentos/database` production dependencies from the reviewed `bun.lock` into a content-addressed directory on the agent PVC and prints that package path.
- Create new entries with `bun run migration:new -- --name <name>`, then edit the generated SQL migration.
- Let Drizzle Kit maintain migration filenames, ordering metadata and the applied-migration journal.
- Never use `drizzle-kit push`, `pull`, or non-custom `generate` in this package.
- Treat released migrations as immutable. Fix later behavior with a new forward migration; do not rewrite applied history or improvise destructive down-migrations.

## Safety and verification

- Inspect read-only first and ask before credentials, database creation, role or grant changes, or migration application.
- Receive `DATABASE_URL` only through an approved secret source; never commit, print or copy credentials into commands that will persist in shell history.
- Use transactions where PostgreSQL permits them.
- Test migration, constraint, Trigger and Function behavior against the package's in-memory PGlite database instead of inspecting SQL source text for strings.
- When grants, RLS or multi-connection concurrency are introduced, additionally test their allowed and forbidden paths against a real PostgreSQL server; PGlite does not replace that release gate.
- Apply only migrations from one reviewed immutable AgentOS release and report the first unverified boundary on partial failure.
