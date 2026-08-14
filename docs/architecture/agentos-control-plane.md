# AgentOS Control Plane — Hermes, Access Proxy and Remote Subagents

> **Status:** Draft — one consolidated review document.
> **Decision authority:** Robin / Akua architecture review.
> **Source status:** This document defines the proposed Akua reference-stack integration. It is not an implementation, deployment, migration, approval, or production authorization.

## 1. Decision requested

Accept or request changes to this unified direction:

```text
Hermes First-Mate plus Hermes Kanban is the recommended Akua reference starting
point for a company.

Each deployment selects exactly one durable custody authority for Task and
Assignment intent, human gates, dispatch, retry, interrupt, result review,
acceptance, settlement and cleanup. In the current Akua reference stack that
authority is Hermes Kanban. A future replacement is possible only by an
explicitly selected implementation that preserves the same custody guarantees;
parallel or shadow custody is prohibited.

AgentOS provides the runtime/access substrate: Kubernetes execution, workload
identity, bounded policy/capability mediation, protocol-aware service adapters,
credential isolation, budgets and secret-free audit evidence.

Every governed remote service is reached through the AgentOS Access Proxy. An
internal Git service is an optional backend behind that Proxy, never a parallel
Pod access path.
```

The document intentionally keeps the system in one place while decisions are
fluid. Every accepted modification is made as a commit to this same Draft PR
until the whole direction is ready for final review.

## 2. Accepted decisions

### AD-1 — Selected custody boundary — **Accepted 2026-08-14**

> Each Akua deployment selects exactly one durable work/acceptance custody
> authority. Hermes First-Mate/Kanban is the recommended reference
> implementation, not a technically mandatory forever-only implementation. A
> replacement requires explicit selection and equivalent Task, evidence,
> human-gate and recovery guarantees. AgentOS owns no parallel Task,
> Assignment, Result, Retry, Approval or Acceptance control plane; Kubernetes
> owns execution and technical enforcement, not business completion or Task
> acceptance.

### AD-3 — A2A transport boundary — **Accepted 2026-08-14**

> A2A is an outer remote-agent transport/delegation boundary for messages,
> steering, status and artifact references. It is never a second durable truth
> for task lifecycle, approval, session, retry or acceptance.

### AD-4 — Worker capability boundary — **Accepted 2026-08-14**

> A remote worker may work broadly and autonomously inside its isolated
> environment to the full extent of its explicit Assignment and technical
> capabilities. This does not grant custody, broad credentials, merge, release
> or production authority.

For the live status, exact evidence and remaining choices, see the
[reference-stack decision register](./agentos-reference-stack/review/decision-register.md).

## 3. Scope and non-goals

### In scope

- Hermes as the current, configurable First-Mate profile in AgentOS.
- Remote subagents/harnesses, including Codex in Kubernetes.
- A2A as a candidate communication transport between Hermes and independent
  remote-agent harnesses.
- Artifact-/workspace-based context rather than large prompt dumps.
- AgentOS Access Proxy routes for Git Smart HTTP, GitHub API, internal Git,
  CRM and later reviewed services.
- Kubernetes workload identity, admission, RBAC, NetworkPolicy, egress,
  credential isolation and failure behavior.
- Git candidate delivery, Draft PR creation, review and promotion boundaries.

### Explicit non-goals

- A universal transparent `HTTP_PROXY`/`HTTPS_PROXY`, TLS interception or an
  all-traffic CONNECT proxy.
- A shared all-provider credential vault or credential-returning API for Pods.
- An AgentOS Task/Assignment scheduler, result store, retry engine, approval
  store or acceptance database beside the selected custody authority.
- Direct Kanban, Discord, GitHub App or broad Kubernetes credentials in a
  remote worker.
- Implementing, deploying, migrating, deleting or merging any component from
  this document.

## 3. Authority model

| System | Owns | Does not own |
|---|---|---|
| Human / Captain | purpose, risk, consequential approval and ultimate accountability | operational toil or per-request credentials |
| Selected custody authority (Hermes First-Mate/Kanban in the current reference stack) | work selection, Assignment intent, human gates, dispatch decision, retry, interrupt, result review, acceptance, settlement and cleanup decision | provider credentials in workers; Kubernetes as a business completion oracle |
| AgentOS Access Plane | runtime integration, identity verification, bounded grants, route policy, credential mediation, budgets and security audit evidence | Task ownership, acceptance, human approval, retry or result truth |
| Kubernetes | workload execution, admission, RBAC, network enforcement, resource limits and workload identity issuance | Task completion or product acceptance |
| Remote subagent | bounded code/research/test execution, checkpoints and evidence | global custody, merge, release, deployment, direct provider administration |
| Git / GitHub / internal Git | source history, candidate refs, PR and CI evidence | Task acceptance, human approval or production rollout |

