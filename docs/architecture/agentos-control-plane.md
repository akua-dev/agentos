# AgentOS Control Plane — Hermes, Access Proxy and Remote Subagents

> **Status:** Draft — one consolidated review document.
> **Decision authority:** Robin / Akua architecture review.
> **Source status:** This document defines the proposed Akua reference-stack integration. It is not an implementation, deployment, migration, approval, or production authorization.

## 1. Decision requested

Accept or request changes to this unified direction:

```text
Hermes First-Mate is part of the AgentOS reference stack and is the recommended
starting profile for a company.

Hermes Kanban is the only durable Akua authority for Task, Assignment intent,
human gates, dispatch, retry, interrupt, result, acceptance, settlement and
cleanup.

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

## 2. Scope and non-goals

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
  store or acceptance database beside Hermes Kanban.
- Direct Kanban, Discord, GitHub App or broad Kubernetes credentials in a
  remote worker.
- Implementing, deploying, migrating, deleting or merging any component from
  this document.

## 3. Authority model

| System | Owns | Does not own |
|---|---|---|
| Human / Captain | purpose, risk, consequential approval and ultimate accountability | operational toil or per-request credentials |
| Hermes First-Mate / Kanban | work selection, Assignment intent, human gates, dispatch decision, retry, interrupt, result review, acceptance, settlement and cleanup decision | provider credentials in workers; Kubernetes as a business completion oracle |
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

Hermes Kanban
  = sole durable Task / Assignment / approval / dispatch / retry / result /
    acceptance / settlement / cleanup authority

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

### 7.3 Common contract, separate adapters

```text
One common caller/grant/route contract
≠ one all-credential process
```

Each adapter has its own credential, protocol parser, error contract, deployment
lifecycle and narrow blast radius.

| Adapter | Backend | Primary constraint |
|---|---|---|
| GitHub adapter | GitHub REST, GraphQL and Smart HTTP | repository/action and eventually task-bound ref restriction |
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

### 9.1 Worker delivery path

```text
Remote code worker
→ Access Proxy
→ selected Git backend
→ candidate commit/ref
→ Hermes validates evidence and source state
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

### 9.2 Worker rights

| Action | Remote worker | Hermes First-Mate |
|---|---|---|
| read approved source/dependency repo | only through Proxy capability | yes, through reviewed access path |
| write candidate ref | only exact Assignment-bound repo/fork/ref | decides whether candidate is promoted |
| force push / tags / hooks / server admin | no | no unless separately authorized admin operation |
| create/update Draft PR | only when assignment capability explicitly permits it | may promote and create/update exact verified candidate PR |
| merge / release / deployment | no | separate review and applicable authorization only |
| GitHub App credential | never | normal path remains mediated; privileged exception stays First-Mate-only |

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
Hermes Parent-Agent / Kanban custody
→ Remote Child-Agent in Kubernetes
```

This is not equivalent to a local short-lived subagent process. A2A is the
candidate conversation/transport layer across process, machine and harness
boundaries. Hermes Kanban remains the durable authority.

### Context and artifacts

```text
Repository/workspace needed for work
→ materialize an authorized checkout/workspace in the workload

Large document, checkpoint, test artifact or bundle
→ A2A Artifact with URL/provenance/digest where supported

Small self-contained file
→ bounded A2A raw artifact only where implementation supports it

Status, question, steer, block
→ small structured A2A message/data
```

Large bytes are not inserted into prompts by default. Every artifact route needs
access control, integrity/provenance, retention and redaction rules. No secret
belongs in an A2A artifact, A2A message, task evidence or telemetry.

### Lifecycle

| Stage | Remote child may do | Hermes must decide |
|---|---|---|
| start | read materialized authorized inputs | whether to dispatch |
| progress | report bounded status/checkpoint | whether to continue/steer |
| question/block | request missing authorized context | Kanban comment/block and human escalation |
| candidate | commit/test/publish allowed candidate ref | whether evidence is sufficient |
| result | return PR/ref/test/artifact evidence | accept, request review, retry or block |
| interrupt/cleanup | stop cooperatively and publish final evidence | durable interrupt/retry/cleanup decision |

A Pod surviving a Hermes restart is execution evidence. Recovery must reconcile
the live workload, exact candidate source, Artifact availability and Kanban
intent before any resume, retry, cleanup or acceptance action.

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
| forged PR/CI/exit success | evidence is reread against exact source and Assignment intent |
| secret/prompt/payload in logs/artifacts | rejected/redacted before durable evidence/export |
| CRM/outbound write | applicable human and CRM gates remain binding |

## 13. Open decisions requiring explicit review

1. What is the canonical capability-policy evaluator after reconciling current
   OpenFGA material with the modern egress-authorizer direction?
2. Which exact service classes must have hard technical non-bypass enforcement,
   and what NetworkPolicy/CNI/FQDN mechanism proves it?
3. What task/run/ref-level enforcement mechanism is mandatory for Git Smart
   HTTP writes before a remote coding worker receives write capability?
4. Is an internal Git candidate backend required in the first release, or is a
   proxy-mediated GitHub backend sufficient initially?
5. Which CRM is the first supported non-Git adapter, and which object/field/
   outbound gates are required?
6. Does current Hermes A2A implementation support the required artifact
   direction end-to-end, or does the Remote Agent adapter need a bounded
   standards-compatible Artifact publisher?
7. What is the exact recovery algorithm for Hermes restart while a remote
   child, candidate branch or Artifact publication is still live?
8. Which parts of existing AgentOS Assignment/Postgres material are retained
   for non-Akua product contexts, deprecated, or removed after an independent
   source inventory and migration plan?

## 14. Consolidation protocol for this Draft PR

This PR intentionally remains the one review surface while the system evolves.

1. Robin comments on the exact section or adds a top-level decision comment.
2. Hermes answers with a commit that changes this document, including the
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
- [ ] Hermes Kanban is accepted as Akua's sole durable custody authority.
- [ ] AgentOS Assignment/Postgres control-plane behavior is excluded from the
      Akua remote-subagent path and is not a fallback.
- [ ] Access Proxy is accepted as the common governed-service access contract.
- [ ] Explicit protocol-aware adapters are accepted over a universal transparent
      HTTP proxy.
- [ ] GitHub broker is accepted as the starting GitHub credential adapter.
- [ ] Internal Git is understood as optional backend infrastructure behind the
      same Proxy.
- [ ] Git ref-level enforcement and hard egress non-bypass are recognized as
      open implementation gates, not assumed complete.
- [ ] A2A is understood as transport/artifact interaction, not custody truth.
- [ ] No implementation/deploy/remove action is inferred from this design review.
