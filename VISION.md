# Vision

**Software companies will run themselves. Someone has to build the operating
system for that. This is it.**

## The bet

Agents stopped being autocomplete a while ago. They plan, they ship, they
review each other's work. What they don't have is a place to *live*. Every
session starts from zero. Every orchestrator hides them behind a dashboard.
Every framework wraps Postgres in an API and Git in a queue and calls it
infrastructure.

We think that's backwards. Agents don't need a better chat window. They need
what every employee needs: an identity, a home directory that survives the
night, a boss who checks in, a database they can query, and real consequences
when they merge.

AgentOS is that. A crew, not a swarm. A Captain who decides, a First Mate who
runs the fleet, Crewmates who do bounded work and then go away. Everything
that coordinates the fleet lives in PostgreSQL. Everything running lives in
Kubernetes. Everything shipped lives in Git. The tracker people already use
remains their planning surface. Nothing pretends to be the other thing.

This is a lineage, not an invention. Pi — the harness our Mates run on —
proved it at the agent layer: a tiny, inspectable loop, a handful of tools,
and everything that needs judgment left to the model. AgentOS is the same
philosophy one layer up. Pi harnesses a model into an agent; AgentOS harnesses
agents into a company. The atom changes — Pi's is the turn, ours is the
Assignment: one outcome bound to one accountable owner — but the rule doesn't:
the substrate stays small and legible, and the judgment stays in the model.

## Assistants, workers, companies

OpenClaw, Hermes Agent and AgentOS are close relatives, but they begin at
different layers. OpenClaw begins with a personal agent: workspaces, sessions,
channels, scheduled turns and background tasks around the people it serves.
Hermes begins with a durable, self-improving agent: memory, skill creation,
automations and subagents deepen what that agent can do. AgentOS begins with
the organization. Its unit is the Assignment — one bounded outcome tied to an
accountable owner, a durable brief, a report and a chain of authority. An empty
queue is healthy; accepted work and real events create demand.

The higher-stakes layer changes the trust posture. OpenClaw and Hermes make
skill discovery and installation part of their product. AgentOS keeps
Fleet-operating skills in reviewed Git and pins executable tools and images.
Every authenticated Agent is bound to a PostgreSQL identity and RLS limits
what it can mutate; role contracts require Captain approval or an exact
durable standing authorization before consequences. Extensibility is not the
problem; unreviewed authority is.

They compose rather than compete. A personal assistant can be a front door for
the Captain. A self-improving worker can become a verified Crewmate harness.
Pi harnesses a model into an agent. Personal-agent systems connect an agent to
your life. AgentOS harnesses agents into a company.

## What we believe

- **The model is the decision-maker.** Code in this repo is deterministic
  mechanics only. If a workflow needs judgment, it's written in prose and given
  to a model — not compiled into a state machine that's wrong by Thursday.
- **Boring technology wins.** Postgres, Kubernetes, Git, a terminal. No new
  database. No CRDs. No message bus. Agents run `psql` and `kubectl` like
  adults.
- **You should be able to watch.** Every agent has a real terminal you can
  attach to mid-thought. An orchestrator you can't attach to is a liability
  with a status page.
- **Persistence is the product.** Disconnect, redeploy, lose a pod — the
  agent's home, its unfinished work, its session come back. Amnesia is not a
  feature.
- **Pull beats interruption.** Important work is durable and discoverable.
  A signal may wake an agent, but the responsible agent decides what to read
  and when to act.
- **One honest source of truth per concern.** Truths get connected, not copied
  into a proprietary world model that drifts from reality.
- **Core owns guarantees; integrations own workflows and surfaces.** Ownership,
  authority, atomic handoff and decision gates belong to the coordination
  kernel. Trackers, delivery workflows, harnesses and models stay replaceable.
- **Humans own judgment, not toil.** Approvals, credentials, cost, merges —
  the Captain. Everything else — the crew.

## What we refuse to build

No wrapper APIs over native Fleet authorities. No heartbeats. No autonomous
schedulers inventing work at 3am. No agent that quietly retires another
agent's unfinished business. Every one of these is a way to hide failure, and
hidden failure is how you learn to distrust your own fleet.

Also not on the list: a chatbot with nautical branding; a visual workflow
builder that makes humans pre-plan every agent step; a giant universal agent
image containing every possible tool; a stream of notifications pretending to
be coordination; enterprise-scale abstraction before one real company loop
works beautifully.

