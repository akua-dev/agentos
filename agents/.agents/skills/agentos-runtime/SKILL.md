---
name: agentos-runtime
description: Inspect and operate AgentOS runtime pods, Herdr sessions, Mise toolchains, agent worktrees, terminals, PVCs, Kubernetes health, attach paths, layouts, co-located agents, and runtime recovery. Use for normal First- or Second-Mate operations, tool resolution, stuck-agent debugging, remote terminal access, pod or session recovery, and readiness diagnosis.
---

# Operate AgentOS runtime

Use Kubernetes for workload truth and the pod-local Herdr server for terminal truth.

## Inspect before action

1. Resolve an explicit Kubernetes context, namespace, workload and agent identity.
2. Inspect pod phase, readiness, ownership, PVC bindings and immutable release identity.
3. Query the target Herdr server for its agents, panes, semantic status and native harness session reference.
4. Explain the fault boundary before changing anything.

## Attach and debug

- Prefer `agentos attach <agent> --context <context> [--namespace <namespace>]` when CLI help advertises it. It must resolve exactly one Ready Pod from released AgentOS metadata and never fall back to the global current context. For an older release without that command, attach to First Mate with `kubectl --context <context> --namespace agentos exec -it pod/agentos-firstmate-0 --container firstmate -- herdr --session agentos-firstmate`.
- Attach to the real agent terminal for interactive diagnosis.
- Use Herdr read, status, send and wait primitives for bounded inspection; do not scrape or persist terminal output automatically.
- Treat a live terminal send as an immediate hint only. Keep durable inter-agent communication in PostgreSQL.
- Ask before interrupting, restarting, closing, taking over, or rearranging an existing user session.

## Runtime topology

- Run one pinned Herdr server per runtime pod.
- Keep First and Second Mates on Pi. Permit released worker harnesses such as Pi or Codex.
- Keep one durable home per agent. Explain the shared security boundary and ask before co-locating trusted agents in one pod.
- Allow ordinary processes beside agents in Herdr panes.
- Arrange optional fleet workspaces with Kubernetes-exec panes into remote pod-local Herdr sessions when requested; never treat that view as a controller.

## Resolve tools with Mise

1. Inspect effective configuration with `mise config ls`, requested versions with `mise ls --current`, and executable ownership with `mise which <tool>` before changing tools.
2. At image build time, install the released root `mise.toml`/`mise.lock` as `/etc/mise/config.toml`/`mise.lock`. Seed the released `agents/mise.toml`/`mise.lock` as the agent's global `~/.config/mise/config.toml`/`mise.lock` on its PVC. Install the startup-critical tools from both isolated layers before adding agent-owned entries under `~/.config/mise/conf.d/`; install remaining released tools explicitly when the task needs them.
3. Prepend Mise shims to `PATH` for interactive and non-interactive processes so released tools win over unmanaged globals. Verify ordinary tool names work without a `mise exec` prefix.
4. Let configuration in the current repository or worktree add tools and override conflicting baseline versions. Do not copy AgentOS's project config into another repository.
5. Inspect repository-owned Mise configuration before trust. Ask before trusting executable hooks or environment behavior that is not already approved with the project.
6. Put approved persistent agent additions in that agent's Mise configuration on its PVC. Change a repository-owned tool version only through the repository's normal delivery workflow.
7. Do not fall back to npm-global, Homebrew, apt, or `curl | sh` when a tool is absent. Report the missing reviewed Mise asset or request the appropriate scoped configuration change.

## Health and recovery

- Keep liveness limited to a technically functioning runtime.
- Fail readiness only for explicit, supported degradation classes on required agents; ordinary human-blocked state is not a readiness failure.
- Preserve attach access during provider, quota and rate-limit failures.
- Reuse the owned PVC and native harness session during pod replacement.
- Let the supervising model decide whether to retry, attach, rotate auth, change model, restart a process, or leave the agent stopped.

Use only released manifests and deterministic primitives. Fail closed on ambiguous ownership or missing runtime assets.
