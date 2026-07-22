# Rich Discord embeds

Read this reference before creating or updating a Discord decision, Task,
delivery or status card. Rich embeds are compact Captain-facing projections of
current Fleet state. They do not create another Task system, durable record or
fixed AgentOS dashboard.

- [Choose the surface](#choose-the-surface)
- [Accept free-form feedback](#accept-free-form-feedback)
- [Design a useful card](#design-a-useful-card)
- [Link context and recommend an action](#link-context-and-recommend-an-action)
- [Publish a decision card](#publish-a-decision-card)
- [Publish a Task card](#publish-a-task-card)
- [Publish a delivery card](#publish-a-delivery-card)
- [Keep the projection current](#keep-the-projection-current)
- [Provider boundaries](#provider-boundaries)

## Choose the surface

Use the smallest surface that makes the next human action clear:

- Use plain text for a short answer, ordinary conversation or one link.
- Use an embed when several stable facts need visual hierarchy.
- Add buttons only for a small bounded choice whose consequences are already
  legible. Read `interactive-components.md` before adding them.
- Invite a direct reply for nuanced feedback. Use a thread when the discussion
  is likely to continue or would otherwise crowd the domain channel.
- Edit one existing card for meaningful state transitions instead of posting a
  new message for every internal update.

Do not automatically project every Task. Surface work that needs Captain
attention, communicates a meaningful outcome or provides a useful shared view.
Routine Fleet coordination remains in PostgreSQL and between the responsible
Mates.

The useful mental model is:

```text
embed         concise current picture
buttons       bounded requested intent
reply/thread  nuanced human input
PostgreSQL    authoritative coordination state
Git/provider  delivered artifact or external workflow authority
```

## Accept free-form feedback

A Captain may reply directly to a card without clicking a button first. The
Gateway persists the ordinary `MESSAGE_CREATE` delivery, including its Discord
message reference, through the same external-event path as other approved
messages. Reconcile the referenced card, authenticated actor and current Fleet
state before applying the feedback.

Treat a **Needs changes** click as intent, not as the change request itself.
If the context does not already contain the requested changes, edit or reply to
the card with one concise invitation to reply, or open a thread when discussion
is likely to be multi-turn. Do not force the Captain to repeat useful text in a
button flow.

Prefer Discord's native reply reference over copying a decision ID into human
prose. Keep stable Task, decision and provider message IDs in the reconciled
Fleet record or provider metadata where they help recovery; they need not
dominate the visible card.

## Design a useful card

Lead with the outcome or choice. Include only fields that change the Captain's
understanding or action, commonly:

- the current outcome, question or delivery;
- the accountable owner;
- one useful status and its consequence;
- one primary recommendation and its brief rationale when a decision is asked;
- a real blocker or remaining decision;
- the durable artifact or provider link;
- concise verification evidence.

Keep internal assignment IDs, database mechanics, background waits, pod names
and harness details out of normal Captain-facing cards unless they are the
subject of the decision or diagnosis. Do not expose credentials, raw model
reasoning, private prompts or unreviewed terminal output.

Use a short `content` line as the notification or plain fallback and let the
embed carry hierarchy; do not duplicate the full card in both. Set
`allowed_mentions` deliberately on every create and edit so provider text or
user-supplied content cannot produce accidental pings.

## Link context and recommend an action

Every actionable card should link to the authoritative context that actually
exists. Give the Captain a one-click path to understand why the action arose
and another to inspect what is being reviewed:

- Link the originating issue, tracker item or discussion as **Context**.
- Link the pull request, commit, deployment, run or other artifact as
  **Review**.
- Use the embed's top-level `url` for the single most useful destination and
  concise Markdown links in a field for additional relevant sources.

Prefer one primary link and one or two supporting links over a dump of every
related URL. Label each destination by what authority it represents. Do not
fabricate a link when work exists only in the AgentOS coordination ledger, and
do not expose a private destination to a Discord audience that lacks access.
The link provides context; the named provider or Git remains authoritative.

For a Captain decision, contribute judgment instead of forwarding an option
list neutrally. Give one primary recommendation, the reason it best serves the
outcome and the material trade-off. Give more than one recommendation only
when the paths are genuinely co-equal or conditional; state the condition that
makes each one preferable. If evidence is insufficient, recommend the next
fact-finding step and name the missing evidence rather than pretending to have
confidence.

Keep the controls faithful to the available choices. Visual emphasis may make
the recommendation legible, but it must not make a consequential alternative
look unavailable or pre-authorized.

## Publish a decision card

This example combines a rich embed with the released bounded controls. Adapt
the prose, fields, links and opaque correlation to the real decision:

```console
discord request POST /channels/<decisions-channel-id>/messages --axi <<'JSON'
{
  "content": "Captain decision requested. Reply to this card if the options need context.",
  "allowed_mentions": { "parse": [] },
  "embeds": [
    {
      "title": "Decision · Release 42",
      "url": "https://github.com/example/project/issues/42",
      "description": "Should the reviewed revision become the next release?",
      "color": 16103746,
      "fields": [
        {
          "name": "Why now",
          "value": "The selected revision passed its declared checks and is ready for the Captain's release authority."
        },
        {
          "name": "Consequences",
          "value": "**Approve:** permit the reviewed release step.\n**Needs changes:** return it with feedback.\n**Stop:** discontinue this delivery."
        },
        {
          "name": "Recommendation",
          "value": "**Approve.** The reviewed change satisfies the declared outcome and checks; the remaining trade-off is accepting the normal release rollback risk."
        },
        {
          "name": "Context and review",
          "value": "[Why this exists · Issue 42](https://github.com/example/project/issues/42) · [Review the change · Pull request 42](https://github.com/example/project/pull/42)"
        },
        {
          "name": "Owner",
          "value": "First Mate",
          "inline": true
        },
        {
          "name": "Status",
          "value": "Awaiting Captain",
          "inline": true
        }
      ],
      "footer": { "text": "Release 42 · decision pending" }
    }
  ],
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

## Publish a Task card

A Task card is a selective human view, not a row-by-row database mirror. Use a
provider or Git URL as the card link when one exists and keep ownership and the
next meaningful state obvious:

```console
discord request POST /channels/<tasks-channel-id>/messages --axi <<'JSON'
{
  "content": "Task view updated.",
  "allowed_mentions": { "parse": [] },
  "embeds": [
    {
      "title": "In progress · Reduce bootstrap time",
      "url": "https://github.com/example/project/issues/42",
      "description": "Make first contact predictable without adding another orchestration service.",
      "color": 3900150,
      "fields": [
        {
          "name": "Owner",
          "value": "Bootstrap Crewmate",
          "inline": true
        },
        {
          "name": "Current state",
          "value": "Implementation and isolated verification are active.",
          "inline": true
        },
        {
          "name": "Next visible outcome",
          "value": "A reviewable branch with measured before-and-after bootstrap evidence."
        }
      ],
      "footer": { "text": "AgentOS Task · meaningful transitions only" }
    }
  ]
}
JSON
```

Do not add controls merely because a Task exists. Add them only when the Task
has reached a real bounded Captain choice.

## Publish a delivery card

Lead with the durable artifact and evidence. Make the remaining human action
explicit; omit controls when review should happen in the linked provider:

```console
discord request POST /channels/<deliveries-channel-id>/messages --axi <<'JSON'
{
  "content": "Delivery ready for review.",
  "allowed_mentions": { "parse": [] },
  "embeds": [
    {
      "title": "Review ready · Pull request 42",
      "url": "https://github.com/example/project/pull/42",
      "description": "The Discord Captain surface now preserves free-form replies while keeping bounded decisions compact.",
      "color": 5763719,
      "fields": [
        {
          "name": "Delivered",
          "value": "Rich decision, Task and delivery-card guidance with raw Discord payloads."
        },
        {
          "name": "Verified",
          "value": "Skill validation, JSON parsing and the repository check suite passed."
        },
        {
          "name": "Remaining action",
          "value": "Review and merge in GitHub. Reply here only when coordination context is useful."
        },
        {
          "name": "Context",
          "value": "[Why this was built · Issue 42](https://github.com/example/project/issues/42)"
        }
      ],
      "footer": { "text": "Git remains delivery authority" }
    }
  ]
}
JSON
```

## Keep the projection current

Retain the provider message ID when the card has a continuing lifecycle. Read
the authoritative Task, Assignment, decision, Git artifact or external event
again before editing. Call `discord request` synchronously, observe the real
provider response and then reconcile the returned provider state with the
Fleet record in the short transaction that owns the coupled local change.

Edit the existing message with `PATCH
/channels/<channel-id>/messages/<message-id>`. Send every field whose visible
state must remain correct, including `allowed_mentions`; Discord edit requests
do not inherit the create request's mention policy. Disable consumed or stale
buttons as described in `interactive-components.md`.

Do not continuously mirror noisy internal progress. Edit on a meaningful
transition such as accepted, active, blocked, review-ready, resolved, failed or
superseded. Preserve discussion history in replies or a thread rather than
rewriting human messages.

If a provider call has an ambiguous outcome, inspect the target message once
before retrying creation. Never let a Discord card claim a Task, decision or
delivery state that the named authority does not support.

## Provider boundaries

The ordinary embed plus action-row shape used here is deliberately compatible
with the released interaction ingress. Do not set Discord's
`IS_COMPONENTS_V2` message flag on these examples: that mode replaces ordinary
`content` and `embeds` with component-native layouts and needs a separate
reviewed design and ingress lifecycle.

Stay comfortably below provider limits. Discord currently permits up to 25
fields in one embed and 6,000 combined characters across the textual embed
fields in one message. Check the current provider reference before approaching
any limit; a compact card is preferable to maxing it out.

Provider details remain defined by Discord:

- [Message and embed resource](https://docs.discord.com/developers/resources/message)
- [Message components](https://docs.discord.com/developers/components/overview)
- [Receiving and responding to interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
- [Threads](https://docs.discord.com/developers/topics/threads)
