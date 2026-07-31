---
name: agentos-secondmates
description: Charter, provision, route to, recover, change, and retire persistent AgentOS Second Mates. Use only from First Mate before any Second-Mate lifecycle operation, scope decision, charter handoff, runtime recovery, work transfer, configuration change, or retirement.
---

# Manage AgentOS Second Mates

Treat a Second Mate as a persistent direct report with an isolated charter, Agent identity, home and supervision loop.
Use the same Task, Assignment, Inbox and direct-report lifecycle as ordinary delegation; do not create a parallel coordination system.

## Check the capability boundary

1. Inspect the selected AgentOS release for implemented Second-Mate identity, charter storage, persistent runtime provisioning, database principal registration and Pi launch or recovery primitives.
2. Stop if any required schema, Kustomize base or native tool capability is absent.
   Explain the missing release capability instead of inventing metadata keys,
   SQL, credentials or an AgentOS wrapper.
3. Load `$agentos-database`, `$agentos-runtime`, `$agentos-auth` and `$agentos-delegation` at their respective boundaries.

## Decide whether a Second Mate is warranted

Create a Second Mate for a durable domain that benefits from its own queue, context and Crewmate subtree.
Do not create one for a single bounded task, temporary concurrency or a project name alone.
Project access is non-exclusive; route by natural-language charter scope.

Before creating one:

1. Query every active Second Mate and compare the requested responsibility with existing charters.
2. Prefer extending or clarifying one compatible charter over creating overlap.
3. Present the proposed charter, project access, runtime footprint, model authentication and expected cost to the Captain.
4. Ask before provisioning identity, credentials, PVC, pod, RBAC or other infrastructure.

## Define the charter

Require one durable charter with:

- a short responsibility summary and unambiguous natural-language scope;
- the parent First-Mate identity;
- non-exclusive project access needed for read-only intake and delegated work;
- authority already granted and actions that must escalate;
- the upward reporting path through Inbox, Tasks and Assignments;
- the rule that project work is always delegated to Crewmates;
- the rule that the Second Mate never creates another Second Mate;
- the idle contract: reconcile owned work, then wait silently without inventing work;
- retirement and handoff expectations.

Store the charter only through the released schema or provisioning primitive that owns its exact format.
Do not improvise a second registry in Markdown, terminal state or an unreviewed JSON shape.
Keep stable Fleet-wide or domain guidance in the owning Mate's private context
through `$agentos-memory`; it is fallible context and never a shared
coordination, charter or approval authority. Keep the Second-Mate charter in
the released `agents.metadata.charter` shape, and use Inbox for exact Captain
decisions. Do not copy memory into another home or inherited Pi configuration.
Learnings remain domain-local unless promoted through a reviewed shared
AgentOS or project instruction change.

## Provision and hand off

1. Create exactly one `second_mate` identity as a direct child of First Mate with the released `agentos.provision_agent` Function.
   Pass handle, role `second_mate`, harness `pi`, useful provisioning status text, display name and an object at `metadata.charter` with non-empty `summary` and `scope` strings.
   The Function returns the existing UUID on an exact retry, rejects a conflicting handle and leaves new identities in `provisioning` state.
2. Keep Second Mate on Pi with its own persistent home and PostgreSQL login.
   Give it a dedicated Pod, ServiceAccount, home PVC and pod-local Herdr server.
3. Through the selected database platform's approved role-management path, create one login without `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `BYPASSRLS` or inherited owner authority.
   Bind it with `agentos.register_agent_principal`; never embed its password in Fleet rows or the database URL.
4. Load `$agentos-runtime`. From the active First Mate role resource directory,
   create a reviewed per-Agent overlay over
   `../secondmate/kubernetes/domain` under
   `$HOME/.local/state/agentos/workloads/<handle>/`. Select one Kubernetes-safe
   domain namespace and patch the Namespace name, Fleet label, returned owner
   Agent UUID, Second-Mate RoleBinding subject namespace, workload identity,
   immutable AgentOS image digest, password-free fully qualified PostgreSQL
   URL, Secret name, labels, Herdr session and storage. The released domain
   composition supplies restricted Pod Security labels, ingress-only
   isolation, bounded quota, the Second-Mate workload Role and the core
   First-Mate supervisor Role. Never add an egress-deny policy.
   If a persistent-Mate model or thinking level was selected, follow
   `$agentos-harnesses` and patch its `AGENTOS_MODEL` and `AGENTOS_THINKING`
   values onto the `prepare-home` init container before rendering or applying
   the workload. Do not add an omitted axis or a shared release default.
