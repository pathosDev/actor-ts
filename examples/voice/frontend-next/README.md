# Next.js frontend — voice sample

Next.js (App Router) with `output: 'export'`.  Build emits a fully
static directory tree under `out/`, which `scripts/copy-out.mjs`
mirrors into `examples/voice/static/next/` for the voice backend's
`@fastify/static` plugin to serve.

```bash
cd examples/voice/frontend-next
npm install
npm run build
```

Open `http://localhost:8081/static/next/` after starting the
voice cluster (`bun examples/voice/backend/main.ts`).

The `app/page.tsx` page is `'use client'` end-to-end — there is no
SSR runtime; the static export is what ships.  A `hydrated` flag in
the page defers the first paint past hydration so React's
`useEffect`-driven phase machine can flip from `gate-mic` to
`gate-login` without a hydration mismatch.

The `useVoice` hook (in `lib/`) is the same code the React + Vite
sibling uses; only the build pipeline differs.
