<p align="center">
  <img src="https://raw.githubusercontent.com/pathosDev/actor-ts/main/docs/public/logo.svg" width="200" alt="actor-ts" />
</p>

# Chat — multi-frontend sample for actor-ts

A chat web application that demonstrates the framework working as
a real distributed system: a clustered backend with persisted history
and live-broadcast across nodes, paired with **six different
frontends** that all speak the same WebSocket protocol so you can
compare their feel side-by-side.

## What it shows

- **TCP cluster** of three Bun processes joined via gossip.
- **`ChatRoomActor`** — one per room, **sharded** across the cluster
  via `ClusterSharding` and **persistent** via `SqliteJournal` +
  `SqliteSnapshotStore`.  Every posted message is appended to the
  journal; recovery replays from the latest snapshot (taken every
  100 events) plus the tail, so a room with 10k messages cold-starts
  in O(100 events read) regardless of total history length.
- **HTTP front door = `ClusterSingleton`** — exactly one node binds
  the public port (`8080`) at any time.  When that node dies a
  surviving node takes over the bind automatically.  Same URL for
  the user, no per-node ports to remember.
- **`DistributedPubSub`** with one topic per room
  (`chat.room.<roomName>`) for cross-node fan-out — a message posted
  by Alice on node 1 reaches Bob on node 3 with no routing code in
  the middle.
- **`DistributedData`** with an `ORSet<string>` per room (key
  `online-users.<roomName>`) tracking who's currently connected.
- **HTTP layer through the framework's directive DSL** — no manual
  Fastify setup.  `@fastify/static` and `@fastify/websocket` are
  wired in via `FastifyBackend.withPlugin(...)` exclusively.
- **All client traffic is WebSocket-based.**  No REST.  Login, room
  list, history, presence and chat messages all flow through one
  `/ws` endpoint.
- **Six frontend variants** for direct comparison: Plain HTML,
  Angular, React + Vite, Next.js, SvelteKit, Lit.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Browser (any of 6 frontends, all same WS protocol)        │
└──────────────────┬─────────────────────────────────────────┘
                   │ HTTP + WS  (always :8080)
                   ▼
          ┌──────────────────┐
          │ http-ingress     │  ← ClusterSingleton; binds :8080
          │   (singleton)    │     on whichever node holds it
          └─────────┬────────┘
                    │ runs on one of:
        ┌───────────┼──────────┐
        ▼           ▼          ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ Node 1  │ │ Node 2  │ │ Node 3  │
   │ :2551   │ │ :2552   │ │ :2553   │   ← cluster ports, internal
   └─────────┘ └─────────┘ └─────────┘
        │           │           │
        └── ClusterSharding[ChatRoomActor] ──┘
              entityId = roomName
                       │
                       ▼ persist
               ./data/chat.db (SQLite Journal)
        │                     │              │
        └── DistributedPubSub topics: "chat.room.<name>" ──┘
        └── DD ORSet "online-users.<name>" per room ──────┘
