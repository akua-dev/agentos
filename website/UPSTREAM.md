# Website upstream

The AgentOS website began as a source copy of the real Fumadocs documentation
application:

- Repository: <https://github.com/fuma-nama/fumadocs>
- Commit: `a9a50313efcd72e23cae0a5c673c2d37ccfe339c`
- Copied path: `apps/docs`
- License: MIT; see [`LICENSE`](./LICENSE)

AgentOS retains the complete application source as its website foundation while
replacing the product content, routes, assets and destinations with AgentOS
material. Fumadocs packages are consumed at the exact published versions
declared by that upstream revision and locked by AgentOS's root `bun.lock`.

The upstream development monorepo, examples, release workflows, package-manager
state and unrelated packages are not vendored. AgentOS remains one Bun
workspace with one dependency lock.