```text
Pod Ready / exit 0 / Job complete / A2A event / CI green / PR created
≠ accepted Task
```

## 4. Hermes belongs in the AgentOS reference stack

AgentOS includes a recommended Hermes First-Mate integration rather than
pretending every company should use an identical agent configuration.

```text
AgentOS reference profile
├─ Hermes First-Mate
│  ├─ human/chat interface
│  ├─ Kanban custody and review
│  ├─ company skills and system instructions
│  └─ delegation to bounded remote agents
├─ AgentOS runtime/access substrate
└─ Kubernetes execution and enforcement
```

Each company must be able to customize its own Skills, system instructions,
policies, integrations and learned operating practice. That customization must
not create a second custody plane. Hermes is replaceable only through a
conscious replacement of the same custody interface and review boundary; AgentOS
PostgreSQL Assignment state is not a fallback.

## 5. No AgentOS Assignment/PostgreSQL control plane in the Akua path

Some existing AgentOS material describes durable Assignment/PostgreSQL
coordination. That model is not used for Akua remote subagents.

```text
Akua target

Hermes Kanban (the current selected reference custody)
  = durable Task / Assignment / approval / dispatch / retry / result /
    acceptance / settlement / cleanup authority for this deployment

AgentOS
  = identity / policy / capability route / runtime / credential mediation /
    budget / secret-free audit evidence
```

This is an integration boundary, not an instruction to delete existing AgentOS
source. Removal or repurposing of any present AgentOS Assignment/Postgres
component requires a separate accepted implementation decision, exact source
inventory, migration/recovery plan and review.

## 6. System context

```text
Humans / Discord / other approved chat surfaces
                  │
                  ▼
      Hermes First-Mate and Kanban custody
                  │
     Assignment + explicit bounded access intent
                  │
                  ├─────────────────────────────┐
                  ▼                             ▼
     AgentOS Access Proxy                 Remote subagent communication
     identity / grant / route             A2A + artifacts + checkpoints
                  │                             │
                  ▼                             ▼
     protocol-aware adapter               Codex or other approved harness
     GitHub / Git / CRM / APIs             in a bounded Kubernetes workload
                  │                             │
                  └───────────────┬─────────────┘
                                  ▼
                   evidence, candidate ref, artifacts, status
                                  │
                                  ▼
                 Hermes review / accept / block / retry / cleanup decision
```

## 7. Access Proxy

### 7.1 Definition

The **AgentOS Access Proxy** is the common capability, workload-identity and
route-policy contract through which a remote worker reaches a governed service.
It is not required to be one binary or one credential domain.

```text
Pod workload identity + task/run-bound access intent
                    │
                    ▼
        canonical closed capability evaluation
                    │
                    ▼
      short-lived, revocable closed grant
                    │
                    ▼
  Access Proxy route / protocol-aware PEP
                    │
                    ▼
 domain adapter or broker with only its own upstream credential
                    │
                    ▼
       GitHub / internal Git / CRM / other approved service
```

### 7.2 Capability shape

The capability contract is closed, typed and intentionally lacks arbitrary URLs,
wildcards, CEL fragments, arbitrary request payloads or token return values.

| Field | Meaning |
|---|---|
| subject | exact authenticated Pod workload identity |
| task/run reference | correlation to the Hermes-authorized bounded execution |
| resource | typed named resource: repository/ref, GitHub route, CRM object/field set, internal service |
| action | finite reviewed operation for that resource |
| constraints | protocol-aware limits: ref, HTTP method/route, request schema, record/field scope |
| policy revision | exact policy/capability version used for the grant |
| expiry/revocation | short lifetime and immediate fail-closed behavior after invalidation |
| correlation | secret-free evidence link to Assignment/run and adapter result |

A capability only gives technical access. It never replaces business approval:
customer-impacting CRM writes, outreach and other external effects retain their
applicable Hermes Assignment and human gates.