```

Each node runs the same code (`backend/main.ts`).  The first node
starts without seeds; additional nodes pass `--seeds localhost:2551`
to join.  Once converged, the cluster spreads room entities across
nodes via the `HashAllocationStrategy` — kill any node and the rest
take over its rooms.

## Run it

### Prerequisites

```bash
bun install
```

The chat sample depends on `@fastify/static` and `@fastify/websocket`,
both already in the project's `devDependencies`.

### Three-node cluster

Open **three terminals**, run the same command in each — no
ports, no seeds, no flags:

```bash
bun examples/chat/backend/main.ts
bun examples/chat/backend/main.ts
bun examples/chat/backend/main.ts
```

Each node walks the cluster-port range starting at `2551`, claims
the first free one, and treats every occupied port below it as a
seed.  So the three terminals end up at `2551 / 2552 / 2553`
without anyone telling them so:

```
node 1: cluster=127.0.0.1:2551 · bootstrap (no seeds)
node 2: cluster=127.0.0.1:2552 · seeds=[127.0.0.1:2551]
node 3: cluster=127.0.0.1:2553 · seeds=[127.0.0.1:2551,127.0.0.1:2552]
```

Each node logs `[+] chat-cluster@... is UP` events as the cluster
forms.  Exactly one of them logs

```
[ingress] this node won the singleton — binding 127.0.0.1:8080
```

— that node currently owns the public port.  The other two stay
warm: they still run the persistence layer, the sharded chat
rooms, the pubsub mediator and presence tracking, but they don't
serve HTTP until the singleton fails over.

For cross-machine deployments (where same-host port-scan doesn't
work) you can pin things explicitly:

```bash
bun examples/chat/backend/main.ts --port 2551
bun examples/chat/backend/main.ts --port 2552 --seeds host-a:2551
bun examples/chat/backend/main.ts --port 2553 --seeds host-a:2551,host-b:2552
```

### Open the chat

Visit a single URL no matter which node holds the singleton:

<http://localhost:8080/>

The selector lists all six frontends.  Pick one, log in with any
of the test credentials below, and start chatting.  Open multiple
browser windows + frontends and watch messages converge.

### Failover

Find the node logging `[ingress] this node won the singleton` and
`Ctrl+C` it.  Within a few seconds (failure-detector timeout
+ singleton election) one of the survivors logs the same line and
re-binds `:8080`.  Browser sessions reconnect automatically and
the persisted history is still there — you just lose the in-flight
WebSocket frames during the brief outage.

For real zero-downtime active/active deployments you'd put a
proper load balancer in front of the cluster (nginx, HAProxy, K8s
Service); the singleton model is a self-contained fallback that
doesn't need any external infrastructure.

### Test credentials

| Username  | Password    |
|-----------|-------------|
| `alice`   | `wonderland`|
| `bob`     | `builder`   |
| `charlie` | `chaplin`   |
| `diana`   | `prince`    |

Plain-text passwords are intentional — this is a demo.  The
credentials are also printed under each frontend's login form.

## Layout

After login each frontend renders the same three-column layout:

```
┌──────────────────────────────────────────────────────┐
│            Header (User: alice • Logout)             │
├──────────────┬─────────────────────────┬─────────────┤
│  ROOMS       │      CHAT WINDOW        │ ONLINE      │
│  (left)      │      (center)           │ USERS       │
│              │                         │ (right)     │
│  # general*  │  [scrollable history]   │ • alice     │
│  # random    │                         │ • bob       │
│  # tech      │                         │             │
│  # announce  │  [input.......] [Send]  │             │
└──────────────┴─────────────────────────┴─────────────┘
```

Aktiver Room is highlighted with `*` in the menu.  Clicking another
room switches the chat window + users panel; unread badges
accumulate on inactive rooms.

## Frontends

Built output goes to `examples/chat/static/<framework>/` and is
served by `@fastify/static` under `/static/<framework>/`.

| Path                  | Stack                          | Build command                              |
|-----------------------|--------------------------------|---------------------------------------------|
| `frontend-plain/`     | Vanilla HTML/CSS/JS            | (none — copy `index.html` to `static/plain/`) |
| `frontend-angular/`   | Angular standalone + Signals   | `ng build --output-path=../static/angular`  |
| `frontend-react/`     | React + Vite (SPA)             | `vite build --outDir ../static/react`       |
| `frontend-next/`      | Next.js (App Router, RSC)      | `next build && cp -r out ../static/next`    |
| `frontend-svelte/`    | SvelteKit + Svelte 5 Runes     | `vite build` (adapter-static → `../static/svelte`) |
| `frontend-lit/`       | Lit Web Components + Vite      | `vite build --outDir ../static/lit`         |

Plain HTML is shipped pre-built; the other five each carry their own
`package.json` and follow standard create-* scaffolding.  See each
subdirectory's `README.md` for details.

## Verifying it works

Two scripts ship for verification — pick the one that matches what
you want to check.

### `smoke-test.ts` — single-node messaging round-trip

```bash
# Start a single bootstrap node first:
bun examples/chat/backend/main.ts --port 2551
# In another terminal:
bun examples/chat/smoke-test.ts
```

Logs Alice in, sends three messages, waits for the broadcast
echoes, then logs Bob in on a fresh connection and verifies Bob
sees Alice's history.  Single-node by design — the smoke test
isolates the protocol round-trip from the cluster's lazy shard-
allocation timing, so it stays deterministic.

### `failover-test.ts` — HTTP-singleton fail-over

```bash
# Spawns + tears down a 3-node cluster on its own:
bun examples/chat/failover-test.ts
```

Spawns three nodes, identifies which one currently owns `:8080`
via the OS-level port table, kills it, then verifies that a
different PID picks up `:8080` within a few seconds and that the
new owner serves HTTP.  This is the test that exercises the
ClusterSingleton + HttpIngressActor fail-over end to end.

### Manual cross-node demo

1. Run the three-terminal cluster from the *Run it* section above.
2. Open <http://localhost:8080/static/plain/> in window 1, log in
   as alice.
3. Open <http://localhost:8080/static/plain/> in window 2 (same
   URL — the singleton answers), log in as bob.
4. Type a message in alice's window — it appears in bob's instantly,
   even though the chat-room entity is sharded onto a node that
   isn't necessarily the same as the singleton-holder.
5. Find the terminal that logged `[ingress] this node won the
   singleton` and `Ctrl+C` it.  Watch a survivor pick up the bind
   within a few seconds.  Reconnect from the browser — alice's
   messages are still there because the SQLite journal survived.

## TLS / WSS

Plain HTTP is the default for the local demo, but the same backend
runs over HTTPS once you point it at a cert + key pair.  Frontends
auto-promote `ws:` → `wss:` based on `location.protocol`, so a
single pair flips the entire stack to TLS without any client-side
change.

**Local development with `mkcert`** — generates a locally-trusted
cert that browsers accept without warnings:

```bash
# one-time setup (Linux: install via package manager; macOS: `brew install mkcert`;
# Windows: `scoop install mkcert` or `choco install mkcert`).
mkcert -install                           # add mkcert's root CA to your trust store
mkcert localhost 127.0.0.1 ::1            # produces localhost+2.pem + localhost+2-key.pem

