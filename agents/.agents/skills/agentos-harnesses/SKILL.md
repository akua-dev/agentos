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

For a new Crewmate only, when neither an explicit Captain instruction nor the
matching durable dispatch policy selects effort, choose a native level
proportionally: low for a well-understood bounded path, xhigh for ambiguous
investigation or design, and intermediate levels as uncertainty, complexity or
blast radius grows. Never choose `max` from this fallback; it requires explicit
Captain preference. If the selected harness lacks the intended level, cap it at
its highest verified non-`max` value. This fallback is an Assignment decision,
not a Pi setting or persistent Agent default.

Read durable natural-language dispatch policy from scoped Captain state at
every Crewmate intake. Record the resolved harness and only the model, effort or
image values actually chosen in `task_assignments.dispatch_profile`. Keep
natural-language policy out of scripts and TypeScript unions.

## Keep worker harnesses unattended

A dedicated Agent Pod is the external execution sandbox. Every released
Crewmate harness must therefore have an empirically verified native unattended
launch mode; refuse an adapter that would leave routine tool execution waiting
on an interactive permission prompt. This removes a duplicate harness boundary,
not AgentOS authority checks: credentials, costs, RBAC, destructive operations,
delivery and Captain decisions still require their normal durable approval.

Repository trust is a separate credential boundary because project hooks and
exec policies run beside the harness credential. Before launch, the owning Mate
must inspect the effective repository-owned executable configuration. Use a
native non-interactive trust flag only after that review; otherwise refuse the
launch before creating a blocked work agent. Do not edit a harness-managed
trust store or grant global trust merely to suppress a dialog.

## Pi

First and Second Mates run Pi. Their `~/.pi/agent/settings.json`, authentication
and sessions belong to their PVC; preserve them during release reconciliation.

The reviewed Pi CLI supports:

```console
pi
pi --model <provider/model>
pi --thinking <native-level>
pi --model <provider/model> --thinking <native-level>
```

Use bare `pi` when no explicit model or thinking choice exists. Before passing a
level, inspect the installed `pi --help`; Pi owns the accepted values. Do not
simulate TUI key presses, write defaults merely to avoid omission or install an
extension that reasserts AgentOS-selected defaults after login.

Pi has no separate command-approval bypass in this reviewed path. First and
Second Mate load only their reviewed role-local extensions and run directly
inside their dedicated Pods.

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
harness's verified interface. Inspect `herdr agent get` after launch. Native
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