The Access Plane validates a selected-custody-issued, expiring authorization and may
retain only bounded technical policy, revocation, budget and secret-free audit
evidence. It must not persist a remote-run ledger, derive lifecycle transitions,
infer a retry, or treat adapter settlement/result evidence as Task acceptance.
The selected custody authority remains the only durable interpretation of a
task/run reference; Hermes Kanban fills that role in the current reference
stack.

### 7.3 Common contract, separate adapters

```text
One common caller/grant/route contract
≠ one all-credential process
```

Each adapter has its own credential, protocol parser, error contract, deployment
lifecycle and narrow blast radius.

| Adapter | Backend | Primary constraint |
|---|---|---|
| GitHub adapter | GitHub REST, GraphQL and Smart HTTP | repository/action; worker write remains disabled until task-bound ref restriction is proven |
| internal Git adapter | self-hosted Git service/forge | repository/fork/ref ACL and candidate-source custody |
| CRM adapter | approved CRM API | account/object/field/action scope plus human/CRM gates |
| AI provider adapter | approved provider or Fleet AI Gateway | model/account/budget policy; no worker provider credential |
| future adapter | named reviewed service | separately defined protocol, failure and authorization contract |

### 7.4 Network and bypass boundary

Every **governed service capability** uses an explicit Access Proxy route. A
client that can configure a base URL/host uses the route directly; a native
client such as `git`/`gh` needs a reviewed adapter.

A global transparent HTTP proxy remains out of scope. If a remote-worker class
must be technically unable to make direct unauthenticated requests to a named
governed domain, that requires a separate NetworkPolicy/CNI/FQDN-egress design
and proof. The current design does not claim that generic Internet egress alone
is sufficient non-bypass enforcement.

## 8. Reconciliation with existing AgentOS access-plane work

Fresh source inspection of `akua-dev/agentos` `origin/main` at
`a30d855b06853c98477c6121238e4202e3b0b26a` found these components:

| Existing component | Reuse in this direction | Required reconciliation |
|---|---|---|
| `agentgateway` | protocol-aware PEP immediately before governed backends | do not turn it into a universal transparent proxy |
| `agentos-egress-authz` | TokenReview/current-workload-policy/budget authorizer and closed-grant source | document one canonical policy path before generic capability expansion |
| `github-broker` | GitHub credential adapter; only workload allowed to hold GitHub App key | prove assignment-bound Git Smart HTTP ref restrictions |
| `openfga` / access control | possible finite capability/policy substrate | reconcile current source wording with modern egress-authorizer direction |
| Fleet AI Gateway / A2A | examples of protocol-/domain-specific delivery boundaries | retain separate credential and authority boundaries |

The existing GitHub path is evidence for the intended credential boundary:

```text
native git / gh / gh-axi
→ projected ServiceAccount token
→ agentgateway-github
→ closed grant
→ GitHub broker
→ GitHub REST or Smart HTTP
```

It proves worker credential isolation and repository-bound GitHub token minting.
It does **not** yet prove a task-specific `git-receive-pack` ref restriction
inside Git protocol payloads.

A current narrow source-only cleanup candidate removes obsolete OpenFGA inputs
from modern `egress-authz`, but it is awaiting a fresh independent exact-head
review. It is not treated here as merged, deployed or accepted. General
OpenFGA/A2A behavior is outside that candidate's bounded scope.

## 9. Git and source delivery

### 9.1 Target worker delivery path — not yet enabled for GitHub writes

```text
Remote code worker
→ Access Proxy
→ selected Git backend
→ candidate commit/ref
→ selected custody validates evidence and source state
→ Access Proxy
→ GitHub task branch + Draft PR
→ normal code review / CI
→ separately authorized merge
```

The remote worker returns a small structured result, not a code dump:

```text
candidate repository/ref
head commit SHA
base SHA
executed tests and outcome
PR URL when one exists
checkpoint/artifact references
blockers or requested steering
```

### 9.2 Worker rights and write gate

