# Roadmap

This document tracks the planned direction.  Nothing here is committed work — it's a sketch, not a contract.  See `README.md` → "What is this?" for the current scope and `CHANGELOG.md` for what landed in the most recent release.

## Status

- Post-v0.11.0, preparing the next minor (`[Unreleased]` window): the naming
  sweep extended to every identifier (locals, generic parameters, the `kind`
  discriminant) + TypeScript 7 native compiler (#361) + raised runtime floors
  (Node ≥ 24, Bun ≥ 1.3) + dependency bumps.  The window's headline additions
  are the **DevTools suite** (#445) and **five more persistence backends**
  (#438) on the new relational base layer (#389), plus a **core-correctness
  pass** over the 2026 audit's findings — see *Done*, below.
- ~3 395 tests green (unit + multi-node + in-process integration) + 15 real-network multi-node integration scenarios green; open bugs are tracked as `[Bug]` issues in the tracker.
- A full audit-catalog of follow-up items is tracked in the issue tracker — security findings, framework features, code-quality refactors.  Filter by label `security` + `severity: <tier>` or by title prefix `[Security] ` / `[Feature] `.

## Done since the last roadmap update

- **Current `[Unreleased]` window:**
  - **DevTools suite (#445)** — embeddable web UI for a running system, seven
    panels on one versioned tap protocol behind a `./devtools` export.  Absorbed
    the separately-listed live cluster visualizer (#204)
  - **Five more persistence backends (#438)** — MongoDB, DynamoDB, MS SQL,
    libSQL/Turso, Cloudflare D1, each with journal + snapshot + durable-state,
    on the new relational base layer (#389); CockroachDB + YugabyteDB certified
    on the Postgres stores (#401)
  - **Documentation site (#26)** — Starlight, with a 1:1 German mirror and a
    generated TypeDoc API reference at `actor-ts.dev/api/`
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
