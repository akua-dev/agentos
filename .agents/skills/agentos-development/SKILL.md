---
name: agentos-development
description: Develop, review, test, dogfood, or deliver changes to AgentOS itself from a local checkout or a running Fleet. Use when an Agent is asked to modify the AgentOS repository, choose an upstream versus organization-specific delivery path, prepare an AgentOS pull request, or run an unreleased AgentOS revision in First- or Second-Mate pods.
---

# Develop AgentOS

Preserve the active Agent role and Assignment. This skill does not grant permission to write directly, bypass delegation, merge, restart a Mate, or mutate infrastructure.

1. Resolve the writable Git checkout and read its `CONTRIBUTING.md` plus every applicable `AGENTS.md` before changing it. Treat `/opt/agentos` as the immutable Git seed baked into the running image, never as a development checkout or update target.
2. In a Fleet, use the primary Git clone under `$HOME/projects/agentos`; the harness reads its role instructions, Skills and Mise configuration directly from that persistent checkout. Create worktrees from this clone through the role's normal direct-work or delegated Treehouse workflow. Never edit `/opt/agentos` or copy source and Skills between it and the checkout.
3. Inspect remotes and intended audience before delivery. Send generally reusable work through the reviewed upstream `akua-dev/agentos` pull-request path. Keep organization-specific, private, or policy-bound work in that organization's fork or mirror and use its reviewed pull-request path. Never expose private material to upstream.
4. Follow `CONTRIBUTING.md` for setup, verification, disposable Kubernetes, image building and release mechanics instead of duplicating those procedures here. Run the smallest relevant checks while iterating. AgentOS selects no-mistakes for pull-request delivery: commit the feature branch, then let the installed no-mistakes workflow own validation, its local Git-proxy push, the provider branch push and pull-request creation. Do not open a parallel pull request; merge remains separately gated.
5. To dogfood an unreleased revision, load `$agentos-image-builds` and `$agentos-registry` as needed. Build the exact committed revision, deploy by immutable image digest, and update one Mate at a time. Preserve its home PVC, verify session recovery and the observed image digest, then continue or roll back. Do not represent a development image as an official AgentOS release.

At session start or after a Pod restart, fetch configured remotes read-only and compare the checkout HEAD with its upstream and the image seed. Report a newer revision; never switch a dirty checkout, install changed tools, reload Pi, or roll out an image without the applicable authority. Before dogfooding or evaluating AgentOS, complete the current-revision preflight in `CONTRIBUTING.md`: verify both the source revision and the instruction set actually loaded by each participating Mate. A current checkout alone is not proof that a persistent Pi session has loaded changed role files or Skills. For a reviewed Markdown or Skill-only update, change Git first and invoke Pi `/reload` at a safe turn boundary. Use a new image for OS packages, immutable runtime code or Kubernetes assets.

Git and its remote own delivered source. The persistent home owns unfinished work. The image digest owns the running AgentOS revision.

Follow the repository's root and nearer `AGENTS.md` for knowledge placement and
source ownership. For Kubernetes reuse, follow `ARCHITECTURE.md` and the nearer
`runtime/AGENTS.md`; do not infer a shared lifecycle from similar YAML alone.
Rewrite or prune stale guidance; a stow or memory sweep alone never creates a
Skill.
