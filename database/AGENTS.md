# AgentOS database package contract

This package is SQL-first. Read the database boundary in `../ARCHITECTURE.md`
and preserve it.

## Source of truth

- Files under `migrations/` are the only database schema and security authority.
- `kubernetes/cloudnative-pg/` owns only the optional self-hosted PostgreSQL
  topology. It must not redefine SQL semantics, credentials, controller
  installation policy or third-party version selection.
- Define tables, indexes, constraints, roles, grants, RLS policies, Functions and Triggers in reviewed SQL.
- Keep `drizzle.tooling.ts` empty. It exists only because Drizzle Kit requires a schema path for custom migration creation.
- Do not add Drizzle ORM schemas, generated TypeScript schemas, database clients or CLI database dependencies without a separate approved design.

## Initial data-model boundary

- Require a verified AgentOS PostgreSQL schema before accepting durable Fleet
  work or delegating an Agent. The bootstrap runtime may exist first, but do not
  create a tracker-, file- or transcript-backed fallback coordination mode.
- One PostgreSQL database is one Fleet. Do not add `fleet_id` columns to core tables.
- Keep released objects in `agentos`. First Mate may experiment in `local`, but released migrations must not adopt those objects without review.
- Keep external tracker links in `tasks.external_links`; do not introduce a link table until measured behavior requires one.
- Keep raw model reasoning, harness transcripts and terminal output in their
  runtime authorities. Store only durable coordination in Task, Assignment and
  Inbox rows; do not market released tables as a complete forensic audit log.
- Keep ordinary communication in Task and Assignment state. Inbox stores only
  durable speech acts that state cannot express. Its closed `kind` vocabulary
  belongs to one released migration; Skills must reference it rather than
  defining aliases.
- Permit Agent-authored Inbox delivery only across one direct parent-child
  hierarchy edge. Cross-domain work must escalate to the common ancestor for
  Task creation or routing; do not add a lateral-message exception.
- Preserve `agentos.receive_inbox` as the idempotent recipient-owned boundary
  that returns the delivery while setting `read_at` atomically. First Mate keeps
  owner-level administrative repair; no ordinary sender or unrelated Agent may
  acknowledge another recipient's row. `read_at` means loaded into model
  context, `resolved_at` means handled, and read-but-unresolved rows remain
  actionable after recovery.
- Keep Captain decisions in Inbox with stable `decision_key` values and Task
  dependencies in `tasks.dependencies`; do not introduce a decisions table.
- Treat `agentos.resolve_captain_decision` as the reference contract for any
  future speech act with a state effect: one released idempotent Function must
  record the response, close the delivery and apply the coupled state mutation
  in one short transaction.
- Keep the complete Assignment brief, final or handoff report, concrete dispatch
  profile and append-only handoff history in `task_assignments`.
- Keep Agent- and Assignment-scoped composition on the shared versioned
  manifest contract. Freeze the Assignment brief and composition at execution
  start, block active harness drift, and expose only the released reasoned
  First-Mate repair for corrupt active dispatch data; completed history remains
  immutable. Keep persistent replacement or repair behind the released
  Captain-authorized Functions. PostgreSQL records desired composition and the
  immediate rollback manifest; native harness state remains observed authority.
- Preserve accepted provider payloads intact in `external_events.payload`. The same event rows own their small burst, claim and reconciliation state; do not add a reconciliation table or background outbox.
- Keep `agentos_events` notifications as small transactional wake hints only.
  Never put row contents, credentials or durable delivery state in a payload;
  listeners must query authorized Fleet rows after wake.
- Agents invoke provider CLIs directly and synchronously. PostgreSQL coordinates durable local state but does not hide provider failures behind a service.
- Treat the selected tracker as the human workflow surface. Its changes remain
  external intent until an authorized Mate reconciles them; never make provider
  state a second Fleet authority.
- Never hold a transaction open while a model reasons or a provider command runs. In the final short transaction, mutate coupled Tasks and Inbox rows and call the released claim-completion Function so stale work rolls back atomically.
- Apply migrations as the login that owns the released AgentOS tables. The migration chain creates or adopts the single active root First-Mate row and binds it to that same Fleet owner; do not introduce a separate migrator or manual First-Mate mapping. Bind every other Agent only to an already-created, non-privileged login. Migrations never create login roles or contain credentials.
- Give every active registered Agent the same unfiltered `SELECT` view across released Fleet tables; never hide rows by role or hierarchy. Keep mutations deny-by-default. Mates may create and assign Tasks inside their managed hierarchy; assigned Crewmates may change only work-state columns. Any additional table or column needs a reviewed write policy first.
- Scope Captain rows as Fleet-wide or Mate-domain context without hiding them
  from the shared read view. First Mate administers Fleet scope; a Second Mate
  may mutate only its own domain scope.
- Preserve completed Assignment history. Retirement must reject active Assignments and active child Agents; never cascade or invent a handoff.
- Bind external reconciliation to the authenticated `session_user`. Only First and Second Mates receive the claim Functions, and direct runtime updates to external-event coordination columns stay forbidden.
- Preserve First Mate's owner-level administration of the Fleet. Do not grant `SUPERUSER`, `CREATEDB`, `CREATEROLE` or `BYPASSRLS` merely to administer AgentOS.
- Keep child identity creation behind `agentos.provision_agent`: First Mate may
  create direct Second Mates or Crewmates, Second Mate only direct Crewmates,
  and exact retries must return the same UUID while conflicting handles fail
  closed. Principal creation, credentials and runtime provisioning stay
  separate approved operations.
- Preserve `session_user` as the authorization identity. Never replace it with a caller-controlled session setting or infer it from prompts, process metadata or Kubernetes labels.

## Migration workflow

- Prepare the pinned migration tooling outside the immutable image with `mise run database:prepare`. The task installs only `@agentos/database` production dependencies from the reviewed `bun.lock` into a content-addressed directory on the agent PVC and prints that package path.
- Create new entries with `bun run migration:new -- --name <name>`, then edit the generated SQL migration.
- Let Drizzle Kit maintain migration filenames, ordering metadata and the applied-migration journal.
- Never use `drizzle-kit push`, `pull`, or non-custom `generate` in this package.
- Treat released migrations as immutable. Fix later behavior with a new forward migration; do not rewrite applied history or improvise destructive down-migrations.

## Safety and verification

- Inspect read-only first and ask before credentials, database creation, role or grant changes, or migration application.
- Receive `DATABASE_URL` only through an approved secret source; never commit, print or copy credentials into commands that will persist in shell history.
- Preserve the explicit in-memory PGPASSFILE resolution in
  `drizzle.config.ts`; do not fall back to `pg`'s deprecated implicit pgpass
  lookup or place a password in a command argument.
- Use transactions where PostgreSQL permits them.
- Test migration, constraint, Trigger and Function behavior against the package's in-memory PGlite database instead of inspecting SQL source text for strings.
- Test Grants and RLS through real role changes and allowed and forbidden SQL paths in PGlite. Do not add Docker-backed database tests without a concrete behavior that PGlite cannot exercise.
- Apply only migrations from one reviewed immutable AgentOS release and report the first unverified boundary on partial failure.