| Action | Remote worker | Hermes First-Mate |
|---|---|---|
| read approved source/dependency repo | only through Proxy capability | yes, through reviewed access path |
| GitHub-backed candidate write | **disabled** until protocol-aware or backend-native task/run/ref enforcement passes adversarial review | decides whether a verified candidate is promoted |
| internal-Git candidate write | **disabled** until its exact per-assignment repository/fork/ref ACL is implemented and adversarially verified | decides whether a verified candidate is promoted |
| force push / tags / hooks / server admin | no | no unless separately authorized admin operation |
| create/update Draft PR | **disabled** for remote workers until the corresponding write/ref gate is accepted | may promote and create/update exact verified candidate PR |
| merge / release / deployment | no | separate review and applicable authorization only |
| GitHub App credential | never | normal path remains mediated; privileged exception stays First-Mate-only |

The future worker-write acceptance condition is not satisfied by a
repository-scoped GitHub App token. It requires a verified path that rejects a
forged or unintended ref update before the backend accepts it, binds the exact
repository/fork/ref to the Hermes-authorized task/run, and preserves that
binding through retries and restarts. Until then a remote worker is read-only;
candidate publication and Draft-PR creation remain First-Mate operations.

### 9.3 Git backend choice

The proxy route does not force a company to choose one Git backend:

```text
GitHub only
or internal Git only
or internal candidate Git + GitHub promotion
```

All worker access remains `Pod → Access Proxy → backend`. An internal Git
service is valuable for per-assignment forks, native ref ACLs, candidate
recovery and GitHub-outage tolerance; it adds an operational responsibility for
backup, retention, authorization and recovery. It never becomes a Task or
approval system.

## 10. Remote subagents and A2A

The product model is:

```text
Selected Parent-Agent / custody (Hermes Kanban in the reference stack)
→ Remote Child-Agent in Kubernetes
```

This is not equivalent to a local short-lived subagent process. A2A is the
candidate conversation/transport layer across process, machine and harness
boundaries. The selected custody authority remains durable; Hermes Kanban is
the current reference implementation.

### 10.1 Existing AgentOS A2A service is excluded from the Akua remote-worker path

The existing `agentos-a2a` service is intentionally **not** the Akua remote
subagent adapter. Its current contract is coupled to AgentOS PostgreSQL Inbox,
Task and Assignment records, verifies active AgentOS Assignment state, and
uses that state for delivery. Connecting a remote Akua worker to it would create
the prohibited second custody path.

```text
Akua remote worker must not call:
  agentos-a2a
  AgentOS PostgreSQL
  AgentOS Task / Assignment / Inbox APIs

Any future Akua A2A adapter must be stateless with respect to custody:
  it validates only bounded selected-custody-issued references/capabilities,
  transports communication/artifacts,
  and never creates, verifies or advances AgentOS Task/Assignment/Inbox state.
```

### Context and artifacts

```text
Repository/workspace needed for work
→ materialize an authorized checkout/workspace in the workload

Large document, checkpoint, test artifact or bundle
→ A2A Artifact with URL/provenance/digest where supported; retrieval uses a
  named Access-Proxy artifact capability route

Small self-contained file
→ bounded A2A raw artifact only where implementation supports it

Status, question, steer, block
→ small structured A2A message/data
```

Large bytes are not inserted into prompts by default. Every artifact route needs
access control, integrity/provenance, retention, revocation and redaction rules.
Bearer credentials, signed URLs and credential-bearing query strings must not
appear in A2A messages, artifacts, task evidence or telemetry. No secret belongs
in an A2A artifact, A2A message, task evidence or telemetry.

### Lifecycle

| Stage | Remote child may do | Selected custody must decide |
|---|---|---|
| start | read materialized authorized inputs | whether to dispatch |
| progress | report bounded status/checkpoint | whether to continue/steer |
| question/block | request missing authorized context | Kanban comment/block and human escalation |
| candidate | test and prepare evidence; publish only after the relevant write/ref gate is accepted | whether evidence is sufficient |
| result | return PR/ref/test/artifact evidence | accept, request review, retry or block |
| interrupt/cleanup | stop cooperatively and publish final evidence | durable interrupt/retry/cleanup decision |

A Pod surviving a parent/custody restart is execution evidence. Recovery must
reconcile the live workload, exact candidate source, Artifact availability and
selected-custody intent before any resume, retry, cleanup or acceptance action.

## 11. Kubernetes and credentials

Kubernetes is the non-bypass technical security boundary for workload shape:

```text
ValidatingAdmissionPolicy / admission
RBAC
Pod Security Admission
NetworkPolicy and selected egress controls
ResourceQuota / LimitRange
projected audience-bound ServiceAccount identity
```

