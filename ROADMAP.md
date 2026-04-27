# Roadmap

This document tracks features that are intentionally *not* in the
current release and the rough direction we'd like to take.  Nothing
here is committed work — it's a sketch, not a contract.  See
`README.md` → "What's in here / What isn't" for current scope.

## Likely next

- gRPC reflection + health service auto-registration
- gRPC client-stream as a first-class call mode (currently via bidi)
- Kafka exactly-once via manual offset-commit mode
- WebSocket server-side upgrade integration (Fastify + Hono adapters)
- NATS JetStream support (durable streams + consumers)
- Master-key rotation for client-side AES-encrypted snapshots —
  encode key-version into the manifest header

## Want, but bigger

- Schema-Registry / Avro / Protobuf integration outside gRPC
- Rolling-deployment-friendly migration (read-with-old, write-with-new)
- One-shot migration script — wrap legacy raw events into versioned
  envelopes for repos that adopt schema-evolution after-the-fact
- Distributed tracing (OpenTelemetry) across actor hops + cluster
  transport
- Metrics export (Prometheus / OpenMetrics)
- Documentation site (TypeDoc + custom layout)
- Performance benchmarks against Akka.NET / Akka (JVM)

## Maybe (demand-driven)

- ZeroMQ broker actor
- STOMP broker actor
- Cluster-wide single-flight for `cached()` response cache (currently
  per-process only)
- `mget` / `mset` for the Cache interface (when a workload demands)
- MQTT 5.0 user properties + reason codes
- MinIO / Mosquitto / Kafka / RabbitMQ / NATS live-integration tests
  enabled by default in CI (currently env-gated)

## Explicitly out of scope

- Multi-process safety for `FilesystemObjectStorageBackend` — the
  in-memory ETag map is per-process by design.  Use the S3 backend
  in any multi-process deployment.
- "Auto-magic" cache invalidation by tag / pattern — known bug-source.
  Invalidation is an explicit `cache.delete(...)` for now.
- Backwards-compatibility guarantees of any kind pre-1.0.

## Known issues

- `tests/unit/util/Option.test.ts:81` — pre-existing `typecheck:dev`
  failure (TypeScript narrows `seen` to `null` after the first
  assignment; not blocking, but tracked).
- `zstd` peer-dep error surfaces only on the first compress / decompress
  call rather than at plugin-init time — would be cleaner up-front.
- `FilesystemObjectStorageBackend` ETag map is per-process — see "out
  of scope" above; the doc-string warns about it.
