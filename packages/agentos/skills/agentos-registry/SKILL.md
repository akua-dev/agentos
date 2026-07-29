---
name: agentos-registry
description: Select, establish, inspect, or retire an OCI registry for AgentOS and other Fleet-built software. Use when images need a registry, when a Fleet may deploy zot, when kubelet pull reachability or registry trust must be designed, or when choosing between a disposable development registry and a durable private organization registry.
---

# Operate a Fleet registry

1. Inspect existing registries, node reachability, TLS trust, authentication, storage and retention before proposing another deployment. Kubernetes pulls images through the node's kubelet/container runtime, not through the building Agent Pod; a ClusterIP name alone is therefore not a portable pull endpoint. Verify the selected path using the official [Kubernetes image guidance](https://kubernetes.io/docs/concepts/containers/images/).
2. Ask the Captain to choose the scope:
   - **Development:** recommend an on-demand [zot](https://zotregistry.dev/) registry for non-secret test images from AgentOS or any other Fleet project. Keep it private to the selected trust boundary, give it a small disposable PVC so a registry Pod restart does not erase an active test, define cleanup explicitly, and expose it only through a node-reachable TLS endpoint the platform can support.
   - **Organization:** reuse zot only after separately designing durable or object storage, authenticated pulls and pushes, retention and garbage collection, backups, monitoring, availability and recovery.
3. Follow zot's current official [Kubernetes installation](https://zotregistry.dev/latest/install-guides/install-guide-k8s/) and [authentication and authorization](https://zotregistry.dev/latest/articles/authn-authz/) documentation. Discover a compatible stable version, inspect its release provenance and pin every image by digest. Prefer workload identity or OIDC where the platform supports it; allow anonymous pull only inside an explicitly accepted network and content boundary. Never allow anonymous push.
4. Treat ingress, public or cross-network access, external CI, custom certificate authorities and node-runtime changes as separate approval branches. If the host cannot provide a node-reachable TLS-trusted endpoint, reuse an approved external registry instead of weakening every node with an insecure-registry exception.
5. Verify push, registry lookup and pull of one harmless image by immutable digest. Record the endpoint and ownership without hiding native client failures behind an AgentOS wrapper.
6. Before deleting a development registry, prove that no active workload or rollback still references its images. A durable registry is infrastructure, not temporary Fleet state, and requires its own reviewed retirement plan.

For vCluster with shared host nodes, design pull reachability and trust against the host kubelets, not only the virtual control plane.
