---
name: agentos-harnesses
description: Select, configure, launch, inspect, resume, or change a verified AgentOS coding harness. Use before a First or Second Mate chooses a Crewmate harness, model or reasoning effort; before launching Pi or Codex through Herdr; or when harness authentication, flags, defaults, quota or recovery affect dispatch.
---

# Operate verified harnesses

Keep task judgment in the supervising Mate and pass only concrete choices to the
native harness.

## Select a profile

Use this precedence:

1. an explicit Captain choice for this Agent or Task;
2. durable Captain dispatch policy whose natural-language condition fits the
   task, selected by the Mate's judgment rather than first-match code;
3. the selected harness's own persisted or built-in defaults.

An omitted model or effort is meaningful. Omit its launch flag and let the
harness decide for persistent Mates. Never replace omission with a release-wide
AgentOS default.
Reject an unavailable or unverified harness instead of translating it to a
different one silently. Check current authentication and quota before choosing
an expensive profile, but do not let stale quota telemetry block dispatch.
Resolve the Fleet's durable model-capacity posture before treating a worker as
launch-ready. When it selects the recommended pooled path, load
`$agentos-ai-gateway`, verify that this workload is an approved client and
configure the selected harness through its native provider settings. Otherwise
verify direct auth owned by this Agent. Never turn direct provider auth into
pooled routing or switch credential kind/model silently. Gateway `401`, `429`, timeout and provider
failures remain native harness failures; do not hide them behind a prompt queue
or wrapper.

For a new Crewmate only, when neither an explicit Captain instruction nor the
matching durable dispatch policy selects effort, choose a native level
proportionally: low for a well-understood bounded path, xhigh for ambiguous
investigation or design, and intermediate levels as uncertainty, complexity or
blast radius grows. Never choose `max` from this fallback; it requires explicit
Captain preference. If the selected harness lacks the intended level, cap it at
its highest verified non-`max` value. This fallback is an Assignment decision,
not a Pi setting or persistent Agent default.

Read durable natural-language dispatch policy from scoped Captain state at
every Crewmate intake. Record the resolved harness and every selected
harness-native choice in the versioned composition manifest, with those native
choices under its opaque `settings` object. Keep natural-language policy out of
scripts and TypeScript unions.

## Keep worker harnesses unattended

A dedicated Agent Pod is the external execution sandbox. Every released
Crewmate harness must therefore have an empirically verified native unattended
launch mode; refuse an adapter that would leave routine tool execution waiting
on an interactive permission prompt. This removes a duplicate harness boundary,
not AgentOS authority checks: credentials, costs, RBAC, destructive operations,
delivery and Captain decisions still require their normal durable approval.

Repository trust is a separate credential boundary because project hooks and
exec policies run beside the harness credential. Before launch, the owning Mate
must inspect the effective repository-owned executable configuration. After
that review, satisfy the harness's workspace and hook trust gates explicitly.
Prefer a native per-launch trust flag. When an interactive harness has no such
workspace flag, preserve its existing private configuration and register only
the exact resolved Assignment worktree through its documented project-trust
entry before launch. Never trust a parent directory or filesystem root, copy
another Agent's configuration, or select a TUI trust prompt blindly.

## Pi

First and Second Mates run Pi. Their `~/.pi/agent/settings.json`, authentication
and sessions belong to their PVC; preserve them during release reconciliation.

The reviewed Pi CLI supports:

```console
pi
pi --model <provider/model>
pi --thinking <native-level>
pi --model <provider/model> --thinking <native-level>
pi --approve --no-skills \
  --skill <absolute-project-skill-root> \
  --skill <absolute-assignment-skill-directory> \
  --append-system-prompt <absolute-assignment-instructions-file>
```

Use bare `pi` when no explicit model or thinking choice exists. Before passing a
level, inspect the installed `pi --help`; Pi owns the accepted values. Do not
simulate TUI key presses, write defaults merely to avoid omission or install an
extension that reasserts AgentOS-selected defaults after login.

Pi has no separate command-approval bypass in this reviewed path. First and
Second Mate load only their reviewed role-local extensions and run directly
inside their dedicated Pods. For an inspected Assignment worktree,
`--approve` resolves Pi's project-resource trust boundary; it is not a command
approval. For a Crewmate, `--no-skills` plus repeatable explicit `--skill`
paths makes the Assignment catalog bounded while still allowing reviewed
project-owned Skill roots. Repeat `--append-system-prompt` for selected
instruction entrypoints. Do not copy those resources into the worktree or Pi
settings.

Before interactive launch, the same native loading arguments may be used with
Pi's RPC mode and `get_commands`. Require every selected `skill:<id>` to report
the expected explicit bundle path and reject an unselected Assignment path.
This checks discovery without a model turn; the live Herdr session still proves
that the intended worker received and used the brief.

