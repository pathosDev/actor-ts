# Angular frontend — voice sample

Angular 21 standalone components with signals.  Build emits to
`dist/browser/`, the `flatten-output.mjs` script then mirrors that
into `examples/voice/static/angular/` for the voice backend's
`@fastify/static` plugin to serve.

```bash
cd examples/voice/frontend-angular
npm install
npm run build
```

Open `http://localhost:8081/static/angular/` after starting the
voice cluster.

The `VoiceService` (in `src/app/voice.service.ts`) owns the
WebSocket, MediaRecorder, and per-sender MediaSource pipeline.
The `AppComponent` template binds against its signals — `phase()`,
`directory()`, `onlineUsers()`, `activeKey()`, `incomingNames()` —
with Angular's new control-flow syntax (`@if`, `@for`).

Same audio plumbing as the React + SvelteKit + plain HTML
siblings; only the reactivity wrapper differs.
