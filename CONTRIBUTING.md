# Contributing to AgentOS

AgentOS is a Bun monorepo with all repository tools selected through Mise. Keep
changes close to the app, package, agent role, or deployment asset that owns
them, and follow any nearer `AGENTS.md` instructions.

## Repository setup

Install Git and [Mise](https://mise.jdx.dev/), then let the reviewed repository
configuration provide Bun, Node, and the remaining development tools:

```console
git clone https://github.com/akua-dev/agentos.git
cd agentos
mise install
bun run check
```

Invoke installed tools by their ordinary names. Do not add parallel global
installations through Homebrew, npm, or ad hoc download scripts when the tool
belongs in a repository or Agent Fleet Mise configuration.

AgentOS runtime automation is written in Bun and TypeScript. Do not introduce
repository-owned shell scripts or hide runtime programs inside shell-backed
Mise task strings. A Mise task may point to a typed executable file.

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
docker build --tag agentos:dev .
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
docker build --tag agentos:dev .
kind load docker-image agentos:dev --name agentos
kubectl --context kind-agentos apply --kustomize agents/firstmate/kubernetes/base
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

## Release manifests

Render release assets only after the multi-platform image has been published
and its registry digest is known:

```console
mise install
bun run agents/firstmate/kubernetes/release/render.ts \
  --image ghcr.io/akua-dev/agentos@sha256:<digest> \
  --version <semver> \
  --output dist/release
```

Publish all generated manifests on a draft GitHub release, then publish it with
release immutability enabled. Never hand-edit a generated manifest or reuse a
release tag or image digest for different contents.
