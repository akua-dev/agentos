# Optional Fleet quota router

This topology renders one authenticated, single-replica quota-router service with a
retained 1 GiB ReadWriteOnce PVC. It is not part of bootstrap or the Fleet
coordination kernel. Direct provider login inside each Agent remains complete.

Before applying the topology, First Mate creates the `quota-router-client` Secret in
the `agentos` namespace with a high-entropy `token` key through the Captain's
approved Secret workflow. The value is never committed or placed in argv. The
same Secret is mounted only into approved Agent Pods, which must also carry the
label `agentos.akua.dev/quota-router-client: "true"` to pass the NetworkPolicy.

The topology does not enable an OpenAI API-key fallback. Add `OPENAI_API_KEY` from a
separate Secret and `QUOTA_ROUTER_ALLOW_API_KEY_FALLBACK=true` only after the
Captain explicitly selects that fallback. Do not add an Ingress. Login and
harness configuration are defined by `$agentos-quota-router`.

The `agentos:dev` image is a contributor placeholder. Published resources use a
reviewed immutable AgentOS image digest.
