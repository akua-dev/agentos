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
harness decide. Never replace omission with a release-wide AgentOS default.
Reject an unavailable or unverified harness instead of translating it to a
different one silently. Check current authentication and quota before choosing
an expensive profile, but do not let stale quota telemetry block dispatch.

Record the resolved harness and only the model or effort values actually chosen
in Fleet state. Keep natural-language policy out of scripts and TypeScript
unions.

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

## Codex Crewmates

The reviewed Codex CLI supports a concrete model and its native configuration
override:

```console
codex
codex --model <model>
codex --model <model> -c 'model_reasoning_effort="<effort>"'
```

Omit either flag when that axis was not chosen. Verify an effort value against
the installed Codex build before launch; do not generalize Pi's thinking levels
into a shared AgentOS enum. Use the selected image's external sandbox boundary
before considering `--dangerously-bypass-approvals-and-sandbox`.

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
hide provider failures behind an AgentOS queue or wrapper.

On recovery, read the recorded harness and native session reference, inspect
the live process first, then use that harness's native resume command. Never
start a duplicate merely because the terminal looks idle.