For live resource changes, `/reload` reloads Pi's keybindings, extensions,
skills, prompt templates, themes and context files without replacing the
native session. It is not process recovery and does not apply a changed Pi
binary, environment, authentication state or dead runtime.

Before a deliberate exit, read the exact Herdr Agent and retain its
`agent_session` path. Exit Pi with `/quit`; resume that same session with
`pi --session <path-or-id>` from the recorded cwd and reviewed environment.

## Codex Crewmates

The reviewed Codex CLI supports a concrete model, its native configuration
override and the unattended mode intended for an externally sandboxed runtime:

```console
codex -c check_for_update_on_startup=false \
  --dangerously-bypass-approvals-and-sandbox \
  --dangerously-bypass-hook-trust
codex -c check_for_update_on_startup=false \
  --dangerously-bypass-approvals-and-sandbox \
  --dangerously-bypass-hook-trust --model <model>
codex -c check_for_update_on_startup=false \
  --dangerously-bypass-approvals-and-sandbox \
  --dangerously-bypass-hook-trust --model <model> \
  -c 'model_reasoning_effort="<effort>"'
```

Omit either flag when that axis was not chosen. Verify an effort value against
the installed Codex build before launch; do not generalize Pi's thinking levels
into a shared AgentOS enum. Use both `--dangerously-*` flags only after the Pod
boundary and repository executable-configuration review above are verified.
They are per-launch native arguments, never persistent global Codex defaults.
Keep `check_for_update_on_startup=false` per launch as well: AgentOS upgrades
the reviewed Codex version through Mise and an image or PVC reconciliation, not
through an interactive worker prompt or harness-owned global installation.

Codex's `--dangerously-bypass-hook-trust` flag bypasses hook review only. It
does not answer the separate `Do you trust the contents of this directory?`
gate, and a `-c projects...trust_level` launch override is not accepted early
enough to satisfy that gate in the reviewed interactive CLI. After inspecting
the exact worktree, merge only this entry into the Crewmate-owned mode-`0600`
`~/.codex/config.toml`, preserving every unrelated setting:

```toml
[projects."/absolute/assignment/worktree"]
trust_level = "trusted"
```

Do this before `herdr agent start`; a visible trust chooser means dispatch is
still blocked. `codex exec --skip-git-repo-check` is useful for a verified
headless probe, not a replacement for the persistent interactive Crewmate.

Codex does not expose a native Assignment `--skill` flag. Before launch, use
its documented user Skill discovery location in the Crewmate's dedicated home:
replace `$HOME/.agents/skills` with an exact, preverified directory of links
whose names are the selected Skill material IDs and whose targets are their
directories in the immutable Assignment bundle. Retain the previous directory
for rollback and refuse startup if any entry or resolved target differs. Do not
copy material, edit the project checkout or leave stale Assignment links.
Repository `.agents/skills`, `/etc/codex/skills` and Codex-bundled Skills remain
their own authorities. Put `$<material-id>` for every selected Assignment Skill
in the initial brief, then inspect Codex's native `/skills` catalog and exact
session before accepting loading as observed.

Before a deliberate exit, read the exact Herdr Agent and retain its
`agent_session` ID. Exit Codex with `/quit`; if the ID was not already known,
read the resume ID Codex prints in the same pane. Resume with `codex`'s native
`resume <session-id>` subcommand and the same currently reviewed unattended,
trust, model and effort flags that would apply to a fresh launch.

## Launch through Herdr

Run one pod-local Herdr server and launch the harness with its real argv:

```console
herdr agent start <handle> --cwd <worktree> --no-focus \
  --env AGENTOS_AGENT_ID=<uuid> \
  --env AGENTOS_TASK_ID=<uuid> \
  --env AGENTOS_ASSIGNMENT_ID=<uuid> \
  --session <session> -- <harness> <native-options> <brief>
```

Pass the complete brief as one argument or durable file according to the
harness's verified interface. Include the resolved native context-loading
arguments described above; Herdr does not discover Assignment Skills. Inspect
`herdr agent get` after launch. Native
harness stderr and exit status stay visible to the supervising Mate; do not
hide provider failures behind an AgentOS queue or wrapper. Launch is complete
only when the exact Agent record matches the intended harness and cwd and it
enters `working` without a trust or routine command-approval dialog. Retain its
native session reference when Herdr reports one. If the turn finishes before
inspection, require fresh durable or bounded terminal evidence from that exact
Agent instead of assuming the brief landed.

On recovery, read the recorded harness and native session reference, inspect
the live process first, then use that harness's native resume command. Never
start a duplicate merely because the terminal looks idle.

For another released harness, do not guess its slash commands or terminal
keys. Read its current public documentation and run `<harness> --help` in a
fresh, non-authoritative pane or process before touching the live Agent. Record
empirically verified exit, interrupt, resume, trust and unattended-launch facts
here before treating that harness as supported.
