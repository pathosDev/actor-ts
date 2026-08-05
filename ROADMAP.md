# Roadmap

This document tracks the planned direction.  Nothing here is committed work — it's a sketch, not a contract.  See `README.md` → "What is this?" for the current scope and `CHANGELOG.md` for what landed in the most recent release.

## Status

- **v0.13.0 is out** — the *names and lifecycle* release.  `Props` is gone
  (#547): spawning takes the actor class, and per-actor configuration became
  `ActorOptions`, an ordinary options family.  Sharded entities passivate by
  default and empty shards stop with them (#892), `Actor.displayName()` gives
  an actor a readable name in logs and DevTools (#891), and the names the
  framework generates for itself are no longer guessable (#895, #897, #900).
  Underneath: a cluster-transport bug where two nodes dialling each other at
  the same moment stayed partitioned for the life of the process (#697),
  `rememberEntities` losing every entity on a rebalance (#632), and the
  discovery that the documented mTLS recipe never actually requested a peer
  certificate (#565).  Four breaking changes, so a minor — see `CHANGELOG.md`.
- Next window is open (`[Unreleased]`).  Every `severity: high` finding from
  both audit passes is now closed — the DevTools origin check (#566), the CBOR
  bignum decode (#567), colliding entity names (#568), the Hono socket leak
  (#570) and the two CRDT gossip findings (#698, #699) — along with the
  cluster `hello` identity binding (#912) the gossip-authority rules rest on,
  the CRDT wire-authority pass (#719, #723, #725, #768), a set of core
  resource leaks (#641, #642, #644, #645) and the persistence-compaction pair
  (#628, #629).  `preRestart` stops children now (#634), and a resumed actor
  brings its subtree back with it (#635).

  The obvious heads from here: the `reference.conf` expansion tracked in
  #887, the remaining `severity: medium` security catalogue, and #766 — whose
  titled fix turns out to be insufficient on its own, see the issue.
- ~3 930 tests green (unit + multi-node + in-process integration) + 15 real-network multi-node integration scenarios green; open bugs are tracked as `[Bug]` issues in the tracker.
- A full audit-catalog of follow-up items is tracked in the issue tracker — security findings, framework features, code-quality refactors.  Filter by label `security` + `severity: <tier>` or by title prefix `[Security] ` / `[Feature] `.

## Done since the last roadmap update

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
- PersistenceQuery `AllPersistenceIds` live + cursor-paginated `currentPersistenceIds` — #156
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
