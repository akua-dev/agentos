# AgentOS website

The AgentOS website contains the public landing page, reference documentation,
guided learning chapters and benchmark overview.

Run it from the repository root:

```console
bun run site:dev
bun run site:test
bun run site:lint
bun run site:typecheck
bun run site:build
```

The production target is Cloudflare Workers through OpenNext. Build and preview
the Worker locally with:

```console
bun run site:build:worker
bun run site:preview:worker
```

Set `NEXT_PUBLIC_SITE_URL` to the public origin when building for a different
host. It defaults to `https://agentos.akua.dev` for production builds and to
localhost during development. No deployment command is part of the repository;
publishing remains an explicit infrastructure action.
