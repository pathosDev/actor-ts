# Roadmap

This document tracks the planned direction.  Nothing here is committed work — it's a sketch, not a contract.  See `README.md` → "What is this?" for the current scope and `CHANGELOG.md` for what landed in the most recent release.

## Status

- Post-v0.10.0, preparing v0.11.0 (`[Unreleased]` window): repo-wide naming
  conventions + the `OptionsValidator` / `OptionsError` layer + WebSocket/HTTP
  security hardening.
- ~2 650 tests green (unit + multi-node + in-process integration) + 15 real-network multi-node integration scenarios green; bug-backlog at 0.
- A full audit-catalog of ~175 follow-up items is tracked in the issue tracker — security findings, framework features, code-quality refactors.  Filter by label `security` + `severity: <tier>` or by title prefix `[Security] ` / `[Feature] `.

## Done since the last roadmap update

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
  - Backend `remoteAddress` wiring for Fastify / Express / Hono (#312 follow-up)
- v0.7.0 — `mget` / `mset` on the `Cache` interface (#14), MQTT 5.0 user properties + reason codes (#13)
- v0.8.0 — Cluster-management extended HTTP endpoints (#56), Re-encryption sweep + journal-to-journal copy + ClusterClient + WriteConsistency/ReadConsistency
- v0.8.0 — 8 security-hardening fixes (wire-frame DoS cap, FS path-traversal guard, Memcached CRLF, gossip version cap, snapshot seq integrity, WebSocket frame cap, hello-handshake hijack defense, idempotency body-fingerprint)

## Feature-parity quick wins

- `Inbox` — synchronous adapter for non-actor callers — #181
- PersistenceQuery `AllPersistenceIds` live + cursor-paginated `currentPersistenceIds` — #156
- `DeathWatch.watchWith` — custom termination message — #159
- `ShardCommand` types — `StartEntity`, `GetShardStats`, `GetClusterShardingStats` — #151
- MultiNodeSpec `enterBarrier` — #198 (was #47)

## Production features (Orleans / Vlingo-inspired)

- Persistent reminders (Orleans-style durable timers) — #168
- Stateless workers — per-node pool of identical activations — #170
- Saga / process-manager with compensations — #179
- Placement strategies (PreferLocal / HashBased / ActivationCountBased) — #169

## Novel differentiators (each own plan-slot)

- Deterministic-simulation-testing (FoundationDB-style seeded virtual-time replay) — #200
- LLM-tool-call-as-actor primitive — #202
- Live cluster visualizer (ships in package) — #204
- Per-entity chaos injection — #206

## Bigger threads (L / XL — own design phase)

- Streams DSL subset (`SourceQueue`, `MergeHub`, `BroadcastHub`) — #147 (legacy #54)
- WASM / edge-runtime subpackage — #209
- Distributed transactions (Orleans-style ACID 2PC across grains) — #171
- Multi-DC clustering with DC-local failure detection — #149

## Documentation

- Documentation site with TypeDoc + custom layout (#26)
- Performance benchmarks vs JVM actor frameworks (#27)

## Explicitly out of scope

- "Auto-magic" cache invalidation by tag / pattern — known bug-source; invalidation stays explicit via `cache.delete(...)`.
- Backwards-compatibility guarantees of any kind — pre-1.0.
- Pull requests — not accepted; well-shaped issues are (the issue tracker is the contribution channel, see `README.md` → "Roadmap & status").

→ Full catalog (all ~175 items): GitHub issues, filterable by title prefix `[Security]` / `[Feature]` and the `security` / `severity: …` labels.
