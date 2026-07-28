# Mate topic contract

The executable schema in `runtime/memory/schema.ts` is authoritative. Use this
reference when editing a topic through native Pi file tools.

Each topic is a Markdown file beneath `topics/` with YAML frontmatter:

```markdown
---
node_type: memory
type: user
scope: fleet:local
source_principal: captain
observed_at: 2026-07-28T08:00:00.000Z
modified: 2026-07-28T08:00:00.000Z
pinned: false
---
The Captain prefers unresolved Fleet decisions to reach the selected forum.
This preference is context, not delivery proof or action authority.
```

Rules:

- `node_type` is exactly `memory`.
- `type` is exactly `user`, `feedback`, `project` or `reference`.
- `scope` and `source_principal` are non-empty, single-line strings.
- `observed_at` and `modified` are normalized ISO timestamps.
- `pinned` is a boolean. At most four pinned topics load.
- Paths are lowercase safe relative paths under `topics/` and end in `.md`.
- The runtime supports at most 200 topic files.
- Normal recall selects at most five relevant topics, and all topic
  attachments together stay within 61,440 bytes per Pi session.
- `MEMORY.md` is an index, not a growing memory body. Keep one concise link and
  retrieval hook per topic.

Do not manually edit `$HOME/memory/logs/`,
`$HOME/memory/.consolidate-lock`, or
`$HOME/.local/state/agentos/memory.json`; the runtime owns those derivative
and coordination files.