This list is a guardrail, not doctrine. Strong evidence can change it. Fashion
cannot.

## The company operating system

Call it a six-pager, a DRI, an OKR, a client brief or a Slack thread. Strong
organizations repeatedly make the same load-bearing moves: turn intent into
bounded outcomes; name one accountable owner; delegate outcomes and
constraints rather than keystrokes; escalate exceptions and consequences; and
preserve what the organization learns. Vocabulary and ceremony vary, but
ownership, authority and memory remain the questions underneath. Status
meetings, handover documents and planning rituals can be useful; they also
compensate for scarce attention, lossy memory, state that is hard to query and
ownership that drifts.

AgentOS keeps the disciplines and makes their mechanics durable. An Assignment
binds an outcome to an Agent, a complete brief and a required final or handoff
report. Completed Assignments are immutable; a handoff ends one and creates
its successor for the same Task in one transaction. RLS enforces mutation
scope. Captain decisions are durable, and role contracts require explicit or
standing authority before consequences. Sparse reporting and real wake signals
replace hovering. Purpose, taste and ultimate accountability remain human.

- The Captain owns purpose, risk and consequential decisions.
- First Mate owns the truthful company view and the quality of coordination.
- Second Mates own clearly chartered domains, not arbitrary slices of a queue.
- Crewmates own bounded outcomes, not permanent seats in a swarm.
- Work has one accountable owner and a clear path upward.
- Human intent may arrive through any chosen tracker; accepted work becomes a
  Task and Assignment before the company acts on it.
- Real-world signals feed the next decision and the next product improvement.

Humans should not have to supervise a wall of chats. Agents should not compete
to be the loudest process. The organization knows what is active, what is
blocked, what was learned and what needs the Captain.

## What good looks like

- You leave, return and continue with the same company — not reconstruct it
  from transcripts.
- You ask for an outcome once and can see who owns it, why it matters and what
  happened.
- You can trace human intent through its Task and Assignment history to the
  delivered commit or pull request and reconciled tracker state without
  reconstructing the company from transcripts.
- Several products and investigations move at once without losing
  responsibility.
- An agent failure is visible and recoverable instead of silently replaced by
  a fresh amnesiac session.
- Customer, product and operational feedback becomes owned work rather than
  notification noise.
- The company accumulates useful judgment instead of repeating the same
  explanation in every prompt.
- You remain in control without becoming the message bus.

## Where this is

Early. The First Mate boots, establishes its database before it accepts
delegated Fleet work, provisions crew, and supervises with real wake-ups instead
of polling. The bootstrap is one prompt you paste into any coding agent. The
first immutable release and public bootstrap, delivery and recovery evidence
exist; one proven Fleet is not yet broad production maturity. The remaining gap
closes in public.

The current focus is adoption: make first contact and Captain communication
obvious; make team-owned provider identity and worker capacity predictable;
and prove a live Fleet operating real company work. The deeper product loop
remains the same: persistent Second Mates for real domains, external signals
becoming owned work, and more verified working-agent choices without weakening
authority or visibility.

## Open source and Akua

AgentOS must be useful on its own. A developer should be able to understand it,
run it, change it and keep control of the company it creates.

Akua is the factory layer above it: AgentOS harnesses agents into a company;
Akua harnesses companies into a portfolio. It can make the infrastructure,
access and fleet overview easier, but it must not turn AgentOS into a demo
client for a closed service. The open project proves the operating model; Akua
makes it effortless to adopt.

## The endgame

You state an intent. The fleet organizes the work, builds the thing, watches it
run, hears the users, and comes back with the next reviewed change — and the
only meetings left are the decisions that were genuinely yours. For a founder,
that's a company that happens to have one human in it. For an existing team,
it's the end of the orphaned-session sprawl: agents that work for weeks,
orchestrated and owned, inside an organization that can always say who is doing
what and why.

Every meaningful change here answers one question: does this help a small
number of humans lead a larger, more capable and more trustworthy agent
organization? If the answer is unclear, it doesn't belong in the core.

Come build it, or fork it and prove us wrong. Both help.

---

Orientation: [`README.md`](./README.md). Implementation boundaries:
[`ARCHITECTURE.md`](./ARCHITECTURE.md). Contributing:
[`CONTRIBUTING.md`](./CONTRIBUTING.md).
