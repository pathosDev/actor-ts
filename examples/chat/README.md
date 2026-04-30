<p align="center">
  <img src="../../assets/logo.svg" width="200" alt="actor-ts" />
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
  via `ClusterSharding` and **persistent** via `SqliteJournal`.  Every
  posted message is appended to the journal; messages survive a full
  cluster restart.
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
                   │ HTTP + WS (Fastify)
        ┌──────────┴──────────┬──────────────┐
        ▼                     ▼              ▼
   ┌─────────┐           ┌─────────┐    ┌─────────┐
   │ Node 1  │ ◀─Gossip▶ │ Node 2  │ ◀▶ │ Node 3  │
   │ :2551   │           │ :2552   │    │ :2553   │
   │ http    │           │ http    │    │ http    │
   │ :8081   │           │ :8082   │    │ :8083   │
   └─────────┘           └─────────┘    └─────────┘
        │                     │              │
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

Open **three terminals**:

```bash
# Terminal 1 — bootstrap node, no seeds
bun examples/chat/backend/main.ts \
  --port 2551 --http-port 8081

# Terminal 2 — joins the bootstrap
bun examples/chat/backend/main.ts \
  --port 2552 --http-port 8082 --seeds localhost:2551

# Terminal 3 — joins the bootstrap
bun examples/chat/backend/main.ts \
  --port 2553 --http-port 8083 --seeds localhost:2551
```

Each node logs `[+] chat-cluster@... is UP` events as the cluster
forms.

### Open the chat

Pick any node's HTTP port and visit:

- <http://localhost:8081/> — the bootstrap node's frontend selector
- <http://localhost:8082/> — node 2's selector
- <http://localhost:8083/> — node 3's selector

The selector lists all six frontends.  Pick one, log in with any
of the test credentials below, and start chatting.  Open another
window pointing at a different node + different frontend and watch
messages converge.

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

There's an end-to-end smoke test under `smoke-test.ts`:

```bash
# Start at least one node first (any port), then:
bun examples/chat/smoke-test.ts ws://127.0.0.1:8081/ws
```

It logs Alice in, sends three messages, verifies the broadcast
echoes, then logs Bob in on a fresh connection and verifies Bob
sees the persisted history.

To verify cross-node behaviour manually:

1. Open <http://localhost:8081/static/plain/> in window 1, log in
   as alice.
2. Open <http://localhost:8082/static/plain/> in window 2, log in
   as bob.
3. Type a message in alice's window — it appears in bob's instantly.
4. Stop node 1 (Ctrl+C in terminal 1).  Sharding rebalances.
5. Bob can keep chatting; alice's history is still in the SQLite
   journal so when alice logs in to node 2 or 3 she sees it again.

## Out of scope (followup issues opened)

- Private DMs (multi-room global chat only).
- User-created rooms at runtime (default list is hardcoded).
- File uploads, emojis, typing indicators.
- TLS / WSS (plain HTTP for local demo).
- Production-grade auth (no bcrypt, no session expiry, no CSRF).
- Reconnect-resume after network blip.
- Snapshot-based recovery — pure event replay today.
- Read-receipts.

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
│   ├── auth/credentials.ts          ← validateCredentials()
│   ├── plugins/
│   │   ├── staticFilesPlugin.ts     ← @fastify/static wrapper
│   │   └── webSocketPlugin.ts       ← @fastify/websocket + /ws route
│   └── actors/
│       ├── ChatRoomActor.ts         ← sharded PersistentActor (per room)
│       ├── UserSessionActor.ts      ← per-WS-connection session
│       └── OnlineUsersActor.ts      ← DistributedData ORSet wrapper
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
