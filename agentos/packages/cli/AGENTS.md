# External AgentOS CLI boundary

This package implements commands for humans and seed or operations agents
running outside the AgentOS cluster.

- Keep every Kubernetes context explicit. Never silently use the current
  context for a mutating operation.
- Do not add commands intended for First Mate, Second Mate or Crewmate runtime
  orchestration inside the cluster.
- Do not wrap `kubectl`, `psql`, `gh-axi`, `herdr`, `treehouse`, Mise or a
  harness merely to rename or proxy their arguments. External commands must add
  a genuine AgentOS boundary such as safe discovery or attach behavior.
- Keep `agentos/apps/agentos` a thin executable that imports this package.
- Preserve AXI structured output and surface native tool failures without
  hiding them behind asynchronous queues.
