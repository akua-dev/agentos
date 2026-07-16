---
name: agentos-image-builds
description: Build, test, and publish OCI images safely from an exact Git revision inside or outside an AgentOS Fleet. Use when a First or Second Mate needs an unreleased image, must choose BuildKit or Buildah for an in-cluster build, or needs to make an immutable image digest available to Kubernetes without a host runtime socket.
---

# Build Fleet images

1. Resolve the exact committed Git revision, Dockerfile, target platforms, existing builder, target registry and node pull path. Stop on uncommitted source unless the Captain explicitly chooses a disposable local experiment that will not be represented as a release.
2. Load `$agentos-registry` when no approved registry and node-reachable pull path already exist. Ask before credentials, registry creation, cluster mutation, cost or external exposure.
3. Prefer an existing reviewed platform build service. For a new in-cluster path, start from the current official [BuildKit Kubernetes examples](https://github.com/moby/buildkit/tree/master/examples/kubernetes) and [rootless guidance](https://github.com/moby/buildkit/blob/master/docs/rootless.md):
   - on a compatible Kubernetes and runtime, prefer a one-shot BuildKit Job with a Pod user namespace (`hostUsers: false`);
   - otherwise use rootless BuildKit only after its user-namespace, seccomp/AppArmor, snapshotter and storage requirements pass a lifecycle test;
   - use [Buildah](https://github.com/containers/buildah/blob/main/docs/buildah-build.1.md) as a maintained alternative only where its unshare, UID/GID mappings and storage driver are verified.
4. Discover the current supported builder version from official documentation or releases and pin its image by digest. Do not introduce archived Kaniko, mount a host Docker/containerd socket, or grant host-namespace privilege as a shortcut. Root inside a Pod user namespace remains unprivileged on the host and can still execute ordinary package-installing Dockerfile steps; verify host support rather than assuming it.
5. Mount registry authentication through a reviewed Secret, workload identity or credential provider. Never place credentials in command arguments, image layers, build context or logs.
6. Build the exact commit with native `buildctl` or `buildah`, push it, read the registry-confirmed digest and use only `name@sha256:...` for testing or deployment. Verify that the target kubelet can pull that digest before changing a Mate.
7. Preserve build logs, source revision, builder identity and resulting digest as evidence. Roll out one Mate at a time and keep the previous digest available for rollback.

Treat vCluster shared nodes as host-node builds and pulls: the host runtime, filesystem and policy still determine support.
The AgentOS image contains a portable shallow Git seed. When building from a linked worktree, use a remote Git context at the exact pushed commit with BuildKit's `BUILDKIT_CONTEXT_KEEP_GIT_DIR=1` build argument instead of sending the worktree's host-specific `.git` indirection as a local build context. Set `AGENTOS_GIT_REMOTE` to the credential-free fork or project URL and keep `AGENTOS_GIT_UPSTREAM` on the public AgentOS upstream when appropriate.
