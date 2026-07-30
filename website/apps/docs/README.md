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

The build binds the OpenNext artifact to the exact 40-character Git revision
that produced it. Publishing fails if that artifact came from tracked,
uncommitted changes, if the checkout changed after the build, or if
`WORKERS_CI_COMMIT_SHA` disagrees with Git. Production and preview versions
receive native Wrangler `tag` and `message` annotations containing the full
revision. Rendered responses expose the same revision in
`X-AgentOS-Git-SHA`.

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

The selected PostHog project must enable the stateful **Cookieless server hash
mode** under **Project Settings → Web analytics**. PostHog accepts the browser
requests but ignores their events while that project setting is disabled.

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

Set the public GitHub Actions repository variable
`AGENTOS_WORKERS_PREVIEW_SUFFIX` to the Worker hostname suffix shown by
Wrangler, without a protocol or branch alias, for example
`agentos-site.<workers-subdomain>.workers.dev`. Pull requests from branches in
this repository then receive a **website preview** check. It waits for the
branch alias, verifies that `X-AgentOS-Git-SHA` equals the pull-request head
revision, confirms the production hostname is not serving that revision, and
links the preview from the check summary. Fork pull requests do not receive
the preview check because their branches are outside the configured
Cloudflare Git source.

`wrangler.jsonc` is the source of truth for the Worker name, entry point,
compatibility settings and asset binding. Cloudflare keeps the Git build and
deploy commands on the Workers Builds trigger: Wrangler has no deploy-command
field, and Workers Builds does not honor Wrangler's custom `build.command`.
Keep the trigger values above aligned with the package scripts rather than
adding an ineffective custom-build block to Wrangler.

## Inspect and roll back a deployment

Use Cloudflare and Git directly; no AgentOS deployment state exists outside
those systems.

```console
bunx --bun wrangler deployments list
bunx --bun wrangler versions view <active-version-id> --json
git fetch origin main
git rev-parse origin/main
curl --silent --show-error --head https://agentos.akua.dev/
```

The active version's native `tag` and `message`, the response's
`X-AgentOS-Git-SHA`, and `origin/main` must name the same full revision after a
production build. Cloudflare Workers Builds also records the Git revision for
the version in its build details.

Before rolling back, inspect the target version and record its annotated Git
revision. Roll back to that immutable Worker version, including the revision
in the reason:

```console
bunx --bun wrangler versions view <target-version-id> --json
bunx --bun wrangler rollback <target-version-id> --message "Rollback to Git revision <full-git-sha>" --yes
```

Afterward, repeat the deployment, version and response-header inspection. A
rollback changes the active Cloudflare artifact; it does not rewrite Git.
