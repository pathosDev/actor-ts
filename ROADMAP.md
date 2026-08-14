# Roadmap

This document tracks the planned direction.  Nothing here is committed work — it's a sketch, not a contract.  See `README.md` → "What is this?" for the current scope and `CHANGELOG.md` for what landed in the most recent release.

## Status

- **v0.15.0 is out** — the *mailboxes and channels* release, cut a day after
  v0.14.0 because one breaking change should not sit in a window.  **The
  default mailbox is unbounded again (#1148)**: since #310 every actor
  spawned without an explicit `mailboxCapacity` got a `drop-head` bound that
  silently evicted its *oldest* queued message, and the tracker holds one
  entry per victim — a death-watch `Terminated` (#729), a ReliableDelivery
  `confirm` that never settled (#732), a DistributedData promise left
  unsettled (#1078), three WebSocket-hub defects (#717, #985, #986).  The
  memory ceiling it was traded for never existed, because the system-message
  queue was never bounded (#794).  Bounding is opt-in now and names its own
  loss, `actor_mailbox_size` exists to watch what replaced it, and every
  mailbox reports its drops rather than only the one the framework built
  (#1149, #661).  **Channels**: `EventStream` accepts `kind`-discriminated
  types rather than only classes (#1143), and one faulty subscription no
  longer breaks the bus for every subscriber registered after it (#1010).
  Underneath, constants got a placement rule (#1142) that turned up a dead
  export, five duplicated values and a second path-traversal denylist.  See
  `CHANGELOG.md` — the breaking change carries a migration note.
- Next window is open (`[Unreleased]`), and the **50-oldest bug/security
  wave** has landed in it — 42 of the 50 oldest open defects resolved,
  including most of the 2026-08-01 security catalogue (#575–#626).  Five
  entries carry a BREAKING marker and a migration note; the gossip frame gains
  a required field, so **a rolling upgrade across that change does not
  converge** (#112).  See the entry below and `CHANGELOG.md`.

  The obvious heads from here: the `reference.conf` expansion tracked in
  #887, the residual security items this wave narrowed rather than closed
  (#112 needs the incarnation identity from #940; #607 needs the eviction
  policy from #1080), and #766 — whose titled fix turns out to be
  insufficient on its own, see the issue.
- ~5 170 tests green (unit + multi-node + in-process integration) + 15 real-network multi-node integration scenarios green; open bugs are tracked as `[Bug]` issues in the tracker.
- A full audit-catalog of follow-up items is tracked in the issue tracker — security findings, framework features, code-quality refactors.  Filter by label `security` + `severity: <tier>` or by title prefix `[Security] ` / `[Feature] `.

## Done since the last roadmap update

- **`[Unreleased]` — the 50-oldest bug/security wave:** the 50 oldest open
  `bug` / `security` issues worked as one unit, in seven batches grouped by
  which files they touch rather than by module label.  **42 resolved** — 38
  closing on this window's push plus four closed by hand — and 12 left open on
  purpose, each with a comment saying why.  The bulk is the 2026-08-01 audit
  catalogue (#575–#626) plus the four May entries (#112, #118, #121, #132).
  - **Two of the fifty were not defects at all.** #118's titled timer leak
    cannot happen — `settle()` clears and nulls the timer and every later
    `tell()` early-returns — and the issue body already retracted it; it was a
    duplicate of #177, whose two unique clauses were folded across.  #132 asked
    for redaction of a trace id that no framework path ever writes to a log
    record; #995 owns making that bullet true first.  Neither cost a line of
    code, and finding that out was the point of asking "are the acceptance
    criteria met" rather than "does the defect still exist"
  - **Five entries are BREAKING**, each with a migration note in
    `CHANGELOG.md`.  The consequential one is **#112**: `GossipMessage` gains
    a required `sequence`, so a cluster must be upgraded in one step — an
    upgraded peer refuses an old node's frames and an old node ignores the new
    field.  The others are narrower: object-storage bodies must carry their
    integrity tag once integrity is configured (#579), the Express and Hono
    request-body caps drop to match Fastify (#357), a documented-but-inert
    gRPC deadline starts being enforced (#577), and an ungated
    `DevTools.mount()` now throws (#594)
  - **Independent verification found five regressions the wave itself
    introduced**, all repaired before the merge, each with the failing test
    written first.  The worst was #588's own fix: the new inbound-connection
    cap armed no handshake deadline on the accept path, so 1024 sockets that
    send *nothing* saturated it and refused every real peer — a defence that
    became the attack.  Also #597 (one malformed environment variable killed
    the whole discovery ladder, including the explicit seed list that does not
    read it), #600 (`reset()` orphaned an in-flight acquire, so the very end
    state the issue exists to prevent survived), #610 (the scan was fixed but
    not the copy — 95 % of the remaining cost) and #586 (a hard throw on
    `@hono/node-ws` versions `package.json` still declared supported)
  - **What the wave narrowed rather than closed**, stated so it is not
    re-derived later: #112's guard holds only while the sender is still a
    member — deleting a member drops its high-water mark, so once the sender
    is also evicted a recording replays again, and closing that needs #940's
    incarnation identity.  #607's key bound is necessary but not sufficient
    without #1080's eviction policy.  #602 deliberately has no HOCON key,
    because one would reach `HttpExtension.client` and silently not the
    `HttpClient` inside `D1Client` — a bound that applies to some clients and
    not others is worse than none
  - **Eleven release notes were corrected** after the fact, most of them
    overclaims by the wave's own hand.  #121's migration note named the wrong
    safe version (v0.13.0 for v0.14.0), which would have had an operator roll
    clients out against nodes that crash on every envelope
- **v0.15.0 — mailboxes and channels:**
  - **The unbounded mailbox is the default again (#1148)** — BREAKING, and
    the reason this window is a minor.  A mailbox cannot tell a stale sample
    from a control message, so `drop-head` on every actor was never confined
    to the telemetry-shaped workloads it suits.  `mailboxOverflow` /
    `withMailboxOverflow` is a real `ActorOptions` field now, setting it
    without a capacity is rejected rather than ignored, and `ActorCell` warns
    at 10 000 queued messages and every doubling after
  - **Drop reporting reaches every mailbox (#1149, #661)** — the cell
    registers its observer after choosing the mailbox, on anything
    implementing the new `DropReportingMailbox` contract, so a mailbox
    supplied through `withMailbox` is no longer invisible to
    `actor_mailbox_dropped_total`.  `Mailbox` and `Envelope` are exported
    from the package root, which is what made the documented escape hatch
    reachable at all
  - **`EventStream` channels can be `kind`-discriminated types (#1143)** —
    a new `EventKey` mirroring `ServiceKey` / `ShardKey`, or the bare kind
    string; class channels are untouched.  Publishing something nobody could
    subscribe to was possible before this
  - **The event stream survives a bad subscription (#1010)** — the channel
    test, the predicate and `subscriber.tell` all run under a guard, so one
    faulty entry no longer silently stops every subscription registered
    after it, on every spawn, stop and dead letter
  - **Constants have a placement rule (#1142)** — four possible homes,
    checked in order, written down in `AGENTS.md`; ~300 constants across 130
    files audited against it.  Every public name is unchanged
  - **A collision predicate on the random-id helpers (#1141, #1146)** — an
    optional `exists` callback that collapses the hand-written `do/while`,
    bounded at 1 000 draws; three of the framework's own twelve draws now
    use it, and the other nine are recorded with the reason

- **v0.14.0 — caps, codecs and lifecycle:**
  - **`allPersistenceIds` + `currentPersistenceIdsPaginated` (#156)** — the
    read side can now enumerate entities as a live fan-out stream and as a
    cursor-paginated walk, instead of only as one materialised array.  Paging
    is pushed into the backend wherever a sorted key over ids exists —
    `ORDER BY … LIMIT` on SQLite and the SQL dialects, an
    `all_persistence_ids` clustering range on Cassandra

- **v0.13.0 — names and lifecycle:**
  - **`Props` removed (#547)** — `spawn(MyActor, name)`; per-actor
    configuration is `ActorOptions`, a regular `XOptions` family.  The one
    place in the framework that did not follow that convention
  - **Sharding lifecycle (#892)** — idle entities passivate after 5 minutes by
    default, empty shards stop with them, `shardPassivationIdleMs`;
    plus `ShardInfo.resident` (#901)
  - **`Actor.displayName()` (#891)** — a readable name in log lines and the
    DevTools tree, settable from the spawn site or at runtime; the path stays
    the identity everywhere it is an address
  - **Generated names hardened** — anonymous actors (#895), reliable-delivery
    controllers (#897), the reserved `$` prefix (#900), DistributedData quorum
    ids (#896), object-storage temp paths (#898), `ClusterClient` identity
    (#910)
  - **Cluster correctness** — a crossing dial no longer partitions two healthy
    nodes forever (#697), `rememberEntities` survives a rebalance handoff
    (#632), handoff buffers are replayed (#893), remembered entities return
    after an unexpected shard death (#894), remote shard refs route through the
    owning region (#901)
  - **The TLS listener actually requests a client certificate (#565)** — the
    documented mTLS recipe had been server-authenticated only, and the `hello`
    handshake carries no credential of its own

- **v0.12.x window:**
  - **DevTools suite (#445)** — embeddable web UI for a running system, seven
    panels on one versioned tap protocol behind a `./devtools` export.  Absorbed
    the separately-listed live cluster visualizer (#204)
  - **Five more persistence backends (#438)** — MongoDB, DynamoDB, MS SQL,
    libSQL/Turso, Cloudflare D1, each with journal + snapshot + durable-state,
    on the new relational base layer (#389); CockroachDB + YugabyteDB certified
    on the Postgres stores (#401)
  - **Documentation site (#26)** — Starlight, with a 1:1 German mirror and a
    generated TypeDoc API reference at `actor-ts.dev/api/`
  - **Cluster addressing** — a shard is a real actor (`Region → Shard →
    Entity`) with `shards()` / `shardRefFor()` / `entityRefFor()` introspection
    (#511, #512, #151); `SingletonKey` / `ShardKey` declare identity on the
    actor class, `cluster.singleton` mirrors `cluster.sharding` and `start()`
    returns a plain `ActorRef` (#523); framework actors moved from `/user` to
    grouped `/system` paths (#509)
  - **Cluster-correctness follow-ups** — cross-node `ask()` gets its reply
    instead of timing out (#517), a role-restricted singleton is hosted by a
    node that carries the role rather than nowhere (#524), the singleton proxy
    buffer is bounded (#526), and `leader()` / `KeepOldest` document the
    address ordering they actually use (#525)
  - **Core correctness pass from the 2026 audit** — the `terminated` signal is
    delivered (#448), routers prune dead routees (#449) and reject an unusable
    pool size (#455), reliable-delivery settles in-flight sends on shutdown
    (#451), a bounded mailbox keeps its bound while suspended (#407),
    `FailureDetector` thresholds are consistent and validated (#452), and HOCON
    parsing cannot reach the object prototype (#406)

- **v0.11.0 window — consistency + validation sweep:**
  - Repo-wide naming conventions, hard cuts: `Websocket` casing (no `Ws`),
    abbreviations spelled out (`*Cmd`/`*Msg`/`*Ack`/`*Impl`/`*Ctor`,
    testkit `expectMessage`/`expectMessageType`), one config vocabulary
    (`Options`, never `Settings`), single-letter locals spelled out
  - `OptionsValidator` + `OptionsError` (#274) — fail-fast domain validation
    on every input path (builder / plain object / HOCON) across brokers,
    cluster, sharding, discovery, leases, caches, persistence, HTTP
    middleware/backends, WebSocket routes + policy, `CircuitBreaker`,
    `BoundedMailbox`, and the testkit
  - Security hardening: WebSocket Origin allowlist (CSWSH defence, WS-2),
    per-route WebSocket connection cap (WS-5, partial), per-caller identity
    scope for idempotency keys (HTTP-4), object-storage decompression cap as
    a store option (#3)
- **v0.10.0 — SQL persistence backends + compression levels:**
  - PostgreSQL backend — journal + snapshot + durable-state (the first SQL-backed durable-state store), `registerPostgresPlugins`, optimistic concurrency, indexed tag queries, live `postgres:latest` CI suite (#323)
  - MariaDB backend — same three components via the `mariadb` connector, MariaDB dialect, live `mariadb:latest` CI suite (#324)
  - Configurable gzip/zstd compression `level` on the object-storage stores (#322)
  - zstd compression fixed on non-native runtimes — compress is native-only (Bun / Node ≥22.15), `fzstd` is the decompress-only fallback (#321)
- **v0.10.0 — production-readiness audit response, 5 technical points:**
  - DurableState revision tampering — opt-in HMAC-SHA256 integrity (#116, CRITICAL)
  - ClusterClient askId predictability — `crypto.randomUUID()` (#120, HIGH)
  - Master-key rotation sweep race — durable resume tokens + keyring-completeness pre-check (#109, HIGH)
  - LeaseMajority split-brain — epoch-gated acquires + release-on-abandon + optional fencing tokens (#142, HIGH)
  - Bounded mailbox is now the default — 10 000 / `drop-head` with `actor_mailbox_dropped_total` metric (#310)
  - `JsonLogger` + `otelLogger` for OTLP-Logs pipelines (#311)
  - HTTP route middleware + `BearerTokenAuth` + `IpAllowlist` + `managementRoutes` auth integration (#312)
  - Real-network multi-node integration tests — docker-compose, tc-netem, 15 scenarios covering cluster primitives end-to-end (#313)
  - MultiNodeSpec `enterBarrier` — Akka-style cross-node test synchronization (#198, was #47)
  - Backend `remoteAddress` wiring for Fastify / Express / Hono (#312 follow-up)
- v0.7.0 — `mget` / `mset` on the `Cache` interface (#14), MQTT 5.0 user properties + reason codes (#13)
- v0.8.0 — Cluster-management extended HTTP endpoints (#56), Re-encryption sweep + journal-to-journal copy + ClusterClient + WriteConsistency/ReadConsistency
- v0.8.0 — 8 security-hardening fixes (wire-frame DoS cap, FS path-traversal guard, Memcached CRLF, gossip version cap, snapshot seq integrity, WebSocket frame cap, hello-handshake hijack defense, idempotency body-fingerprint)

## Feature-parity quick wins

- `Inbox` — synchronous adapter for non-actor callers — #181
- `DeathWatch.watchWith` — custom termination message — #159
- `ShardCommand` types — `StartEntity`, `GetShardStats`, `GetClusterShardingStats` — #151

## Production features (Orleans / Vlingo-inspired)

- Persistent reminders (Orleans-style durable timers) — #168
- Stateless workers — per-node pool of identical activations — #170
- Saga / process-manager with compensations — #179
- Placement strategies (PreferLocal / HashBased / ActivationCountBased) — #169

## Novel differentiators (each own plan-slot)

- Deterministic-simulation-testing (FoundationDB-style seeded virtual-time replay) — #200
- LLM agents as supervised, durable actors — epic #421 (absorbed the earlier
  LLM-tool-call-as-actor sketch; tool dispatch is #423)
- Per-entity chaos injection — #206

## Bigger threads (L / XL — own design phase)

- Streams DSL subset (`SourceQueue`, `MergeHub`, `BroadcastHub`) — #147
- Full `Source` / `Flow` / `Sink` composition DSL — #54 (the long-horizon track;
  #147 is a deliberate ~5 % subset, not a replacement for it)
- WASM / edge-runtime subpackage — #209
- Distributed transactions (Orleans-style ACID 2PC across grains) — #171
- Multi-DC clustering with DC-local failure detection — #149

## Documentation

- Performance benchmarks vs JVM actor frameworks (#27) — `benchmarks/` has the
  micro-benches; what is missing is the side-by-side comparison run

## Explicitly out of scope

- "Auto-magic" cache invalidation by tag / pattern — known bug-source; invalidation stays explicit via `cache.delete(...)`.
- Backwards-compatibility guarantees of any kind — pre-1.0.
- Pull requests — not accepted; well-shaped issues are (the issue tracker is the contribution channel, see `README.md` → "Roadmap & status").

→ Full catalog: GitHub issues, filterable by title prefix `[Security]` / `[Feature]` and the `security` / `severity: …` labels.
