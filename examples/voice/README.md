<p align="center"><img src="../../assets/logo.svg" width="200" alt="actor-ts" /></p>

# Voice sample — distributed walkie-talkie + group + Teams-style rooms

Three voice modes over one WebSocket per client, served by a 3-node
clustered backend that exercises three framework primitives the
[chat sample](../chat/) doesn't:

| Mode                    | Routing primitive                                     | UI                                |
|-------------------------|-------------------------------------------------------|-----------------------------------|
| **1:1 push-to-talk**    | `Receptionist` lookup by `voice-user:<name>` key      | Hold the PTT button next to a row |
| **1:N group megaphone** | `DistributedPubSub` topic `voice.group.<name>`        | Hold the group card's PTT button  |
| **N:N room (Teams)**    | `DistributedPubSub` topic `voice.room.<name>` + `DistributedData` `ORSet` membership | Enter a room, toggle "Talk" |

Audio flows over the existing per-client WebSocket — the server is a
dumb relay.  No WebRTC, no SFU, no transcoding.  That's deliberate:
the whole point is to flow audio frames *through actors* so the
PubSub fan-out, Receptionist lookup, and DD-ORSet presence are
visibly the load-bearing parts.

## Run it

Three terminals, no flags:

```bash
bun examples/voice/backend/main.ts
bun examples/voice/backend/main.ts
bun examples/voice/backend/main.ts
```

Open `http://localhost:8081/`, pick a frontend.  Click "Enable mic"
once (the browser permission prompt + AudioContext unlock both
need a user gesture).  Log in:

```
alice / wonderland
bob / builder
charlie / chaplin
diana / prince
```

Try the modes:

- **1:1**: hold the PTT button next to another user's name.
- **Group**: hold a group card's button.  Members hardcoded in
  [`shared/groups.ts`](shared/groups.ts) — `engineering = [alice, bob]`,
  `ops = [charlie, diana]`, `product = [alice, diana]`.
- **Room**: click "Enter" on a room, then toggle "Talk" for open-mic.
  Multiple speakers stream concurrently; each sender has their own
  per-receiver `MediaSource` pipeline keyed by username.

## What's running

```
Browser ── WebSocket ── ┐
                       ├─ HTTP-singleton on :8081 (any cluster node)
Browser ── WebSocket ── ┘                  │
                                           ▼
                       ┌─ VoiceSessionActor (one per WS) ─┐
                       │  - text frames: control plane    │
                       │  - binary: route per currentTarget│
                       └────────┬─────────────┬────────────┘
                                │             │
                  Receptionist lookup    DistributedPubSub
                  (voice-user:bob)       (voice.group.engineering / voice.room.standup)
                                                        │
                                              VoicePresenceActor
                                              ─ DD ORSet voice.online-users
                                              ─ DD ORSet voice.room-users.<name>
```

`backend/main.ts` is wiring only.  Compared to the chat sample:

- **Adds** `Receptionist` for cross-cluster user-ref lookup.
- **Drops** `ClusterSharding` — there's no sharded entity.  Rooms
  are pure CRDT presence + a PubSub topic.
- **Drops** `PersistenceExtension` and the SQLite journal — voice is
  ephemeral by design.

## Wire protocol

`shared/protocol.ts` defines the JSON discriminated unions.  Auth is
identical to chat (login / resume / token via DD-LWWMap).  Voice
adds:

- `voice-target { mode: 'peer' | 'group' | 'room', target/group/room }` — set the active routing target on PTT-down.
- `voice-stop` — clear the target on PTT-up.  Server sends a final `BinaryStreamEnd` to all subscribers so their playback pipelines flush.
- `room-enter` / `room-leave` — independent of target: entering a room subscribes you to its audio topic but you don't start speaking until you also send `voice-target { mode: 'room', ... }`.
- `voice-incoming-start { from, source }` / `voice-incoming-end { from }` — boundary frames for the per-sender `MediaSource` pipeline on the client.

