# Optional Fleet AI Gateway

This topology renders one authenticated, single-replica Fleet AI Gateway with a
retained 1 GiB ReadWriteOnce PVC. It is not part of bootstrap or the Fleet
coordination kernel. Direct provider login inside each Agent remains complete.
The Kubernetes objects, Service DNS, Secret and PVC path use the `ai-gateway`
identity consistently.

Storage provisioners do not agree on initial PVC ownership or mode. A short
init container from the same AgentOS image therefore takes ownership of the
retained mount and sets it to mode `0700` before the capability-free, non-root
gateway starts. The init container receives only `CHOWN`; it runs no shell and
does not read gateway credentials.

Before applying the topology, First Mate creates the `ai-gateway-client` Secret in
the `agentos` namespace with a high-entropy `token` key through the Captain's
approved Secret workflow. The value is never committed or placed in argv. The
same Secret is mounted only into approved Agent Pods, which carry the label
`agentos.akua.dev/ai-gateway-client: "true"` to pass the NetworkPolicy.
This is defense in depth only where the cluster CNI enforces Kubernetes
NetworkPolicy; verify that behavior in the target cluster instead of treating
the manifest's existence as proof of isolation.

The topology does not enable an OpenAI API-key fallback. Add `OPENAI_API_KEY` from a
separate Secret and `AI_GATEWAY_ALLOW_API_KEY_FALLBACK=true` only after the
Captain explicitly selects that fallback. Do not add an Ingress. Login and
harness configuration are defined by `$agentos-ai-gateway`.

The `agentos:dev` image is a contributor placeholder. Published resources use a
reviewed immutable AgentOS image digest.
