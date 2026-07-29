# Importable package boundary

This subtree owns reusable libraries and distributions consumed by a real
AgentOS runtime. A package is not a new Fleet authority, process supervisor,
plugin registry or activation database.

- Keep PostgreSQL, Kubernetes, Herdr, Git, PVCs and provider systems behind
  their native interfaces. Package presence never proves or applies external
  state.
- Importing a package must not write files, spawn processes, start timers,
  connect to external systems or register process-global state.
- Use normal package exports and Pi's native package/resource model. Do not add
  an AgentOS loader, singleton, event bus or package manager.
- Keep cross-package contracts structural. Do not rely on shared class,
  symbol, module or `instanceof` identity.
- Test observable public behavior and clean installed artifacts. Source-tree
  imports alone do not prove a publishable package is complete.

A nearer `AGENTS.md` owns the public contract and distribution rules for its
package.