bun examples/chat/backend/main.ts \
  --tls-cert ./localhost+2.pem \
  --tls-key  ./localhost+2-key.pem
```

Open `https://localhost:8080/` — the lock icon is solid green.
Reload an existing session over the new origin and the token
keeps working (sessionStorage is per-origin, so you'll re-login
once when you switch protocols).

**Production: terminate TLS at a reverse proxy.** Same pattern as
the voice sample — Caddy auto-issues a Let's Encrypt cert and
proxies through:

```caddy
chat.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Or nginx with manual cert paths plus the `Upgrade: websocket`
header set so `/ws` proxies through (full snippet in
`examples/voice/README.md` → "Hosting on a server").  The
`--tls-cert` / `--tls-key` flags exist for setups where the
Bun process owns the public listener directly.

## Out of scope (followup issues opened)

- File uploads (deferred — needs object-storage subsystem).
- CSRF / Origin checks and per-IP login rate-limiting.  Both are
  config-driven via Fastify (`fastify-helmet`, `@fastify/rate-limit`)
  and the framework's middleware story — see "Production hardening"
  below for the wiring shape, not duplicated in code here.

Implemented since v1:

- **User-created rooms at runtime** (#98).  Rooms live in a
  `ChatRoomDirectoryActor` that wraps a `DistributedData` ORSet —
  every node spawns its own instance, the ORSet converges, and the
  `DEFAULT_ROOMS` seed is idempotent.  The protocol carries
  `create-room`, `room-added`, and `room-removed` frames; every
  frontend renders a "+ new room" input below the rooms list.
  Room names follow the same shape as Memcached / FS-backend keys:
  `[A-Za-z0-9][A-Za-z0-9_-]{0,31}`, validated both client- and
  server-side.
- **Private direct messages** (#100).  DMs are modelled as virtual
  `@<username>` "rooms" — no new protocol frames, the existing
  `send`/`join`/`message`/`history` carry them.  Server distinguishes
  by the leading `@` and routes through a sharded `DirectMessageChannelActor`
  keyed on the canonical pair-id (`canonicalPairId('alice', 'bob') ===
  canonicalPairId('bob', 'alice') === 'alice|bob'`).  Each user
  subscribes once at login to `chat.dm.user.<self>` — every DM lands
  in that inbox topic regardless of which conversation it belongs to,
  so the client needs no per-channel subscription bookkeeping.  Click
  any user in the Online panel to open a DM.
- **Typing indicators** (#103, slice 1).  Demonstrates ephemeral
  PubSub: `{ type: 'typing', room }` is fan-out via the room's
  existing topic (no persistence, no actor in between) as a
  `TypingBroadcast { from }`; subscribers translate to
  `{ type: 'user-typing', room, username }` for the client.  Server
  filters self-echoes; client side debounces outbound to 1/2 s and
  auto-clears stale indicators 3 s after the last frame.  For DM
  rooms the broadcast targets the recipient's inbox topic, pre-keyed
  to the `@<sender>` virtual room.
- **Emojis** (#103, slice 1).  Pure-text — the server is agnostic.
  Paste any Unicode emoji into compose and it flows like normal
  text.  Each frontend can wire any picker (`emoji-mart` for
  React/Next, `<emoji-picker-element>` for Plain/Lit, etc.) on top
  without server changes.
- **Read receipts** (#103, slice 2).  Demonstrates DistributedData
  LWWMap: each room has a `read-up-to.<room>` DD entry mapping
  username → highest message timestamp the user has acknowledged.
  Clients send `{ type: 'read-up-to', room, ts }` on focus + new
  arrivals; the server's `ReadReceiptsActor` writes via LWWMap with
  a monotonic guard (a stale write can't roll a user's pointer
  backwards), then fans out `{ type: 'read-receipts', room,
  receipts }` to every local subscriber.  For DMs the DD entry is
  keyed on the canonical pair-id so both participants share the same
  view.  UI: ✓ next to own messages (sent), ✓✓ when at least one
  other participant has read up to that message (hover for the
  reader list).
- **Production-realistic auth** (#99, Option A).
  - Passwords stored as scrypt hashes (`<salt>:<hash>`) in
    `shared/users.ts`; verified via `crypto.scryptSync` +
    `crypto.timingSafeEqual` in `backend/auth/password.ts`.  Plain
    test passwords still listed as comments so the demo's login form
    keeps working out of the box.  Credential validation in
    `credentials.ts` scans every user (verifying against a real hash
    even on a username miss) so timing doesn't leak enumeration info.
  - Session tokens are HMAC-SHA256-signed JWT-style strings
    (`<base64url(payload)>.<base64url(sig)>`) — payload binds
    `{ username, issuedAt, exp }`, signed with a server secret read
    from `CHAT_TOKEN_SECRET` env (warned-and-fallback if unset).
    `lookupToken` self-validates without a DD lookup; the DD-LWWMap
    keyed `chat.session-revocations` only stores tokens that have
    been explicitly revoked.  TTL: 24 hours.
  - Reconnect-resume: on socket close the frontend retries with the
    stored token via the `resume` frame; a singleton-failover
    reauthenticates the client without a fresh login.  Smoke-test
    pass 7 verifies wrong-password rejection, valid resume, revoked-
    token rejection, and tampered-token rejection.

## Production hardening (not in the demo, but pointed at)

The demo ships with the auth-hardening above but stops short of the
last 20 % that real deployments need.  These are config-driven via
existing middleware, not deeper code changes:

- **CSRF / origin check**: add `fastify-helmet` and configure
  `@fastify/websocket` with `verifyClient` to reject upgrades from
  unexpected origins.  Both plug into `HttpIngressActor`'s Fastify
  setup without touching the actor model.
- **Login rate-limit**: `@fastify/rate-limit` keyed on remote IP, e.g.
  10 login attempts per minute.  Same plugin slot.
- **Token secret**: set `CHAT_TOKEN_SECRET` to a strong random value
  shared across every cluster node.  Without it, the server logs a
  loud warning and falls back to a demo-only secret hardcoded in
  `sessionStore.ts`.
- **User store**: replace `TEST_USERS` in `shared/users.ts` with a
  query against a real DB; `validateCredentials` already calls
  `verifyPassword` against an opaque `<salt>:<hash>` string, so
  swapping the source is a one-function change.

## Files

```
examples/chat/
├── README.md              ← this file
├── application.conf       ← HOCON: log level, gossip cadence
├── data/                  ← SQLite journal (.gitignore)
├── backend/
│   ├── main.ts                      ← entry point (wiring only)
│   ├── config.ts                    ← CLI args
│   ├── routes.ts                    ← HTTP-DSL route (selector)
│   ├── auth/credentials.ts          ← validateCredentials() — scrypt-verify, timing-flat
│   ├── auth/password.ts             ← #99: scrypt hash/verify (Node crypto built-ins)
│   ├── auth/sessionStore.ts         ← #99: HMAC-signed JWT-style tokens + DD revocation
│   └── actors/
│       ├── ChatRoomActor.ts            ← sharded PersistentActor (per room)
│       ├── ChatRoomDirectoryActor.ts   ← #98: DD-ORSet wrapper for runtime rooms
│       ├── DirectMessageChannelActor.ts ← #100: sharded PersistentActor (per DM pair)
│       ├── UserSessionActor.ts         ← per-WS-connection session
│       ├── OnlineUsersActor.ts         ← DistributedData ORSet wrapper
│       ├── ReadReceiptsActor.ts        ← #103: DD-LWWMap wrapper for read pointers
│       └── HttpIngressActor.ts         ← ClusterSingleton: owns the :8080 bind
├── shared/
│   ├── protocol.ts        ← shared TS types for WS messages
│   ├── users.ts           ← test credentials (TEST_USERS)
│   └── rooms.ts           ← default room list (DEFAULT_ROOMS)
├── static/                ← built frontend assets (served by @fastify/static)
│   └── plain/index.html
├── frontend-plain/        ← source for plain HTML
├── frontend-angular/
├── frontend-react/
├── frontend-next/
├── frontend-svelte/
├── frontend-lit/
└── smoke-test.ts          ← end-to-end smoke test
```
