# Contributing to AgentOS

AgentOS is a Bun monorepo with all repository tools selected through Mise.
Follow the root and every nearer `AGENTS.md` for instruction placement,
ownership and subtree boundaries. This file owns contributor setup and
verification. Never add an Agent identity as a commit co-author.
Read [`VISION.md`](./VISION.md) for project direction and core product bets.
Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) for system boundaries and the
annotated repository ownership map.

## Repository setup

Install Git and [Mise](https://mise.jdx.dev/), then let the reviewed repository
configuration provide Bun, Node, and the remaining development tools:

```console
git clone https://github.com/akua-dev/agentos.git
cd agentos
mise install --locked
bun run check
```

Invoke installed tools by their ordinary names. Do not add parallel global
installations through Homebrew, npm, or ad hoc download scripts when the tool
belongs in a repository or Agent Fleet Mise configuration.

AgentOS currently uses the exact Bun revision
`1.4.0-canary.1+3979cbe80`. Bun publishes 1.4 builds under a moving `canary`
release that deletes superseded assets, so the reviewed `mise.lock` uses
checksummed direct URLs to an immutable AgentOS toolchain prerelease containing
the unmodified upstream archives and their license/source notices. Bun alone
uses Mise's HTTP backend so no unrelated GitHub/SLSA verification is weakened.
Never
commit `releases/download/canary/...` URLs or rotating asset API IDs.

To review another canary upgrade, mirror only the seven normal upstream
platform archives into one immutable prerelease with Bun's exact license,
source and relinking notices, then update the requested revision, every locked
URL and checksum, and the Dockerfile revision assertion together. Verify a cold
`mise install --locked http:bun` on every released platform,
`bun --revision`, `bun run check`, and an exact-commit image build before
publication. A stable `bun-v1.4.0` or newer release should replace this
temporary mirror when available.

AgentOS runtime automation is written in Bun and TypeScript. Do not introduce
repository-owned shell scripts or hide runtime programs inside shell-backed
Mise task strings. A Mise task may point to a typed executable file.

## Contributing from a running Fleet

The checkout at `/opt/agentos` is a root-owned Git seed baked at the image's
exact source commit. It is intentionally immutable and is replaced with the
image when the Pod is replaced. On first start the runtime clones it locally,
without hard links, to `$HOME/projects/agentos` on the home PVC and carries its
configured remote URLs across. Do not edit the image seed.

The Mate harness reads its role instructions, Skills and Mise configuration
directly from that persistent clone. Keep its worktrees under the persistent
Agent home. First Mate's narrow direct-maintenance
exception applies only to such a writable checkout and remains subject to its
role rules; delegated changes use the ordinary isolated Treehouse worktree.
At session start a Mate may fetch configured remotes read-only and report an
available update, but it never changes a dirty checkout, installs changed tools
or restarts itself without authority.

Inspect Git remotes before publishing. Generally useful changes belong in a
reviewed pull request to `akua-dev/agentos`; organization-specific or private
changes belong in that organization's fork or mirror. AgentOS selects
`no-mistakes` for either pull-request path. Commit the feature branch and follow
the installed no-mistakes Skill and live CLI guidance instead of opening a
parallel pull request manually. No-mistakes installs a local bare-repository Git
proxy; after its pipeline passes, it forwards the validated branch to the
configured GitHub origin or fork and opens the pull request. It is not a hosted
Fleet Git server. Pull-request creation is part of the accepted ship delivery;
merge remains separately gated by the configured authority.
The selected project delivery workflow owns its validation and approval rigor.
Risk may justify proposing a different workflow, not stacking an unrequested
parallel review gate. Record backend or incident claims with date, exact pinned
version, commands and observed evidence rather than assumptions.

A Fleet may dogfood a committed change before upstream accepts it. Markdown
and Skill-only changes may be checked out in Git and loaded by Pi with
`/reload` at a safe turn boundary. Image, operating-system, runtime and
Kubernetes changes require building the exact commit through an approved build
and registry path, deploying the resulting immutable image digest to one Mate
at a time, and requiring every init and runtime
container in that Mate to use the same digest. Review the rendered Kubernetes
diff, preserve the existing home PVC, verify session recovery and the observed
image ID, then continue or roll back to the previous digest. Never update a
running release with `kubectl cp`, a mutable image tag, or uncommitted source,
and never present a development image as an official AgentOS release.

Before starting a dogfood or evaluation run, establish its current-revision
baseline:

1. Fetch configured remotes read-only and record the intended commit, the
   writable checkout HEAD, the image-seed commit and the running image digest.
   Stop and report any unexplained mismatch before collecting evidence.
2. Treat the instructions loaded by a persistent harness as runtime state, not
   as a consequence of the checkout being current. After checking out reviewed
   changes to `AGENTS.md`, Markdown or Skills, invoke Pi `/reload` in every
   participating Mate at a safe turn boundary and wait for its visible reload
   confirmation.
3. Start delegated work or evidence collection only after the source revision,
   loaded instruction set and, where executable behavior matters, immutable
   runtime image are the intended versions.

## Disposable Kubernetes on macOS

[OrbStack](https://docs.orbstack.dev/kubernetes/) is the recommended local
smoke-test environment on macOS. Its lightweight Kubernetes cluster uses the
same container engine as its Docker implementation, so a locally built image
is immediately available to Pods without a registry or a separate image-load
step. OrbStack also includes `kubectl`.

Enable Kubernetes in OrbStack and keep every command bound to its explicit
context:

```console
orb start k8s
docker build \
  --build-arg AGENTOS_GIT_REMOTE="$(git config --get remote.origin.url)" \
  --tag agentos:dev \
  .
kubectl --context orbstack apply --kustomize agents/firstmate/kubernetes/base
kubectl --context orbstack --namespace agentos rollout status statefulset/agentos-firstmate --timeout=10m
kubectl --context orbstack --namespace agentos get pods
kubectl --context orbstack --namespace agentos logs agentos-firstmate-0 --all-containers
kubectl --context orbstack --namespace agentos exec -it pod/agentos-firstmate-0 --container agentos -- herdr --session agentos-firstmate
```

The development manifests use `agentos:dev` with
`imagePullPolicy: Never`. Avoid `:latest`: Kubernetes normally tries to pull
that tag even when the image exists locally.

Use only a disposable cluster for destructive lifecycle checks. Deleting the
`agentos` namespace also deletes its retained home PVC:

```console
kubectl --context orbstack delete namespace agentos
```

For a portable alternative, use [kind](https://kind.sigs.k8s.io/). It requires
a compatible container runtime and an explicit local image load before apply:

```console
kind create cluster --name agentos
docker build \
  --build-arg AGENTOS_GIT_REMOTE="$(git config --get remote.origin.url)" \
  --tag agentos:dev \
  .
kind load docker-image agentos:dev --name agentos
kubectl --context kind-agentos apply --kustomize agents/firstmate/kubernetes/base
```

## Disposable Kubernetes from inside a cluster

When the checkout already runs in a Kubernetes Pod, use an
[OSS vCluster](https://www.vcluster.com/docs/vcluster/) with shared host nodes.
Do not start kind, k3d, Docker-in-Docker, or a nested container runtime inside
the Agent Pod. vCluster gives the Assignment an isolated Kubernetes API and
control-plane state while the existing cluster supplies the worker nodes.

Use one vCluster and one host namespace per Assignment or worktree. Creating it
mutates the host cluster, so inspect the current context and effective RBAC
first and obtain the required infrastructure approval. If the Agent cannot
create namespaces, a cluster administrator must provide one dedicated
namespace with permission to deploy an ordinary application there. Install the
reviewed CLI from the repository toolchain only when this test boundary is
needed. The explicit Helm driver is client-only; do not install vCluster
Platform or expose the test API through a cloud load balancer:

```console
mise install vcluster
export HOST_CONTEXT="$(kubectl config current-context)"
export VCLUSTER_NAME="agentos-${AGENTOS_ASSIGNMENT_ID:-manual}"
export VCLUSTER_NAMESPACE="$VCLUSTER_NAME"

kubectl --context "$HOST_CONTEXT" auth can-i create namespaces
kubectl --context "$HOST_CONTEXT" auth can-i create statefulsets.apps \
  --namespace "$VCLUSTER_NAMESPACE"

vcluster create "$VCLUSTER_NAME" \
  --context "$HOST_CONTEXT" \
  --namespace "$VCLUSTER_NAMESPACE" \
  --driver helm \
  --chart-version 0.35.2 \
  --connect=false
```

Keep the outer kubeconfig on the host cluster. Run each test command through
`vcluster connect` instead of changing its current context:

```console
vcluster connect "$VCLUSTER_NAME" \
  --context "$HOST_CONTEXT" \
  --namespace "$VCLUSTER_NAMESPACE" \
  --driver helm \
  --background-proxy=false \
  -- kubectl get namespaces
```

The shared-node mode is appropriate for Kubernetes API, RBAC, controller,
workload, PVC, and Pod-replacement behavior. It is not an independent worker
environment: tests of kubelet, node lifecycle, CNI, CSI, privileged workloads,
or host-level isolation require an explicitly approved disposable real cluster.

vCluster also does not build or distribute a changed AgentOS image. Before an
in-cluster lifecycle test, make the image available to the host workers by its
immutable digest through an approved existing registry and build path, render
the release manifest with that digest, and apply it through `vcluster connect`.
If no such path exists, stop at source, SQL, and rendered-manifest checks rather
than adding an ad hoc registry or privileged builder.

Load [`agentos-image-builds`](./agents/.agents/skills/agentos-image-builds/SKILL.md)
for builder selection and [`agentos-registry`](./agents/.agents/skills/agentos-registry/SKILL.md)
for registry design. The preferred new in-cluster candidate is a one-shot
BuildKit Job in a supported Kubernetes Pod user namespace; rootless BuildKit
and Buildah remain environment-dependent alternatives. Kaniko is archived.
Never mount the host container-runtime socket or put registry credentials in
command arguments.

When no approved registry already exists, the registry skill may establish an
on-demand zot registry for non-secret development images from any Fleet
project. A durable organization registry, external CI access, ingress and TLS
exposure are separate infrastructure decisions, not side effects of a smoke
test.

Delete the virtual cluster after the evidence has been collected. The command
also removes a namespace that this vCluster invocation created automatically;
do not delete an administrator-provided namespace without approval:

```console
vcluster delete "$VCLUSTER_NAME" \
  --context "$HOST_CONTEXT" \
  --namespace "$VCLUSTER_NAMESPACE" \
  --driver helm \
  --wait
```

## Change checks

Run the smallest relevant test while developing, then the repository check
before handing off a change:

```console
bun run check
```

Kubernetes behavior must be verified by rendering structured resources or by a
real lifecycle smoke test. Tests that merely search source files for arbitrary
strings are not accepted.

A harness becomes Fleet-eligible only after its pinned build has passed one
supervised lifecycle: authentication and first-run trust, isolated workspace,
native launch, busy/status inspection, short steer, interrupt, verified wake,
native resume, failure visibility and safe teardown. Do not silently substitute
an unverified harness. Follow the shared
[`agentos-harnesses`](./agents/.agents/skills/agentos-harnesses/SKILL.md) Skill
for the selected harness; a workspace-trust chooser or routine command approval
after dispatch means the unattended launch has not succeeded. Provider ingress
work also needs a fixture or sandbox
path that exercises raw payload preservation, classification, linkage and local
reconciliation without posting publicly.

## Stable release manifests

A GitHub release is optional for development and dogfooding: an exact Git
commit plus immutable OCI digest is sufficient. Stable releases are cut only
from an exact semantic-version tag whose commit is already on `main` with a
green required `check`. Push that tag once:

```console
git tag v<semver> <exact-commit>
git push origin v<semver>
```

The [`Release`](./.github/workflows/release.yml) workflow builds the same clean
tagged checkout on native GitHub-hosted amd64 and arm64 runners, publishes the
two platform images, joins them into one OCI index, resolves its registry
digest, and renders the ordinary human-readable block YAML directly from
Kustomize. It uploads the fixed-name scoped, cluster-admin and database
manifests to a draft GitHub release and publishes the release only after every
prior step succeeds. Repository release immutability then prevents replacing
the assets or tag. Never hand-edit a generated manifest, reuse a release tag,
or publish a local emulation build as the stable image.

The GHCR package grants this repository Actions access, so the workflow
publishes with only its short-lived repository `GITHUB_TOKEN`. Do not add a
long-lived registry token to workflow configuration, an image, command
arguments or release assets.

To inspect the renderer without cutting a release, run it locally only with an
already published immutable digest:

```console
mise install
bun run release/kubernetes/render.ts \
  --image ghcr.io/akua-dev/agentos@sha256:<digest> \
  --version <semver> \
  --output dist/release
```

The image build accepts only a clean Git checkout. Its intermediate stage
creates a shallow one-commit repository with credential-free `origin` and
optional `upstream` URLs; only that portable seed enters the final image. For a
linked worktree, build from the exact pushed Git context with BuildKit's Git
directory preservation instead of sending the worktree's host-specific `.git`
pointer as a local context.
