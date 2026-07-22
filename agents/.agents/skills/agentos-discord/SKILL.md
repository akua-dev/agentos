---
name: agentos-discord
description: Configure, verify, operate, recover, and revoke the optional AgentOS Discord Captain and team communication surface. Use when connecting a Mate to Discord, reviewing bot permissions or intents, mounting its bot identity, starting or recovering Discord Gateway ingress, reading or replying in channels and threads, designing rich embeds, status cards, buttons or other interactive components, or reconciling Discord external events.
---

# Operate Discord

Treat Discord as an optional human communication surface. PostgreSQL remains
Fleet authority; Discord never becomes a Task queue, Inbox replacement or
coordination database.

Use the shipped primitives at their narrow boundaries:

- `discord request` performs one authenticated Discord REST request. It reads a
  JSON body from standard input and returns the real provider response and exit
  status. Its default output remains unchanged provider JSON; `--axi` is an
  optional Agent-readable projection.
- `discord-ingress` maintains the required Gateway connection, appends approved
  non-credential Gateway deliveries through `agentos.ingest_external_event`,
  and acknowledges recognized component or modal interactions after
  persistence.
- `pg-listen agentos_events` remains the Mate wake path. Do not add a second
  Discord-specific Pi message, wake queue, outbound outbox or model-triggering
  webhook.

## Choose the response view

Use `--axi` for routine Agent reads and mutations when a compact, structured
result is enough:

```console
discord request GET /channels/<channel-id>/messages?limit=20 --axi
printf '%s' '{"content":"Review ready"}' \
  | discord request POST /channels/<channel-id>/messages --axi
```

AXI mode emits TOON, writes structured failures to standard output and keeps
the exit status authoritative. Recognized message reads use a content-first
four-field view; message collections are capped at 20 and report omitted rows;
message mutations return IDs, timestamps and component counts without echoing
the submitted content. Empty message collections say so explicitly.

Use `--axi --full` when complete provider data is required but TOON remains
more useful than JSON. Use the raw default when investigating provider
behavior, preserving an exact response for recovery, or needing fields omitted
by the compact message view. Unknown successful resource shapes remain
lossless even under `--axi`; do not assume a compact view proved that an
omitted provider field is absent.

