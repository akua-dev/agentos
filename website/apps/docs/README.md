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
OpenNext build. `site:deploy` builds and deploys in one command. The Worker
build finishes with a native Wrangler dry run and fails if its compressed
upload exceeds Cloudflare Workers' 3 MiB free-plan limit.

Set `NEXT_PUBLIC_SITE_URL` to the public origin when building for a different
host. It defaults to `https://agentos.akua.dev` for production builds and to
localhost during development.

Anonymous website analytics use PostHog's cookieless mode, create no anonymous
person profiles, honor Do Not Track, disable session recording and send through
CNAP's first-party `https://ph.akua.dev` endpoint. Production builds on `main` use
CNAP's public PostHog project token by default. Non-production Workers Builds previews stay
disabled unless `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` explicitly overrides the
project. Set `NEXT_PUBLIC_POSTHOG_HOST` only to override the first-party
endpoint. Development stays disabled when no token override is present.

Both PostHog values are public browser configuration, not server secrets.
When overriding them in Cloudflare Workers Builds, remember that Next.js
embeds `NEXT_PUBLIC_*` values while building the client bundle;
`wrangler.jsonc` runtime variables cannot configure an already-built bundle.

The `agentos-site` production trigger in Cloudflare Workers Builds uses:

| Setting | Value |
| --- | --- |
| Root directory | `website/apps/docs` |
| Build command | `bun run build:worker` |
| Deploy command | `bun run deploy:worker` |
| Production branch | `main` |

Configure the optional preview trigger for every non-production branch with:

| Setting | Value |
| --- | --- |
| Root directory | `website/apps/docs` |
| Build command | `bun run build:worker` |
| Non-production branch deploy command | `bun run upload:worker` |
| Production branch exclusion | `main` |

That keeps preview builds on OpenNext's `versions upload` path instead of
letting Workers Builds fall back to a plain Wrangler upload.

`wrangler.jsonc` is the source of truth for the Worker name, entry point,
compatibility settings and asset binding. Cloudflare keeps the Git build and
deploy commands on the Workers Builds trigger: Wrangler has no deploy-command
field, and Workers Builds does not honor Wrangler's custom `build.command`.
Keep the trigger values above aligned with the package scripts rather than
adding an ineffective custom-build block to Wrangler.
