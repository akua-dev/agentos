# `@agentos/pi`

`@agentos/pi` is AgentOS's inert public TypeScript composition library for Pi
extensions. It exports plain structural contracts, pure preflight helpers and
functions that register behavior against an explicitly supplied Pi
`ExtensionAPI`.

Importing the package registers nothing and touches no Fleet authority.
PostgreSQL, Kubernetes, Herdr, Git, PVC and provider state remain available
through their native interfaces. A distribution chooses which registrations to
compose and Pi remains the only extension host.

The public surface includes:

- `preflightAgentOSComposition` and `registerAgentOSRuntime` for explicit
  registrations with declared tool, command, Skill, message and entry names;
- instruction and resource composition helpers;
- Pi-compatible startup contribution validation, pure startup preflight,
  bounded aggregation and one configurable `session_start` registration; and
- factories and defaults for the released background-task, memory, compaction
  and supervision behaviors.

Every registration accepts Pi's `ExtensionAPI` explicitly. Ecosystem packages
remain free to call ordinary `pi.on`, `pi.registerTool`,
`pi.registerCommand`, or any other supported Pi API beside these helpers.

The initial compatibility matrix is:

| `@agentos/pi` | Pi AI API | Pi coding-agent API |
| --- | --- | --- |
| `0.1.x` | `0.81.1` | `0.81.1` |

See the repository's `CUSTOMIZATION.md` and released
`agentos-customization` Skill for the complete trusted-package workflow.
