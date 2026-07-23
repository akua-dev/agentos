# Interactive Discord components

Read this reference before creating, updating or reconciling Discord buttons
or modals. Components are a compact Captain input surface over the existing
Discord Gateway, `external_events` and PostgreSQL reconciliation path. They do
not create a second command queue or execute Fleet effects directly.

- [Choose the interaction](#choose-the-interaction)
- [Publish a decision card](#publish-a-decision-card)
- [Reconcile a click](#reconcile-a-click)
- [Handle failure and repetition](#handle-failure-and-repetition)
- [Modal boundary](#modal-boundary)

## Choose the interaction

Prefer plain conversation when the Captain needs to explain, negotiate or add
context. Use buttons only for a small bounded choice whose consequences are
already legible in the message. Keep one status or decision card current rather
than posting a new progress message for every transition.

Use these released custom-ID shapes:

```text
agentos:follow-up:<opaque-correlation>
agentos:steer:<opaque-correlation>
agentos:stop:<opaque-correlation>
```

Keep the complete ID at most 100 characters. Make the correlation stable,
non-secret and meaningful only as a lookup key; never put credentials, private
content or an instruction body in it. The suffix after the delivery kind is
opaque to ingress, so it may include a bounded choice such as
`release-42:approve`.

`follow-up` means ordinary durable Captain input. `steer` and `stop` preserve
the requested intent for the Mate to reconcile against current authority and
runtime state. They do not immediately steer Pi, cancel a turn or emulate
terminal keystrokes. Exact immediate control waits for a reviewed public Pi
control boundary.

## Publish a decision card

Use the raw Discord REST primitive and observe its real response. Create
components only in the approved managed category or its descendants. This
example presents one bounded decision and suppresses accidental mentions:

```console
discord request POST /channels/<channel-id>/messages --axi <<'JSON'
{
  "content": "**Release 42 is ready.** Choose the next action.",
  "allowed_mentions": { "parse": [] },
  "components": [
    {
      "type": 1,
      "components": [
        {
          "type": 2,
          "style": 3,
          "label": "Approve",
          "custom_id": "agentos:follow-up:release-42:approve"
        },
        {
          "type": 2,
          "style": 2,
          "label": "Needs changes",
          "custom_id": "agentos:follow-up:release-42:changes"
        },
        {
          "type": 2,
          "style": 4,
          "label": "Stop",
          "custom_id": "agentos:stop:release-42"
        }
      ]
    }
  ]
}
JSON
```

Retain the returned channel and message IDs with the provider effect being
reconciled. Do not invent a parallel AgentOS component registry. A Task,
Captain decision or claimed external event remains the durable work identity.

Use at most five buttons in one action row. Keep labels explicit about the
effect; color alone is not meaning. Use the danger style only for a genuinely
destructive or stopping choice, and never make a consequential action look
like an informational acknowledgement.

## Reconcile a click

The Gateway delivers a recognized component as `INTERACTION_CREATE`. Ingress
accepts it inside a managed category for guild interactions or in a direct
message, replaces the temporary interaction token with `[REDACTED]`, persists it
through `agentos.ingest_external_event`, and then acknowledges the provider.
The ordinary `pg-listen agentos_events` continuity wait wakes the Mate; no
second Discord-specific Pi message exists.

When reconciling:

1. Claim the current Discord batch through the released external-event
   Functions.
2. Match the actor or applicable role against active
   `communication.discord` Captain authority. A valid button ID and Discord
   guild membership are not authority.
3. Reload the referenced Task, decision and runtime state. Treat the label as
   requested intent, not proof that the effect remains valid.
4. Call any Discord or other provider effect synchronously outside the
   database transaction and observe its status.
5. Assert the claim is current, commit coupled Fleet mutations and complete the
   claim in one short transaction.
6. Edit the original message to show the accepted result and disable every
   consumed or obsolete control.

For example, disable the resolved card instead of deleting its visible context:

```console
discord request PATCH /channels/<channel-id>/messages/<message-id> --axi <<'JSON'
{
  "content": "**Release 42 approved.** The reviewed delivery may proceed.",
  "allowed_mentions": { "parse": [] },
  "components": [
    {
      "type": 1,
      "components": [
        {
          "type": 2,
          "style": 3,
          "label": "Approved",
          "custom_id": "agentos:follow-up:release-42:approve",
          "disabled": true
        },
        {
          "type": 2,
          "style": 2,
          "label": "Needs changes",
          "custom_id": "agentos:follow-up:release-42:changes",
          "disabled": true
        },
        {
          "type": 2,
          "style": 4,
          "label": "Stop",
          "custom_id": "agentos:stop:release-42",
          "disabled": true
        }
      ]
    }
  ]
}
JSON
```

## Handle failure and repetition

- If the provider rejects message creation or editing, retain the real error
  and do not claim that the visible state changed.
- If persistence succeeds but Discord acknowledgement fails, the durable event
  still exists. Inspect its claim and the current provider message before
  retrying a non-idempotent effect.
- If another event arrives for the same channel while reasoning, absorb it
  through the released claim path and re-evaluate before committing.
- If the original message disappeared, inspect the channel once. Create a
  replacement only when the decision still needs a visible surface; do not
  recreate already resolved work.
- Treat repeated clicks, stale controls and clicks by unauthorized actors as
  reconciliation cases. They may justify a concise visible correction but do
  not justify duplicate Fleet or provider effects.

## Modal boundary

The released ingress can persist and acknowledge a recognized Discord modal
submission whose custom ID uses one of the AgentOS shapes. It does not yet open
a modal: Discord requires a modal to be the immediate response to another
interaction, while the released component path acknowledges with a deferred
message update. Do not promise or simulate modal UX through ordinary REST
calls. Use a thread or a normal follow-up message for free-form input until a
reviewed interaction responder owns modal creation and its timeout lifecycle.

Provider details remain defined by Discord:

- [Message components](https://docs.discord.com/developers/components/overview)
- [Receiving and responding to interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Channel and message resources](https://docs.discord.com/developers/resources/channel)
