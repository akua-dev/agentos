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

### Hierarchy reporting after wake

For the portable hierarchy-reporting scenario, map the coordination listener
to `pg-listen agentos_events`, durable hierarchy reports and parent requests to
PostgreSQL Inbox, and the native child-status predicate to an exact-child Herdr
wait. Use `psql` plus `agentos.can_manage_task` to distinguish globally readable
foreign state from manageable domain state. Correlate Pi custom-message
provenance and bounded Herdr terminal output to distinguish a background
completion from supported direct Captain intervention.

Run the foreign-listener, owned-child-status and direct-Captain cases from
three separately reset disposable Fleet states. For the owned-child-status
case, retain the background-command task IDs and condition-specific
descriptions needed to prove that the tagged PostgreSQL continuity listener
and every still-useful exact-child status wait were re-armed after the
one-shot completion. Evidence of the global listener does not substitute for
the exact-child wait, and database status text does not prove a Herdr
transition.

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