5. Render and inspect the complete overlay, then apply its reviewed Namespace
   resource first. Verify its concrete Fleet and owner-Agent labels, restricted
   Pod Security profile and absence of an egress policy. Create or select one
   approved Secret in that namespace with a `pgpass` key for the login. Every
   Secret in this namespace is domain-visible because the Second Mate can mount
   it through a child workload; never place Fleet-root credentials there. Do
   not print the value or invent a second secret format.
6. Use the runtime skill's native server-side dry-run,
   `kubectl diff` and synchronous `kubectl apply` sequence. Stop on an existing
   resource with conflicting identity rather than adopting it by name. The
   overlay creates no database role, Secret or public endpoint. It must retain
   the base's projected ServiceAccount identity and exactly the reviewed domain
   Roles, RoleBindings, ResourceQuota and ingress NetworkPolicy. Verify the
   Second Mate can create and operate Crewmate workloads only in this namespace,
   cannot read or create Secrets or mutate namespace controls, and cannot read,
   exec or create anything in a sibling domain. Verify First Mate can inspect,
   attach, stop, manage domain credentials and repair controls. Later Crewmate
   overlays contain no RBAC; they consume the installed domain Role.
7. Attach to the Second Mate Pod and load `$agentos-auth` for Pi's browser login.
   Login happens in the persistent Pi home; never copy First Mate's or the local bootstrap agent's token directory.
8. Verify the PostgreSQL session resolves the expected Agent identity, parent and charter through the password-free URL and persisted mode-`0600` pgpass file.
   Verify the PVC is Bound, exactly one named Herdr Agent is Ready, the selected
   model can answer a harmless request, and Pi's live model and thinking level
   match every explicitly selected axis. A matching `settings.json` alone is
   not runtime evidence. Verify that a Pod replacement restores the same PVC,
   native Pi session and effective selected profile.
9. In one short database transaction, record the verified Kubernetes and Herdr locators, set useful status text and change lifecycle state from `provisioning` to `active`.
   On partial failure, preserve the row and runtime evidence in `provisioning` state for reconciliation; do not create a replacement identity or destructively roll back the PVC.
10. Move accepted in-scope Tasks with
    `agentos.handoff_task_assignment`. Preserve the stable Task, Assignment
    history, dependencies, complete destination brief and concrete dispatch
    profile; do not clone backlog rows or rewrite the previous Agent. Active
    work requires an explicit handoff report. An exact retry returns the same
    replacement; invalid hierarchy or destination fails closed.
11. Deliver one concise Inbox handoff naming the chartered outcome or queue.
12. Confirm the Second Mate reconciles only its own work and then establishes its own supervision wait.

First Mate supervises the Second Mate as one direct report.
The Second Mate supervises its Crewmates; First Mate does not reconstruct the descendant subtree during routine operation.

## Route work

1. Resolve the project and request first, then compare the nature of the work with active charters.
2. Route to one clear match.
   If charters overlap or no charter fits, keep routing authority with First Mate and resolve the ambiguity before dispatch.
3. Create or associate the durable Task and first Assignment through the atomic
   acceptance path in `$agentos-delegation` before sending the request. Never
   accept work with separate Task and Assignment inserts.
4. Use Inbox for the chartered request and upward answer.
   Do not rely on terminal injection as the handoff record.
5. Let the Second Mate own its internal Crewmate lifecycle and report only decisions, blockers, material phase changes, completion and failure upward.

## Recover

1. Load `$agentos-supervision` and reconcile the Second Mate's database identity, current Assignment, pod, PVC, Herdr locator and native Pi session.
2. Treat an idle live session as healthy.
3. If the runtime is missing, reuse the same Agent identity, home and native session through the released recovery primitive.
4. Never create a replacement Second-Mate row merely because its pod or terminal disappeared.
5. Do not sweep or mutate the Second Mate's descendant runtimes from First Mate unless the Second Mate cannot recover and the Captain authorizes intervention.

## Retire

Retirement is explicit, never an idle timeout.

1. Stop new routing to the charter.
2. Complete or reassign every active Task Assignment.
3. Require the Second Mate to hand off every active child Agent and durable decision thread.
4. Preserve delivered artifacts, reports, Inbox history and charter history.
5. Call `agentos.retire_agent` only after the database accepts that no active Assignments or children remain.
6. Remove the StatefulSet, Service and ServiceAccount without deleting retained
   PVCs. Keep the domain Namespace and its controls while any retained PVC or
   recoverable state remains.
7. Delete retained PVCs and then the Namespace only after separate explicit
   Captain approval for that destructive discard. Namespace deletion is never
   routine cleanup because it deletes namespaced PVC objects regardless of the
   StatefulSet retention policy.
8. Never use a forced runtime or Namespace deletion to bypass database
   retirement guards.
