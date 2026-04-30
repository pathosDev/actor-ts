# SvelteKit frontend

SvelteKit + Svelte 5 (Runes) — fully static export so the chat
backend's `@fastify/static` plugin can serve it as-is.

The contrast point versus the React variants is the runes-based
state model: `$state(...)` lifts plain TypeScript fields into a
deep-reactive store; the component's template re-renders
automatically when any field changes.

## Build

```bash
npm install
npm run build
```

The build calls `vite build` (with the SvelteKit + adapter-static
plugin chain) to produce `build/`, then `scripts/copy-build.mjs`
mirrors it into `../static/svelte/`.

```bash
# Open after the cluster is up:
http://localhost:8081/static/svelte/
```

## Source layout

```
src/
├── app.html                 ← host page template (SvelteKit special file)
├── app.css                  ← global theme variables
├── lib/
│   ├── chat.svelte.ts       ← runes-backed store (the .svelte.ts
│   │                          extension activates rune compilation)
│   └── protocol.ts          ← local copy of shared/protocol.ts
└── routes/
    ├── +layout.svelte       ← root layout
    ├── +layout.ts           ← `ssr = false` + `prerender = true`
    └── +page.svelte         ← single-route app (login + chat split)
svelte.config.js             ← adapter-static + base path /static/svelte
scripts/copy-build.mjs       ← build/ → ../static/svelte/
```

## What this demonstrates

- **Svelte 5 Runes** — `$state`, `$derived`, `$props` instead of
  Svelte 4 `let` reactivity.
- **`.svelte.ts` extension** — turns a plain TS class into a
  reactive store; the compiler treats `$state(...)` as a real rune.
- **adapter-static** — the chat backend serves the built bundle
  with no SvelteKit server runtime.
- **`base` config** — every internal asset URL targets
  `/static/svelte/...` to match the @fastify/static mount.

## Why a local protocol mirror?

Same reason as the other frontends — keeping each project self-
contained with its own type set is simpler than wiring shared-paths
into Vite's bundler config across four toolchains.

## Versions

- Svelte 5, SvelteKit 2
- @sveltejs/adapter-static 3
- Vite 8, @sveltejs/vite-plugin-svelte 7
- TypeScript ~5.9
