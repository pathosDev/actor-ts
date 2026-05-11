# Roadmap

This document tracks the planned direction.  Nothing here is committed work — it's a sketch, not a contract.  See `README.md` → "What's in here / What isn't" for the current scope and `CHANGELOG.md` for what landed in the most recent release.

## Status

- Post-v0.8.0 + 8 security-hardening fixes (`d454079` → `4cac92a`).
- ~1 720+ tests green; bug-backlog at 0.
- A full audit-catalog of ~184 follow-up items is tracked in the issue tracker — security findings, framework features, code-quality refactors.  Filter by label `security` + `severity: <tier>` or by title prefix `[Security] ` / `[Feature] `.

## Done since the last roadmap update

- `mget` / `mset` on the `Cache` interface (#14) — landed in v0.7.0
- MQTT 5.0 user properties + reason codes (#13) — v0.7.0
- Cluster-management extended HTTP endpoints (#56) — v0.8.0
- Re-encryption sweep + journal-to-journal copy + ClusterClient + WriteConsistency/ReadConsistency — v0.8.0
- 8 security-hardening fixes — wire-frame DoS cap, FS path-traversal guard, Memcached CRLF, gossip version cap, snapshot seq integrity, WebSocket frame cap, hello-handshake hijack defense, idempotency body-fingerprint

## Highest priority (critical / high security)

- DurableState revision tampering (CRITICAL) — #116
- ClusterClient askId predictability (HIGH) — #120
- Master-key rotation sweep race (HIGH) — #109
- LeaseMajority split-brain at network-latency (HIGH) — #142

## Akka-parity quick wins

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

- Akka-Streams DSL subset (`SourceQueue`, `MergeHub`, `BroadcastHub`) — #147 (legacy #54)
- WASM / edge-runtime subpackage — #209
- Distributed transactions (Orleans-style ACID 2PC across grains) — #171
- Multi-DC clustering with DC-local failure detection — #149

## Documentation

- Documentation site with TypeDoc + custom layout (#26)
- Performance benchmarks vs Akka.NET / Akka JVM (#27)

## Explicitly out of scope

- "Auto-magic" cache invalidation by tag / pattern — known bug-source; invalidation stays explicit via `cache.delete(...)`.
- Backwards-compatibility guarantees of any kind — pre-1.0.
- Pull requests — see `README.md` → "Pull requests are not accepted, but well-shaped issues are."

→ Full catalog (all ~184 items): GitHub issues, filterable by title prefix `[Security]` / `[Feature]` and the `security` / `severity: …` labels.
