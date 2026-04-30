# SvelteKit frontend (TODO — followup issue)

Stub directory.  The SvelteKit variant of the chat sample is tracked
as a followup issue and not yet implemented.

## Scaffolding plan

```bash
npm create svelte@latest frontend-svelte
# select: Skeleton + TS + adapter-static
cd frontend-svelte
npm install
npm run build
cp -r build/* ../static/svelte/
```

Components to write:
- `src/routes/+page.svelte` — login form.
- `src/routes/chat/+page.svelte` — three-column layout.
- `src/lib/components/{RoomsPanel,ChatWindow,UsersPanel}.svelte`.
- `src/lib/ws.svelte.ts` — Runes-based store wrapping the WS.

State: Svelte 5 Runes (`$state`, `$derived`) for multi-room state.
`adapter-static` produces a fully static bundle suitable for
`@fastify/static`.

Shared protocol via Vite path alias on `../shared`.
