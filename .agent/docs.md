# apps/docs

Next.js + [Nextra](https://nextra.site) docs site, built as a static export and deployed to Cloudflare Pages. Source content lives under [docs/](../docs/) at the repo root, **not** under `apps/docs/content/`.

`pnpm`, Node 24, Next 15, Nextra 4. `pagefind` runs as a postbuild step to generate the search index.

## Running locally

```sh
just docs              # apps/docs && pnpm dev
```

This serves on `localhost:3000`. Nextra hot-reloads MDX without a full restart.

## Deploying

[.github/workflows/build-docs.yml](../.github/workflows/build-docs.yml) and `deploy-docs.yml` build and deploy via Wrangler. PRs get preview deploys; cleanup runs on close (`cleanup-docs-preview.yml`).

## Tone and style

The docs aim for a calm, direct voice.

.dev:

- **Scaffold before instruction.** Tell the reader what they're about to do, then do it.
- **Don't euphemise.** This is a sex machine; the docs talk about strokes and depth without shyness.
- **Ticked lists for prerequisites.** "Before you start: [ ] OSSM assembled, [ ] toolchain installed, [ ] motor wired."
- **Firmer for safety pages.** Don't soften warnings about pinch points, electrical safety, or runaway motion.
- **Assume competence.** There is tooling for non-programmers, assume users going deeper know how to flash an ESP and run `pnpm`. Skip the basics unless they're project-specific.

## What goes here vs in `.agent/`

- [docs/](../docs/) is for **users and contributors** - end-user-facing prose. How to flash firmware, how to add a pattern, how the architecture works at a level that's useful from outside the codebase.
- [.agent/](../) is for **AI agents (and developers using them)** - rules and context that an agent needs to make good decisions inside the repo.

There will be overlap (architecture, philosophy). When you find a fact that's true and useful for both audiences, write it once and link the other side. Don't paste it into both - they will drift. Lean toward /docs as the source of truth.

## When to change

- New page in [docs/](../docs/) - add an entry to the relevant `_meta.ts`. Use the existing voice.
- Component changes (custom callouts, embeds): in [apps/docs/mdx-components.tsx](../apps/docs/mdx-components.tsx).
- Theme/sidebar/header: in [apps/docs/app/layout.tsx](../apps/docs/app/layout.tsx).

## When not to

- Don't put long-lived agent instructions in [docs/](../docs/). Those go in `.agent/`.
- Don't add a JS framework or a CMS. The current setup (MDX + Nextra + static export) is deliberately minimal so contributors can edit a markdown file and see it deployed.
