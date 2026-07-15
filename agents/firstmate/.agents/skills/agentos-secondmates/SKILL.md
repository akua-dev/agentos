---
name: agentos-secondmates
description: Charter, provision, route to, recover, change, and retire persistent AgentOS Second Mates. Use only from First Mate before any Second-Mate lifecycle operation, scope decision, charter handoff, runtime recovery, work transfer, configuration change, or retirement.
---

# Manage AgentOS Second Mates

Treat a Second Mate as a persistent direct report with an isolated charter, Agent identity, home and supervision loop.
Use the same Task, Assignment, Inbox and direct-report lifecycle as ordinary delegation; do not create a parallel coordination system.

## Check the capability boundary

1. Inspect the selected AgentOS release for implemented Second-Mate identity, charter storage, persistent runtime provisioning, database principal registration and Pi launch or recovery primitives.
2. Stop if any required primitive is absent.
   Explain the missing release capability instead of inventing metadata keys, manifests, SQL, credentials or shell procedures from this skill.
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

## Provision and hand off

1. Create exactly one `second_mate` identity as a direct child of First Mate with the released `agentos.provision_agent` Function.
   Pass handle, role `second_mate`, harness `pi`, useful provisioning status text, display name and an object at `metadata.charter` with non-empty `summary` and `scope` strings.
   The Function returns the existing UUID on an exact retry, rejects a conflicting handle and leaves new identities in `provisioning` state.
2. Keep Second Mate on Pi with its own persistent home and PostgreSQL login.
   Co-locate only after explaining the shared pod security boundary and receiving approval.
3. Through the selected database platform's approved role-management path, create one login without `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `BYPASSRLS` or inherited owner authority.
   Bind it with `agentos.register_agent_principal`; never embed its password in Fleet rows or the database URL.
4. Create or select one approved Kubernetes Secret in the target namespace with a `pgpass` key for that login.
   Do not print the value or invent a second secret format.
5. From `agents/firstmate/`, run the released `mise run mate:render --` task with the returned Agent UUID, Kubernetes-safe handle, immutable AgentOS image digest, release version, namespace, password-free PostgreSQL URL, Secret name and output file.
   Inspect the structured output before applying it.
   The renderer creates only a dedicated ServiceAccount, headless Service and one-replica StatefulSet with a retained PVC; it does not create the Secret, database role, RBAC binding or public endpoint.
6. Apply the rendered file to the explicit context and namespace.
   Stop on an existing resource with conflicting identity rather than adopting it by name.
7. Attach to the Second Mate Pod and load `$agentos-auth` for Pi's browser login.
   Login happens in the persistent Pi home; never copy First Mate's or the local bootstrap agent's token directory.
8. Verify the PostgreSQL session resolves the expected Agent identity, parent and charter through the password-free URL and persisted mode-`0600` pgpass file.
   Verify the PVC is Bound, exactly one named Herdr Agent is Ready, the selected model can answer a harmless request, and a Pod replacement restores the same PVC and native Pi session.
9. In one short database transaction, record the verified Kubernetes and Herdr locators, set useful status text and change lifecycle state from `provisioning` to `active`.
   On partial failure, preserve the row and runtime evidence in `provisioning` state for reconciliation; do not create a replacement identity or destructively roll back the PVC.
10. Move accepted in-scope Tasks through reviewed Task and Assignment mutations.
   Preserve history and dependencies; do not clone backlog rows or silently duplicate ownership.
11. Deliver one concise Inbox handoff naming the chartered outcome or queue.
12. Confirm the Second Mate reconciles only its own work and then establishes its own supervision wait.

First Mate supervises the Second Mate as one direct report.
The Second Mate supervises its Crewmates; First Mate does not reconstruct the descendant subtree during routine operation.

## Route work

1. Resolve the project and request first, then compare the nature of the work with active charters.
2. Route to one clear match.
   If charters overlap or no charter fits, keep routing authority with First Mate and resolve the ambiguity before dispatch.
3. Create or associate the durable Task and Assignment before sending the request.
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
6. Remove runtime resources and the persistent home only after separate explicit Captain approval when that removal would discard recoverable state.
7. Never use a forced runtime deletion to bypass database retirement guards.
