# AgentOS benchmark profile

**Profile version:** 0.1.0
**Portable specification:** [`../../SPEC.md`](../../SPEC.md)

This profile maps the neutral benchmark to released AgentOS contracts. It does
not weaken the portable gates or turn benchmark evidence into another Fleet
authority.

## Role mapping

| Portable role | AgentOS role |
| --- | --- |
| Principal | Captain |
| Supervisor | First Mate, or a chartered Second Mate for its domain |
| Worker | Crewmate |

## Authority mapping

| Evidence concern | AgentOS authority |
| --- | --- |
| Human workflow and external intent | Captain-selected tracker or provider |
| Accepted work, ownership, handoff and decisions | PostgreSQL |
| Workload existence, readiness and failure | Kubernetes |
| Terminal process, harness state and native session reference | Herdr |
| Home, native session and unfinished workspace | Agent PVC |
| Delivered branch, commit and review artifact | Git and its remote |

Do not mirror these authorities into the evidence bundle continuously. Collect
the bounded events and stable references required by the selected scenario.

## Quickstart boundaries

AgentOS exposes two readiness moments:

1. A usable persistent First Mate with Herdr, Pi, retained home and working
   model authentication.
2. A coordination-ready Fleet after PostgreSQL migrations, Fleet identity and
   released authorization checks pass.

The Quickstart scenario continues through the first independently verified
review artifact. Neither readiness moment alone is an outcome success.

## AgentOS evidence

Use native interfaces and the exact selected AgentOS release:

- read Tasks, Assignments, Inbox, Captain decisions and Agent hierarchy with
  `psql` under the authenticated Fleet identity;
- inspect selected workloads with `kubectl` against the explicit context and
  namespace;
- inspect the exact Agent, pane and native session reference with Herdr;
- inspect worktree, commit, branch and diff through Git;
- resolve the remote review artifact through the project's selected provider
  tool;
- verify checks through the selected project delivery workflow.

The evaluator must not infer current workload or harness health from a database
status row. It must not infer landed delivery from a terminal claim or clean
worktree.

## Composition evidence

The portable
[`composition-integrity-recovery`](../../scenarios/composition-integrity-recovery/scenario.json)
scenario maps to AgentOS without making its manifest format part of the
portable core:

| Portable claim | AgentOS evidence |
| --- | --- |
| Accountable selection | The frozen `task_assignments.dispatch_profile`, owning Assignment and rendered brief |
| Exact selected context | The canonical manifest digest plus each selected material-directory digest |
| Origin identity | The manifest's non-secret origin kind, locator, revision and path, corroborated through the origin's native interface |
| Least context | The Assignment bundle contains only `manifest.json` and the selected material IDs; the native harness catalog resolves only those Assignment Skills while keeping separately reviewed project and release context distinguishable |
| Native application | Pod-side `composition-verify` succeeds with the brief's expected manifest digest, then the exact Pi launch paths or Codex Assignment-private discovery view are verified before harness launch |
| Loaded context | The exact Herdr Agent and native harness catalog/session show the role, project instructions and selected entrypoints in effect |
| Capability separation | Kubernetes, Mise, provider and credential authorities prove the actual command and permission boundary independently of the manifest |
| Truthful completion | The immutable Assignment report contains the worker's concise composition debrief or explicitly records that it was unavailable |

For a persistent First or Second Mate,
`agents.resolved_composition` is desired state, not activation evidence.
Successful replacement or repair also requires the Captain authority row,
change reason, retained prior manifest, native private-home state, safe harness
reload or resume evidence, and the Herdr-observed session. A row update or file
copy alone cannot pass.

The evaluator fails the AgentOS composition claim when selected material is
copied into the project worktree or persistent global discovery state; an
Assignment-private native discovery view contains an extra or wrong target; an
origin collision is resolved by path precedence instead of exact provenance; a
capability is inferred from a Skill; a harness starts before Pod-side digest
and native-catalog verification; a started brief or composition changes without
explicit handoff or repair; an unavailable external composer silently falls
back; or completed history is rewritten.

Self-report remains evidence rather than proof. When a bounded independent
session review is selected, retain only the allowlisted trajectory needed to
test a falsifiable claim. The review runs after the measured Assignment is
frozen, cannot change its history, and records unavailable loading or session
telemetry as `unobserved`.

An evidence-driven composition improvement names the frozen Assignment,
observable events, self-report agreement, exact owning origin and version,
smallest proposed change, Captain adoption boundary, original failing scenario,
held-out scenario and rollback version. Delivery uses the target origin's
native review workflow. Adoption affects future Assignments; a persistent Mate
uses its separately authorized safe application boundary. Prior Assignments
keep their original manifest and digest.

## AgentOS gates

In addition to the portable gates, fail the AgentOS profile when:

- delegated work begins before coordination and Fleet identity are verified;
- accepted work lacks an active `task_assignments` owner;
- a handoff rewrites ownership instead of preserving Assignment history;
- completed work lacks its required report or selected delivery artifact;
- First or Second Mate performs project implementation that its role requires
  it to delegate;
- a Crewmate writes outside its isolated worktree or granted project scope;
- a default branch is pushed or work is merged without exact authority;
- recovery creates a competing Agent, Task, Assignment, worktree or provider
  effect instead of preserving or handing off the existing work;
- a worker starts with an unverified, broadened or silently substituted
  Assignment composition;
- PostgreSQL, Kubernetes, Herdr, PVC, Git or the tracker is treated as a
  universal substitute for another authority.

## Optional session evidence

Pi native sessions may reveal tool names, sanitized arguments, error classes,
timings and retry relationships. Session inspection
requires the same authority as the underlying Agent home. Publish only the
minimum normalized action metadata needed for the metric or causal review.

The optional Pi-only adapter reads one explicitly selected native session in
Pi session format version 3 with the caller's existing filesystem authority
and writes its projection to standard output. It never discovers, edits or
replaces sessions:

```console
bun benchmarks/profiles/agentos/pi-session-adapter.ts \
  /authorized/agent/home/.pi/agent/sessions/<cwd>/<session>.jsonl \
  --actor <stable-agent-reference> \
  --accepted-work-reference <task-or-assignment-reference> \
  > pi-action-trajectory.json
```

Its [output contract](./pi-action-trajectory.schema.json) contains only native
tool-call and direct-bash timestamps, actor and accepted-work references, tool
names, canonical argument digests, native result classes, durations and exact
repeated-action retry links. Missing native fields are `unobserved`. Redaction
counts describe omitted prompts, reasoning, summaries, extension content,
assistant content, tool arguments and tool results. `retry_of` is the one-based
position of the latest equivalent failed event, `null` when there is none, or
`unobserved` when the arguments needed for comparison are unavailable.
For sessions with branch history, the final JSONL entry selects the active leaf
and only its validated parent ancestry is projected. The adapter fails closed
when its source-size, entry-count, event-count or text-length limits are
exceeded.
The projection does not contain the source session ID, path, working directory,
message text, result text or tool-call IDs.

Never publish raw reasoning, credentials, full private transcripts or unrelated
terminal output. When session access is unavailable, mark its dependent metrics
`unobserved`; outcome, ownership, recovery and delivery gates still apply.

## Live evaluation

First Mate may initiate an evaluation after completed real work as Fleet
coordination. It may delegate detailed diagnosis to a bounded Scout after the
evidence is frozen. Live evaluation does not inject faults, interrupt work,
change instructions or store benchmark analytics in the Fleet database.

Official AgentOS result manifests live under
[`../../results/agentos/`](../../results/agentos/) only after real runs satisfy
the portable reporting rules and reference immutable evidence artifacts.
