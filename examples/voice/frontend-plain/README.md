# Plain HTML frontend — voice sample

Single-file vanilla HTML/CSS/JS — no build, no `node_modules`, no
TypeScript.  The actual file is at
`examples/voice/static/plain/index.html` — that's both the source
*and* what the HTTP-ingress singleton serves under `/static/plain/`.

To poke at it:

1. Start a voice cluster (one or more terminals — see top-level
   `examples/voice/README.md`).
2. Open `http://localhost:8081/static/plain/`.
3. Click "Enable mic" (one-time browser permission prompt + audio
   context unlock for inbound playback).
4. Log in with one of the test users from the selector page.
5. Try the three modes:
   - **1:1** — hold the PTT button next to a user's name; release
     to end the press.
   - **Group** — hold a group card's PTT; everyone in that group
     hears it (no echo of your own voice).
   - **Room** — enter a room, toggle "Talk" for open-mic.  Multiple
     speakers stream concurrently; the binary frame envelope's
     `senderUsername` prefix lets the playback module dispatch
     each chunk to the right per-sender `MediaSource`.

The single-file layout is intentional: it makes the audio plumbing
(capture + WebSocket I/O + per-sender playback) inspectable in one
place without bouncing through framework abstractions.  The other
five frontends factor the same logic into framework-shaped pieces
for comparison.
