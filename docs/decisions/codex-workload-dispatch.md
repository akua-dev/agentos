# Codex workload dispatch

**Status:** proposed
**Date:** 2026-08-12
**Decision owner:** Captain-approved First Mate

## Context

Codex is a capable coding harness, but it must not become a second task
scheduler, durable work ledger, approval authority, or autonomous Kubernetes
controller. In Hermes-led operation, Hermes owns chat, profiles, sessions,
Kanban tasks and dependencies, approvals, dispatch, retries, interruption and
result custody. Kubernetes supplies ephemeral compute. The Codex App Server is
the native control boundary for the Codex harness.

A single permanently running worker is useful as a controlled protocol canary,
but it is not the scale-out topology. Conversely, one disposable Pod for every
turn is inefficient for a Captain-directed iterative coding session. The
runtime therefore needs a distinct bounded-job mode and an explicit
lease-bound interactive-session mode.

## Decision

AgentOS/Hermes dispatches Codex compute; Codex workloads never poll Kanban or
create other workloads.

### Shared invariants

- Hermes remains the only task, approval, lifecycle, retry and result-custody
authority. A Kubernetes Job, Pod, native Codex thread, Pod label and workspace
path are correlation/state references, never an independent grant of authority.
- Before dispatch, exactly one accepted task/assignment has one active writer
and an explicit custody binding. A durable controller run must bind the exact
task identifier, board/assignment authority and absolute workspace.
- A worker has no Kubernetes control capability. It does not read Kanban,
claim work, create Pods, or select replacement work.
- Codex App Server stays Pod-local. Its control transport is not exposed through
a Service or Ingress. A responsible control-plane client owns its exclusive
native-session lease.
- Kubernetes may physically terminate a workload through eviction, node loss,
preemption or Job/Pod lifecycle. That event never establishes terminal task
state, retry authority, artifact acceptance or permission to create a
replacement. Hermes classifies it as uncertain and reconciles custody, existing
identity, artifacts and native session before deciding the next action.
- Every meaningful turn checkpoints secret-free terminal lifecycle evidence,
verified code/review artifacts, model/provider and exact native-session
reference outside `emptyDir` before destructive cleanup. Raw prompts, reasoning,
credentials, environment and unbounded terminal output are not checkpoint
artifacts.
- Workload retry is an explicit Hermes decision after custody reconciliation.
Kubernetes may not blindly retry an ambiguous coding turn.
- Pods use tokenless worker isolation by default: no automounted Kubernetes
ServiceAccount token, non-root process, dropped capabilities, read-only root
filesystem and bounded workspace/home/tmp volumes. Provider identity and policy
are separately governed at their approved runtime boundary.

### Mode A: disposable bounded Assignment Job

Use a short-lived Kubernetes Job for a self-contained assignment such as an
implementation slice, inspection, test run, code review or bounded repair.

1. Hermes admits a ready Assignment after policy, approval, model/provider,
workspace, capacity and one-writer checks.
2. A typed runner renders a unique Job request from reviewed inputs. The Job has
an explicit resource envelope, `restartPolicy: Never`, no worker-side Kubernetes
identity and `backoffLimit: 0` unless a separately reviewed recovery policy
proves retry safety.
3. The Job creates a unique workspace, materializes verified source and brief,
and starts one bounded native Codex session/turn under explicit custody.
4. Hermes obtains and verifies the atomic terminal result and checkpointed
artifacts before accepting a review/handoff or cleanup outcome.
5. Kubernetes Job TTL cleanup is enabled only after custody is durable. Hermes
may delete earlier only after the same checkpoint and state verification.

A completed Job is not resumed. A later continuation is dispatched as a new Job
from checkpointed source/artifacts and may use only the exact recorded native
session resume/fork path when it remains valid. It never uses a shared "last
session" heuristic.

### Mode B: lease-bound interactive Codex session worker

Use a session worker when the Captain and Hermes need multiple controlled turns
against one live Codex session: iterative guidance, steering, interruption,
review follow-up or a long-running bounded collaboration.

1. Hermes creates a unique session Pod/workspace and acquires one exclusive
native-session lease.
2. Only Hermes may issue turns, steering or interrupt requests through the
session's native control boundary. A Discord/chat conversation remains attached
to Hermes; the worker does not become a user-facing control plane.
3. An idle TTL bounds the session. At every material turn and before expiry,
Hermes checkpoints the reviewable artifact and terminal/session evidence.
4. A task-scoped PVC is optional for large repositories or long sessions. It
belongs to one assignment/session, has quota and retention rules, and is never
a shared permanent cross-task home. It is deleted only after artifact recovery,
review/handoff and explicit closure.
5. If a Pod dies, Hermes first reconciles its task/assignment, existing PVC,
checkpoint and native session. It resumes the same identity when valid; it does
not create a parallel writer merely because terminal state is unclear.

## Dispatch contract

The future typed `CodexWorkloadRunner` is a narrow AgentOS/Hermes integration,
not a scheduler. It receives already-authorized inputs and returns bounded
observations. It must:

- select `assignment-job` or `interactive-session` explicitly;
- render a unique workload with immutable image and explicit model/provider;
- enforce admission/concurrency and a one-writer lease before create;
- bind/correlate, but never authorize from, task/assignment identifiers and
Pod labels;
- transfer only reviewed source, task brief and controller inputs;
- observe native workload state and recover exact artifacts before cleanup;
- return typed success/failure/uncertain outcomes to Hermes for review, retry,
handoff or block decisions;
- reject missing, conflicting or ambiguous custody rather than guessing.

## Consequences

This design gives independent work horizontal Pod scale while retaining a
safe interactive mode. It prevents the common failure modes of autonomous queue
workers: duplicate claims, stale session reuse, uncontrolled model retries,
workload-created workloads and lost `emptyDir` artifacts.

It also introduces explicit dispatcher work: typed workload inputs, Job/session
manifest rendering, admission/lease logic, artifact checkpointing, TTL cleanup
and recovery conformance tests. Those mechanisms belong in versioned TypeScript
and reviewed manifests; this decision does not itself add a scheduler, CRD,
message bus, task database or shadow state.

## Non-goals and deferred work

- Replacing Hermes as First Mate or creating a Codex-owned control plane.
- A worker that polls Kanban, sends messages autonomously or discovers its next
task without Hermes dispatch.
- A shared permanent PVC or a shared "resume most recent" Codex session.
- Exposing a Codex App Server via Service, Ingress or unauthenticated remote
WebSocket.
- Selecting the final native transport (`stdio`, Unix socket, supported SDK, or
strictly local WebSocket) before a dedicated compatibility/conformance review.
- ACP as a workaround for native Codex control; ACP remains a later optional
interoperability projection. A2A remains a reference-oriented boundary between
independent agents.

## Required implementation and validation

Before either mode is accepted as a released runtime path, implement and review:

1. typed runner input/output contracts and reject-by-default custody validation;
2. server-side dry-run manifest rendering and resource/concurrency admission;
3. unique Job/session names, lease behavior and no automatic ambiguous retry;
4. tokenless worker containment and pinned image/provider/model validation;
5. artifact checkpoint before TTL/delete, including failure and interruption
paths;
6. exact-session resume/fork proof without a duplicate writer;
7. real-cluster conformance for one bounded job and one interactive idle/expiry
session, with independent exact-head review;
8. capacity-driven horizontal scaling from a small initial wave, not arbitrary
parallelism.
