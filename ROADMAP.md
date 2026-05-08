# Roadmap

This document tracks features that are intentionally *not* in the
current release and the rough direction we'd like to take.  Nothing
here is committed work — it's a sketch, not a contract.  See
`README.md` → "What's in here / What isn't" for current scope.

## Likely next

- Documentation site (TypeDoc + custom layout) (#26)
- Performance benchmarks against Akka.NET / Akka (JVM) (#27)
- gRPC reflection + health-service auto-registration (#4)
- gRPC client-stream as a first-class call mode — currently via bidi (#5)

## Want, but bigger

- Akka-Streams-style reactive streaming DSL (Source / Flow / Sink) (#54)
- Cassandra `events_by_tag` side-table for indexed tag queries (#44)
- MultiNodeSpec barrier sync — Akka-style `enterBarrier(name)` (#47)
- Cluster-management HTTP endpoints — extended (shards,
  leave-and-shutdown, metrics) (#56)

## Maybe (demand-driven)

- ZeroMQ broker actor (#15)
- STOMP broker actor (#16)
- Cluster-wide single-flight for `cached()` response cache — currently
  per-process only (#12)
- `mget` / `mset` for the Cache interface, when a workload demands (#14)
- MQTT 5.0 user properties + reason codes (#13)
- MinIO / Mosquitto / Redpanda / RabbitMQ / NATS live-integration tests
  enabled by default in CI — currently env-gated (#20–#24)

## Explicitly out of scope

- "Auto-magic" cache invalidation by tag / pattern — known bug-source.
  Invalidation is an explicit `cache.delete(...)` for now.
- Backwards-compatibility guarantees of any kind pre-1.0.