The output selector never changes the request, provider effect, retry behavior
or authority. Inspect the exit status before trusting either response view.
These conventions follow the [AXI output principles](https://axi.md/); they do
not turn this narrow primitive into the full AXI command framework.

Load `$agentos-database` before changing Captain state or reconciling external
events, `$agentos-supervision` before running or recovering the ingress as a Pi
background command, and `$agentos-runtime` before changing its Kubernetes
wiring. Load `$agentos-decisions` when a Discord message creates or resolves a
genuine Captain choice.

## Inspect and choose the surface

Inspect read-only before mutation:

1. Resolve the current Mate, Pod, namespace, database identity and installed
   AgentOS revision.
2. Read active Fleet-scoped `communication.primary` and
   `communication.discord` Captain state. More than one active row for either
   topic is a conflict to reconcile, not permission to pick the newest. Inspect
   any existing bot application, guild, categories, channel overwrites,
   intents, Secret, ConfigMap and running ingress without printing credentials.
3. Ask the Captain which guild and category AgentOS may manage, which other
   channels it may read, who is authorized to speak as Captain, and whether
   Discord is primary, secondary or disabled. Discord membership or the
   ability to post in a channel does not itself grant AgentOS authority.
4. Explain and ask separately before creating or installing a bot, reading or
   storing its token, changing permissions or intents, creating provider
   resources, writing Kubernetes objects, restarting a Mate or revoking access.

Recommend one real category for the AgentOS-owned communication area. Use
channels for durable domains and threads for temporary conversations. Broad
read access can be useful context, but messages outside the managed category
remain pull-on-demand unless they explicitly mention the bot; do not ingest a
whole company server into model context.

## Establish least provider authority

The Captain creates or selects the Discord application and installs its bot.
Require the privileged Message Content intent when ordinary message text is in
scope. Grant no Discord `Administrator` permission.

Use Discord's official setup guides for provider-owned UI steps: create the
application and bot, choose Guild Install, add the `bot` scope, select only the
reviewed permissions, enable Message Content, install into the selected guild,
and create the managed category. The `applications.commands` scope is optional
unless the Captain also selects slash commands. AgentOS receives interactions
over the Gateway; leave the application's Interactions Endpoint URL unset
unless a separately reviewed HTTP interaction receiver replaces that path. Do
not ask the Captain to infer permissions from an AgentOS numeric bitfield.

A common posture is:

- server-wide `View Channels` and `Read Message History` only where the Captain
  deliberately wants contextual read access;
- category-specific send, thread and channel-management permissions inside the
  managed AgentOS category;
- `Manage Messages` only if moderation is selected;
- `Manage Roles` only if the bot must edit permission overwrites itself.

The released workload patch mounts the bot identity only into First Mate. Do
not distribute that identity to Second Mates or Crewmates by implication; a
separate delegated Discord operator needs its own explicit provider authority,
Secret boundary and workload review.

Discord category overwrites are provider authority, not decoration. When
creating a channel, set its `parent_id` to an approved managed category and
verify the effective overwrites after creation. Never auto-delete a channel or
thread merely because Fleet work completed.

Stage a new bot token in a mode-`0600` local file outside Git, then create the
Kubernetes Secret without printing its rendered value. ConfigMap
`agentos-discord` is the ingress runtime projection of the active Captain
contract and contains only its non-secret guild and managed-category IDs:

```console
kubectl --namespace agentos create secret generic agentos-discord-bot \
  --from-file=token=/approved/path/discord-token \
  --dry-run=client --output yaml | kubectl apply -f -

kubectl --namespace agentos create configmap agentos-discord \
  --from-literal=guild-id=123456789012345678 \
  --from-literal=managed-category-ids=234567890123456789 \
  --dry-run=client --output yaml | kubectl apply -f -
```

Preview the role-owned strategic patch
`agents/firstmate/kubernetes/patches/discord.yaml` against the live First-Mate
StatefulSet. Confirm that the image, PVC, database wiring and unrelated Pod
state remain unchanged. After restart approval, apply the patch, wait for the
rollout and reattach to the same native session.

Verify the identity with a harmless raw request:

```console
discord request GET /users/@me --axi
```

With explicit approval, prove category authority by creating one temporary
child channel using a JSON body on standard input, reading it back and deleting
it. Use the provider's returned channel ID; do not turn that proof into another
wrapper command.

## Preserve the Captain's communication contract

Use active Fleet-scoped `communication.primary` and `communication.discord`
rows as durable memory. The first states which Captain surface is primary and
what its fallback is. The second keeps Discord behavior in natural-language
`content` and non-secret routing or authority facts in `metadata`:

- whether Discord is enabled and primary or secondary;
- guild, managed category and stable channel IDs;
- approved Captain actor and role IDs;
- notification cadence, channel/thread posture, decision handling and other
  Captain expectations.

The Discord layout is a rebuildable provider projection. Captain state records
why it exists and how First Mate should use it. Neither channel names nor Pi
history replace that contract. The ConfigMap is another runtime projection,
not a peer authority. Compare it with active Captain state at startup and
report drift. A changed guild or managed category needs the separately approved
ConfigMap and Pod reconciliation before ingress follows it; a conversational
preference that changes no process configuration takes effect without a
restart. Keep the bot token only in its Secret.

Read the active state before changing it:

```sql
SELECT id, topic, content, source, metadata, created_at, updated_at
FROM agentos.captain
WHERE scope = 'fleet'
  AND scope_agent_id IS NULL
  AND archived_at IS NULL
  AND topic IN ('communication.primary', 'communication.discord')
ORDER BY topic, created_at;
```

When the Captain changes the Discord contract, first resolve any conflicting
active rows. Then archive the superseded row and insert the complete replacement
in one short transaction. Adapt the prose and non-secret IDs to the Captain's
actual instruction; do not turn this example into a fixed policy:

```sql
BEGIN;

SELECT id, content, metadata
FROM agentos.captain
WHERE scope = 'fleet'
  AND scope_agent_id IS NULL
  AND topic = 'communication.discord'
  AND archived_at IS NULL
FOR UPDATE;

UPDATE agentos.captain
SET archived_at = transaction_timestamp()
WHERE scope = 'fleet'
  AND scope_agent_id IS NULL
  AND topic = 'communication.discord'
  AND archived_at IS NULL;

INSERT INTO agentos.captain (
  topic,
  content,
  source,
  recorded_by_agent_id,
  metadata,
  scope,
  scope_agent_id
)
VALUES (
  'communication.discord',
  $contract$
Use #first-mate for conversation. Notify the Captain for decisions, blockers
and failures. Use threads for incidents and edit one status card instead of
posting continuous progress messages.
$contract$,
  'discord:message:<provider-message-id>',
  agentos.current_agent_id(),
  jsonb_build_object(
    'enabled', true,
    'mode', 'primary',
    'guild_id', '<guild-id>',
    'managed_category_ids', jsonb_build_array('<category-id>'),
    'primary_channel_id', '<first-mate-channel-id>',
    'decisions_channel_id', '<decisions-channel-id>',
    'operations_channel_id', '<operations-channel-id>',
    'captain_actor_ids', jsonb_build_array('<captain-user-id>'),
    'captain_role_ids', jsonb_build_array('<captain-role-id>')
  ),
  'fleet',
  NULL
)
RETURNING id, topic, content, source, metadata, created_at, updated_at;

COMMIT;
```

Use the same archive-and-insert contract for `communication.primary` when the
selected primary surface or fallback changes. Read the committed rows back
before confirming new behavior. At bootstrap, Pi session start or recovery,
and before consequential Discord authority when current context may be stale,
reload these active rows instead of relying on conversation memory.

## Run and recover ingress

Run `discord-ingress` inside the First-Mate Pi session with
`run_background_command`. Give it a useful description containing
`[agentos-discord-ingress]`; the process is a persistent provider connection,
not the `[agentos-supervision]` continuity wait. Keep the ordinary tagged
`pg-listen agentos_events` wait armed so accepted Discord events wake the Mate
through the same durable Fleet notification path as other external events.

There is exactly one Pi wake chain: PostgreSQL notifies, the active `pg-listen`
background command exits, and the background-command extension sends one
custom follow-up pointer. Neither ingress nor another Discord extension calls
Pi. `deliverAs: "followUp"` and `triggerTurn: true` are options on that one
custom message, not two turns. Rearm the continuity wait after reconciliation;
the supervision guard may remind you only when that lifecycle evidence is
missing.

The ingress accepts human message creates, edits and deletes in the managed
category or its descendants, direct messages, explicit bot mentions elsewhere
in the selected guild, and generic AgentOS component or modal interactions. It
ignores bot and webhook authors. It stores the Gateway dispatch in
`external_events` with temporary interaction reply tokens explicitly redacted,
then lets the released quiet/max window coalesce related activity before a
Mate claims it. It never calls a model or writes Task or Inbox state itself.

When the ingress exits, inspect its captured background-command output and the
Discord, database and network authorities before restarting it. Gateway resume
state is intentionally process-local. After a process replacement, query the
known managed channels and threads for messages after the newest locally
accepted message, then ingest missing raw REST results through
`agentos.ingest_external_event` with deterministic Discord delivery IDs before
resuming normal reconciliation. Message edits, deletes, mentions in otherwise
untracked channels and unknown direct-message channels cannot always be
exhaustively reconstructed; report that gap instead of claiming lossless
recovery.

At every session start, if durable Captain state says Discord is enabled,
verify or restore the ingress background process before relying on Discord
delivery. Do not routinely list background commands merely to re-prove a launch
the session already observed; inspect them when lifecycle evidence is missing,
ambiguous or contradictory.

## Reconcile and respond

Use the external-event claim and fencing Functions exactly as defined by
`$agentos-database`. Verify the Discord actor and applicable roles against the
Captain-approved authority mapping before treating content as a command. A
message may become a Task, Inbox delivery, Captain decision, ordinary reply or
no Fleet mutation at all; the responsible Mate decides from context.

Before creating, updating or reconciling buttons or another interactive
surface, read
[`references/interactive-components.md`](references/interactive-components.md).
It owns the supported component identifiers, raw provider payloads, lifecycle,
failure handling and current modal and Pi-control boundaries. A component
label never grants Captain authority; authenticate the actor and reconcile the
current Fleet state before acting.

Before designing or updating a decision, Task, delivery or status embed, read
[`references/rich-embeds.md`](references/rich-embeds.md). It owns the card
selection rules, free-form reply and thread behavior, raw provider payloads and
projection lifecycle. An embed is a concise provider view, never a substitute
for its Task, Assignment, Captain decision, Git artifact or external event.

Discord is an Agent-operated workspace, not a fixed bot UI. The Captain may ask
First Mate to create or reorganize channels and threads, change topics, edit one
status card, or add contextual components. Use raw provider requests for those
effects. For example:

```console
printf '%s' '{"topic":"Captain decisions and approvals"}' \
  | discord request PATCH /channels/345678901234567890 --axi
```

For outbound Discord effects, call `discord request` synchronously and observe
its actual status before completing local reconciliation. For example:

```console
printf '%s' '{"content":"The review is ready: https://example.invalid/pr/42"}' \
  | discord request POST /channels/345678901234567890/messages --axi
```

Keep the provider call outside the database transaction. Then apply coupled
Fleet mutations and complete the external-event claim in one short transaction.
On an ambiguous crash after a successful-looking provider call, inspect the
channel once before retrying a non-idempotent message.

## Revoke cleanly

Inspect active use and explain the interruption first. With approval, stop the
ingress, remove its role-owned Pod wiring, rotate or revoke the bot token,
remove the Secret and ConfigMap, and uninstall or narrow the Discord app as the
Captain selected. Archive the active Captain communication preference, but
retain already accepted `external_events` as Fleet evidence.

## Provider references

- [Create, configure and install a Discord bot](https://docs.discord.com/developers/quick-start/getting-started)
- [OAuth2 and bot permissions](https://docs.discord.com/developers/platform/oauth2-and-permissions)
- [Discord Gateway](https://docs.discord.com/developers/events/gateway)
- [Gateway intents and Message Content](https://docs.discord.com/developers/events/gateway#message-content-intent)
- [Interactions and responses](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Message components](https://docs.discord.com/developers/components/overview)
- [Server and channel management](https://docs.discord.com/developers/platform/server-and-channel-management)
- [Channel resources](https://docs.discord.com/developers/resources/channel)
- [Threads](https://docs.discord.com/developers/topics/threads)
- [Permissions and overwrites](https://docs.discord.com/developers/topics/permissions)
- [Discord channel permission setup](https://support.discord.com/hc/en-us/articles/10543994968087-Channel-Permissions-Settings-101)
