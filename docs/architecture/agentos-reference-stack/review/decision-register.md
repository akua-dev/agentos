# AgentOS reference-stack decision register

> **Decision authority:** Robin / Akua architecture review.
> **Last updated:** 2026-08-14.

This file is the canonical status and count register for the evolving AgentOS
reference-stack design. Detailed technical material lives in the linked
architecture document; this register does not authorize an implementation.

## Current counts

```text
Accepted:                  4
Open:                      6
New since previous update: 1
Closed since previous update: 1
Superseded:                1
```

## Accepted

| ID | Accepted decision |
|---|---|
| AD-1 | Each deployment has exactly one selected durable work/acceptance custody authority. Hermes First-Mate/Kanban is the recommended reference implementation; a future replacement requires explicit selection and equivalent task, evidence, human-gate and recovery guarantees. |
| AD-3 | A2A is remote-agent transport/delegation, never a second durable truth for task lifecycle, approval, session, retry or acceptance. |
| AD-4 | A remote worker can work broadly inside its isolated environment to the full extent of explicit Assignment and technical capabilities, without gaining custody, broad credentials, merge, release or production authority. |
| OD-7 | The product vision belongs in repository-root `VISION.md`; the detailed reference stack belongs under `docs/architecture/`. The local worktree is only a drafting location for version-controlled shared documentation. |

## Preferred direction, not an accepted implementation decision

| ID | Direction |
|---|---|
| AD-2 | The current AgentOS PostgreSQL Task/Assignment/Inbox custody path is not an Akua remote-worker path and is not work Akua intends to continue. It is a decommission/removal candidate only; no deletion occurs without a separate inventory, retention/recovery decision and implementation authorization. |

## Open

| ID | Exact decision required |
|---|---|
| OD-1 | Define the provider-neutral custody interface and minimum equivalence proof for a future Hermes replacement. |
| OD-2 | Define the exact source inventory, retention, export, migration and removal scope for the current AgentOS PostgreSQL custody path. |
| OD-3 | Select one canonical policy/capability evaluator after reconciling OpenFGA and egress-authorizer designs, including non-bypass requirements. |
| OD-4 | Select and adversarially prove task/run/ref enforcement before remote Git write or worker-created PR capability is enabled. |
| OD-5 | Select an artifact backend plus retrieval, revocation, integrity, retention and audit contract behind A2A artifact references. |
| OD-6 | Define the exact parent-restart/remote-Pod recovery algorithm and acceptance evidence. |

## Superseded wording

| Previous wording | Replacement |
|---|---|
| Hermes is the only possible custody implementation. | Hermes First-Mate/Kanban is the recommended reference implementation; each deployment has exactly one explicitly selected custody authority. |

## Update protocol

An explicit stakeholder `accept`, `amend`, `defer` or `reject` updates this
register and the affected detailed document in the same source change. A PR,
CI result, pod lifecycle event or worker report is evidence, not acceptance.
