# First Mate runtime slice

This directory owns the first executable AgentOS runtime boundary: one Pi First
Mate inside one Herdr server, backed by one retained Kubernetes home volume.

## Selected design

- Keep the Mate image small: a glibc Linux base, Mise, OS transport
  dependencies, the official PostgreSQL client, and the reviewed AgentOS release
  files. Pi, Herdr, Bun, Node and Fleet CLIs are not copied in as a second baked
  toolchain; the image contains no PostgreSQL server.
- Run one non-root `StatefulSet` replica with a `volumeClaimTemplate`. The PVC
  stores the complete Agent home, including Pi sessions and authentication,
  Herdr session state, Mise-installed tools, agent-owned Mise additions and
  working repositories.
- The released root Mise pair remains the image's system configuration. A first
  init container invokes Mise directly to install the startup-critical Node,
  Bun, kubectl, Herdr and Pi tools. A second init container runs the typed
  `firstmate:prepare` task with Mise's task-level automatic tool installation
  disabled, so the broader Fleet configuration does not become an eager image
  bootstrap. The same boundary applies to run and health tasks. Both
  init containers and the running Mate use the same image and PVC, so there is
  no second image or duplicate layer download. A
  cold bootstrap may download them once; later pod replacements reuse the PVC.
  The remaining released Fleet tools stay available for explicit locked
  installation by the running Mate. `psql` comes from the exact PGDG
  `postgresql-client-18` package in the reviewed image instead of Mise's
  source-building PostgreSQL backend. Reconciliation never removes agent-owned
  tools or additions under `conf.d/`.
- Mise shims are available on `PATH`; released tools, agent-added tools and
  repository-local overrides are invoked by their normal command names.
- Home preparation and health commands use Bun Shell's `$` API. Herdr
  supervision uses `Bun.spawn` only where a long-lived signal-controlled
  process handle is required. All three are TypeScript executables registered
  as Mise file tasks; AgentOS runtime behavior is not implemented in
  repository-owned shell scripts or shell-backed task strings.
- Locked checksums remain mandatory. Runtime verification disables only the
  GitHub backend's online artifact-attestation and SLSA lookups so anonymous
  GitHub API rate limits are not a bootstrap dependency; other backend
  verification stays enabled.
- Install Herdr's official Pi integration, start one explicitly named Herdr
  server, and ensure one labeled First-Mate pane runs Pi from
  `agents/firstmate/`. Herdr and Pi use their native persisted session
  references after pod replacement; no terminal transcript is copied into a
  second state store.
- Keep the ServiceAccount namespaced in the base. A separate, explicit
  dedicated-cluster overlay binds it to `cluster-admin`; bootstrap must obtain
  approval before applying that overlay.
- Expose no public Service or Ingress. The Pod publishes its Agent, container
  and Herdr-session metadata so humans attach with
  `agentos attach firstmate --context <context>`; the later authentication step
  may temporarily port-forward Pi's localhost OAuth callback after approval.

First and Second Mates share this small Mate baseline by default and keep
different homes. A Mate that genuinely needs incompatible operating-system
dependencies may use another reviewed image, but ordinary tool additions belong
in its Mise-managed PVC rather than a new image build.

## Crewmate image selection

Crewmates do not inherit the Mate image as a universal development environment.
The responsible First or Second Mate selects an image suited to the task; a
large prebuilt Codex or language-stack image is therefore an opt-in task cost,
not part of every persistent Mate.

AgentOS will extend the predecessor's judgment-based `crew-dispatch.json`
profile with an optional `image` property alongside `harness`, `model` and
`effort`.

The model still matches natural-language rules. Deterministic launch mechanics
receive only the selected concrete harness, model, effort and image. An omitted
image uses the released lightweight Crewmate default; a configured remote image
must be from an approved registry and pinned by digest.

The first implemented worker path is the explicit co-located mode documented in
[`deploy/kubernetes/crewmate`](../crewmate/README.md). It supports trusted Codex
workers without an image override. A selected image requires the forthcoming
dedicated-pod primitive and is never ignored or replaced silently.

## Failure behavior

Herdr is the container's supervised process. If it exits, the container exits
and Kubernetes replaces the pod with the same PVC. A missing released tool,
invalid persisted configuration, ambiguous existing First-Mate pane or failed
native session recovery fails closed and leaves the terminal attachable for
inspection; startup never creates a second First Mate to hide the problem.

## Verification boundary

Fast tests execute cold and warm runtime preparation against a temporary home
and render the real Kustomize resources. A separately invoked lifecycle smoke
test may build the image and replace the pod against an explicitly selected
disposable cluster. It must prove that the PVC identity, Pi session reference,
Herdr pane identity, agent-added tool and ordinary Mise resolution from a
foreign worktree survive replacement.

## Not in this slice

This slice does not perform provider login, create PostgreSQL, apply the Fleet
schema, publish an image, install a GitHub App, or render dedicated Crewmate
pods. Those begin only after the persistent First Mate runtime is reachable.

## Development render

Build the local baseline image from the repository root, then render the base:

```sh
docker build -f deploy/kubernetes/firstmate/Dockerfile -t agentos-firstmate:dev .
kubectl kustomize deploy/kubernetes/firstmate/base
```

The checked-in `:dev` image reference is deliberately local-only. A released
bootstrap must replace it with its reviewed registry image pinned by digest.
Render `overlays/cluster-admin` only after the developer approves fleet-wide
control for a dedicated cluster.

The complete macOS OrbStack and portable kind workflows live in the repository
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
