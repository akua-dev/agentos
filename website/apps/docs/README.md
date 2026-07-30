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

The production target is Cloudflare Workers through OpenNext. Build, preview,
or deploy the Worker from the repository root with:

```console
bun run site:build:worker
bun run site:preview:worker
bun run site:upload:worker
bun run site:deploy:worker
bun run site:deploy
```

`site:upload:worker` and `site:deploy:worker` operate on an existing
OpenNext build. `site:deploy` builds and deploys in one command.

The shared root `bun.lock` intentionally uses the lockfile format supported by
the Workers Builds image. Keep it at that format when refreshing dependencies;
the website build-contract test catches accidental upgrades to a newer format.

Set `NEXT_PUBLIC_SITE_URL` to the public origin when building for a different
host. It defaults to `https://agentos.akua.dev` for production builds and to
localhost during development.

The `agentos-site` production trigger in Cloudflare Workers Builds uses:

| Setting | Value |
| --- | --- |
| Root directory | `website/apps/docs` |
| Build command | `bun run build:worker` |
| Deploy command | `bun run deploy:worker` |
| Production branch | `main` |

`wrangler.jsonc` is the source of truth for the Worker name, entry point,
compatibility settings and asset binding. Cloudflare keeps the Git build and
deploy commands on the Workers Builds trigger: Wrangler has no deploy-command
field, and Workers Builds does not honor Wrangler's custom `build.command`.
Keep the trigger values above aligned with the package scripts rather than
adding an ineffective custom-build block to Wrangler.
