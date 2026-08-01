# Optional Fleet AI Gateway

This topology renders one authenticated, single-replica Fleet AI Gateway with a
retained 1 GiB ReadWriteOnce PVC. It is not part of bootstrap or the Fleet
coordination kernel. Direct provider login inside each Agent remains the
complete minimal and recovery path; the gateway is for a delegation-ready Fleet
with Captain-approved pooled capacity.
The Kubernetes objects, Service DNS, Secret and PVC path use the `ai-gateway`
identity consistently.

This directory owns only the service. Optional client wiring stays with each
workload owner:

- `packages/agentos/resources/roles/firstmate/kubernetes/patches/ai-gateway-client.yaml`;
- `packages/agentos/resources/roles/secondmate/kubernetes/patches/ai-gateway-client.yaml`;
- `packages/agentos/resources/crewmates/default/kubernetes/patches/ai-gateway-client.yaml`.

Compose the patch only in a reviewed overlay for an approved client. Applying
all selected patches creates the in-cluster pooled posture; applying only
worker or automation patches while Mates retain direct OAuth creates the mixed
posture. `$agentos-ai-gateway` owns the exact operator Secret, login, client
configuration, verification, recovery and retirement workflow.

Storage provisioners do not agree on initial PVC ownership or mode. A short
init container from the same AgentOS image therefore takes ownership of the
retained mount and sets it to mode `0700` before the capability-free, non-root
gateway starts. The init container receives only `CHOWN`; it runs no shell and
does not read gateway credentials.

Before applying the topology, First Mate creates `Secret/ai-gateway-operator`
in the `agentos` namespace with a high-entropy `token` key through the
Captain's approved Secret workflow. It protects only `/status` and
`/readyz/client`; it is not accepted as inference client authentication and is
never mounted into Agent or Agentgateway Pods. Agentgateway Pods carry
`agentos.akua.dev/ai-gateway-upstream: "true"`, the only selector admitted by
the AI Gateway NetworkPolicy. Agents instead authenticate to Agentgateway with
the kubelet-rotated projected identity already mounted by the workload base.

The topology does not enable an OpenAI API-key fallback. Add `OPENAI_API_KEY` from a
separate Secret and `AI_GATEWAY_ALLOW_API_KEY_FALLBACK=true` only after the
Captain explicitly selects that fallback. Do not add an Ingress. Login and
harness configuration are defined by `$agentos-ai-gateway`.

Do not route a Cloudflare Worker into this Service. A standalone Worker is an
exceptional separate router for a deployment that also serves non-AgentOS
clients; it is not the preferred AgentOS topology.

The `agentos:dev` image is a contributor placeholder. Published resources use a
reviewed immutable AgentOS image digest.
