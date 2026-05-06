# SvelteKit frontend — voice sample

Svelte 5 (runes) + `adapter-static`.  Build output is copied into
`examples/voice/static/svelte/` where the voice backend's
`@fastify/static` plugin serves it.

```bash
cd examples/voice/frontend-svelte
npm install
npm run build
```

Then start the voice cluster (`bun examples/voice/backend/main.ts`)
and open `http://localhost:8081/static/svelte/`.

The audio plumbing — `MediaRecorder` per press, per-sender
`MediaSource` playback, frame-codec demux of binary WS frames —
lives in `src/lib/voice.svelte.ts` (a runes-based store).  The
`src/routes/+page.svelte` page is purely a UI binding over that
store.

Compared to the chat sample's `frontend-svelte`:
- Same SvelteKit + adapter-static + copy-build script structure.
- Replaces text-message reactivity with audio-stream reactivity:
  `incomingNames` (per-sender labels), `micPct` (level meter),
  `activeKey` (which PTT button is held).  Same runes idioms.