Hermes can express workload needs and the cluster rejects unacceptable workload
shapes. A remote worker receives only its narrow Workload Identity; no Kubeconfig,
Kanban credential, Discord access, GitHub App identity or broad cluster RBAC is
introduced.

Credential values remain in dedicated credential-domain components. The Access
Proxy verifies identity and injects/uses upstream authentication internally; it
never returns a reusable provider token to the workload.

## 12. Failure and adversary requirements

No implementation is accepted without an adversarial matrix covering at least:

| Failure / attack | Required property |
|---|---|
| forged Pod labels/header/task ID | cannot establish identity or authority |
| wrong audience / replaced Pod or ServiceAccount | TokenReview/live-object verification fails closed |
| stale/revoked policy or expired grant | no forwarded provider request |
| replayed grant/result/checkpoint | canonical run/capability binding rejects it |
| branch/ref escape | denied by protocol-aware or backend-native enforcement |
| direct governed-service bypass | explicit egress/adapter policy result, never assumed away |
| GitHub/internal Git/CRM outage | no credential fallback or false success; candidate/evidence preserved |
| Hermes crash with live Pod | reconcile before resume/retry/cleanup/acceptance |
| A2A outage | no loss of Kanban custody; checkpoint/result handling remains bounded |
| call to AgentOS A2A/Task/Assignment/Inbox path | denied for Akua remote workers; no shadow custody path |
| forged PR/CI/exit success | evidence is reread against exact source and Assignment intent |
| secret/prompt/payload in logs/artifacts | rejected/redacted before durable evidence/export |
| CRM/outbound write | applicable human and CRM gates remain binding |

## 13. Open decisions requiring explicit review

The [reference-stack decision register](./agentos-reference-stack/review/decision-register.md)
is the canonical status/count source. The current six open decisions are:

1. What provider-neutral custody interface and equivalence proof are required
   before a future Hermes replacement can be selected?
2. What exactly is retained, exported, migrated or removed when the current
   AgentOS PostgreSQL custody path is decommissioned?
3. Which one policy/capability evaluator is canonical after reconciling current
   OpenFGA and egress-authorizer designs, including hard non-bypass scope?
4. Which protocol-aware mechanism proves task/run/ref enforcement before remote
   Git write or worker-created PR capability is issued?
5. Which artifact backend and retrieval, revocation, retention, integrity and
   audit contract sits behind A2A artifact references?
6. What exact parent-restart/remote-Pod recovery algorithm and acceptance
   evidence are required?

## 14. Consolidation protocol for this Draft PR

This PR intentionally remains the one review surface while the system evolves.

1. Robin comments on the exact section or adds a top-level decision comment.
2. The selected First Mate answers with a commit that changes this document, including the
   consequence and any new open question.
3. A resolved decision moves from this section into the relevant section's
   **Accepted decision** callout with commit/PR evidence; it is not copied into
   a second shadow document.
4. A superseded design is kept as a short dated note, not silently erased when
   it affects review interpretation.
5. Runtime implementation starts only after the affected design portion is
   explicitly accepted and its adversary/failure conditions are complete.
6. Implementation then gets its own narrow PR and exact-head review. This
   architecture PR never becomes implicit deployment authority.

## 15. Review checklist

- [ ] Hermes is accepted as the initial AgentOS First-Mate profile.
- [ ] Hermes First-Mate/Kanban is accepted as the current reference custody
      implementation; exactly one selected custody authority exists per
      deployment and any replacement must be explicit and equivalent.
- [ ] AgentOS Assignment/Postgres control-plane behavior is excluded from the
      Akua remote-subagent path and is not a fallback.
- [ ] Access Proxy is accepted as the common governed-service access contract.
- [ ] Explicit protocol-aware adapters are accepted over a universal transparent
      HTTP proxy.
- [ ] GitHub broker is accepted as the starting GitHub credential adapter.
- [ ] Internal Git is understood as optional backend infrastructure behind the
      same Proxy.
- [ ] Git ref-level enforcement and hard egress non-bypass are recognized as
      open implementation gates; remote Git write/PR creation remain disabled.
- [ ] Existing AgentOS A2A/Task/Assignment/Inbox/PostgreSQL paths are excluded
      from Akua remote workers.
- [ ] A2A is understood as transport/artifact interaction, not custody truth,
      and any Akua adapter is stateless with respect to custody.
- [ ] No implementation/deploy/remove action is inferred from this design review.
