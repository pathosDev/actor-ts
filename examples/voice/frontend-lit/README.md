# Lit frontend — voice sample

Single-file Lit element loaded via ES modules from a CDN
(`https://esm.sh/lit@3`) — no build, no `node_modules`.  The
shipped file lives at `examples/voice/static/lit/index.html`.

The Lit version exists alongside the plain HTML one to show what
the same audio plumbing looks like with reactive properties driving
the render — same WebSocket connect/resume, same `MediaRecorder`
capture per press, same per-sender `MediaSource` playback, just
threaded through `LitElement` lifecycle methods instead of manual
DOM updates.

For a production deployment you'd typically `vite build` to produce
a bundle and skip the CDN — see the chat sample's `frontend-lit/`
note about that pattern.