Audio chunks are **binary** WS frames, not a `ServerMessage` variant.
Inbound from client: raw Opus, no header (the server knows the sender from session context).  Outbound to client: `[u8 nameLen][utf-8 username][opus bytes]` — the receiver demultiplexes by sender so concurrent speakers in a room don't interleave into a single stream.  See [`shared/frameCodec.ts`](shared/frameCodec.ts).

## Frontends

| Frontend               | Status   | Notes                                          |
|------------------------|----------|------------------------------------------------|
| [`frontend-plain/`](frontend-plain/) | ✅ ready | Single `index.html` under `static/plain/`. The reference implementation — all three modes, mic level meter, per-sender playback. |
| `frontend-svelte/`     | TODO     | Will mirror the chat sample's SvelteKit setup with `MediaRecorder`+`MediaSource` instead of plain text. |
| `frontend-react/`      | TODO     | React + Vite, custom `useVoice()` hook. |
| `frontend-next/`       | TODO     | Next.js App Router, static-export. |
| `frontend-angular/`    | TODO     | Standalone components, signal-driven state. |
| `frontend-lit/`        | TODO     | Lit Web Components. |

The wire protocol + frame codec are stable; adding more frontends
is mechanical translation of the plain-HTML reference.

## Audio under the hood

**Capture (browser)**: `MediaRecorder('audio/webm; codecs=opus', timeslice=100ms)`.  Each PTT press starts a *fresh* MediaRecorder so the first chunk carries the WebM init segment; subsequent chunks are media segments.  This matters: receivers create a *fresh* `MediaSource` per `voice-incoming-start` so the init lines up with the buffer's first append.

**Playback (browser)**: per-sender `MediaSource` + `SourceBuffer` (mode `sequence`).  Each binary frame is decoded by `frameCodec.decodeIncoming`, copied (the underlying buffer is shared with the WS), and queued.  `appendBuffer` is gated on `updating === false` — chunks pile up briefly during `updateend` cycles and drain naturally.

**Latency**: typically 100-300 ms end-to-end.  The dominant cost is `timeslice` (100 ms) — pushing it down to 20-40 ms costs CPU on both ends but tightens latency.

## Smoke test

```bash
bun examples/voice/smoke-test.ts
```

Spawns a one-node cluster on isolated ports, opens two WS clients,
walks all three modes with a fake 32-byte audio payload, and
verifies the relay path round-trips correctly (including the
self-filter for room mode).  Does NOT exercise audio playback —
that's a browser concern.

## Trade-offs

- **`MediaSource`** is the right primitive for streamed Opus on the
  receiver, but its quirks (init-segment-once-per-stream, `updating`
  gates, `endOfStream` after the last append) make the per-sender
  pipeline fiddly.  The reference frontend deals with this honestly;
  a polished production app might switch to `WebCodecs` + a custom
  ring buffer.
- **`DistributedPubSub`** is at-most-once.  Lost frames cause audible
  pops.  Production voice would want adaptive jitter buffers + retry
  layers above this.
- **`Receptionist` gossip latency** is ~1 second.  A 1:1 PTT press
  initiated within 1-2 s of the target's login may fail; a retry
  on PTT-down handles this.
- **No echo cancellation across speakers** — the browser's local AEC
  works against locally-rendered audio only.  A 5-person room with
  everyone unmuted on the same speaker will feed back.  Headphones
  recommended.
- **N concurrent speakers → N MediaSources** in the listener's
  browser.  RAM scales linearly.  Reasonable for ~10-person rooms;
  larger groups would benefit from server-side mixing.

## Out of scope (followups)

- WebRTC peer-to-peer / SFU variant
- Recording / voicemail
- Adaptive jitter buffers
- Mobile PWA frontend
- TLS / WSS (this sample is plain HTTP for local demo)
- Production auth (bcrypt password hashing, token rotation)
- Stereo panning of multiple concurrent speakers
