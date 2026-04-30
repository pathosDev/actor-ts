# Next.js frontend

Next.js 16 + React 19 + App Router, built as a fully static export
so the actor-ts chat backend's `@fastify/static` plugin can serve
it without a Node runtime.

The contrast with the React + Vite variant (`../frontend-react/`)
is the project structure: file-based routing under `app/`, layout
component, RSC-ready conventions — but the chat itself runs
entirely client-side because the backend is the actor system, not
a Next API route.

## Build

```bash
npm install
npm run build
```

The build produces `out/` (Next's static export), then the
`scripts/copy-out.mjs` post-build step mirrors it into
`../static/next/` where the chat backend serves it under
`/static/next/`.

```bash
# Open after the cluster is up:
http://localhost:8081/static/next/
```

## Source layout

```
app/
├── layout.tsx        ← root layout (RSC)
├── page.tsx          ← 'use client', login + chat split
└── globals.css       ← global theme
lib/
├── protocol.ts       ← local copy of shared/protocol.ts
└── useChat.ts        ← WebSocket + state via useReducer
next.config.mjs       ← output: 'export', basePath, assetPrefix
scripts/copy-out.mjs  ← out/ → ../static/next/
```

## What this demonstrates

- **App Router** with `app/layout.tsx` + `app/page.tsx`.
- **Static export** via `output: 'export'` — no Node runtime needed
  to serve the bundle; pairs cleanly with `@fastify/static`.
- **`'use client'`** on `page.tsx` so the WS hook actually runs in
  the browser; `layout.tsx` stays as a server component.
- **`basePath` + `assetPrefix`** so internal URLs target
  `/static/next/...` instead of `/`.

## Why a local protocol mirror?

Same reason as the other frontends — Next's strict project root
plus its TypeScript plugin make reaching outside the project's tree
awkward.  Duplicating ~50 lines is the better trade-off.

## Versions

- Next.js 16, React 19, React-DOM 19
- TypeScript ~5.9
