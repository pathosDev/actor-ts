#!/usr/bin/env bash
# Create the standing roadmap / known-issue / infrastructure issues.
# Idempotent: skips any title already present.
set -euo pipefail

REPO="pathosDev/actor-ts"

existing=$(gh issue list --repo "$REPO" --state all --limit 200 --json title --jq '.[].title' || echo "")

issue() {
  local labels="$1"; shift
  local title="$1"; shift
  local body="$1"
  if echo "$existing" | grep -Fxq "$title"; then
    echo "skip: '$title' (already exists)"
  else
    gh issue create --repo "$REPO" --label "$labels" --title "$title" --body "$body"
  fi
}

# --- enhancements ------------------------------------------------------

issue "enhancement" "WebSocket server-side upgrade integration with Fastify/Hono backends" \
"Today WebSocketActor is client-mode only.  Server-side wants to accept an HTTP upgrade from inside Fastify or Hono and hand the resulting connected socket to a WebSocketActor (or a server-side variant) — so user code can subscribe / send through the actor model instead of writing raw upgrade handlers.  Backend-specific because each HTTP backend exposes the upgrade surface differently."

issue "enhancement" "Kafka exactly-once via manual offset-commit mode" \
"KafkaActor currently uses kafkajs auto-commit (at-least-once).  Add a manual-commit mode where the actor re-emits offsets along with consumed records and waits for an explicit { kind: 'commit', offset } from the handler before advancing.  Closes the gap for apps that need exactly-once-with-processing semantics."

issue "enhancement" "NATS JetStream support (durable streams + consumers)" \
"NatsActor only implements NATS-Core pub/sub today.  JetStream adds durable streams + consumer groups + replay — a separate enough concept that it warrants its own actor (JetStreamActor?) sharing BrokerActor infrastructure but with very different semantics around acks / pull-vs-push consumers / stream config."

issue "enhancement" "gRPC reflection + health service auto-registration" \
"Optional flag on GrpcServerActor that auto-registers grpc.reflection.v1alpha.ServerReflection and grpc.health.v1.Health.  Currently users have to grab the underlying server handle and register them manually."

issue "enhancement" "gRPC client-stream as a first-class call mode" \
"v0.5.0 supports unary, server-stream, bidi-stream — client-stream is currently emulated via bidi with ignored inbound.  Adding it as its own mode tightens the API for write-only clients (telemetry firehoses, log shippers)."

issue "enhancement" "Schema-Registry / Avro / Protobuf integration outside gRPC" \
"For journal payloads (events / snapshots) — pluggable codec on the wire side, schema registry for compatibility checks (Confluent-style or in-process Zod registry).  Bigger lift than MigrationChain / defaultsAdapter; would slot in alongside them."

issue "enhancement" "Rolling-deployment-friendly schema migration (read-with-old, write-with-new)" \
"For a deploy where v1 + v2 readers/writers run side-by-side: support 'I can read both v1 and v2; on save I emit v2 only'.  Today the actor chooses one currentVersion at boot.  Needed for zero-downtime schema upgrades in production."

issue "enhancement" "Master-key rotation for client-side AES-encrypted snapshots" \
"Encryption.deriveSubkey takes a single masterKey today.  Rotation needs the manifest header to carry a key-version byte and the encrypt path to know which key is current.  Decrypt picks the right master based on version.  Out-of-scope work spelled out in BodyCodec.ts comments."

issue "enhancement" "One-shot migration script for repos adopting schema-evolution after-the-fact" \
"Existing journals with raw events (no envelope) can't be read by an actor that has an EventAdapter set (strict mode throws).  A standalone CLI that reads the journal, wraps every entry in a v1 envelope, writes back — for the upgrade window."

issue "enhancement" "Distributed tracing (OpenTelemetry) across actor hops + cluster transport" \
"OTel context propagation through tells / asks / cluster wire / persistence calls.  Spans for actor onReceive, persist, ask, snapshot save, broker publish.  Designed to be opt-in (zero overhead when not enabled)."

issue "enhancement" "Metrics export (Prometheus / OpenMetrics)" \
"Counter / histogram surface for actor-creation-rate, mailbox-depth, persist-latency, cluster-gossip-rounds, broker-connect-attempts, etc.  Pluggable exporter (Prom default, OTel as alternative)."

issue "enhancement" "Cluster-wide single-flight for cached() HTTP response cache" \
"v0.5.0 has per-process stampede protection.  For multi-replica deployments where the cache is shared (Redis), a coordinated single-flight via a Redis SETNX lock prevents N replicas from all running the handler on the same simultaneous miss."

issue "enhancement" "MQTT 5.0 user properties + reason codes in MqttActor" \
"Today we only carry topic/payload/qos/retain.  v5 adds user properties (custom KV pairs) and reason codes — useful for IoT scenarios that lean on them."

issue "enhancement" "mget / mset for the Cache interface" \
"Defer-until-needed bulk ops.  Five primitives today (get/set/incr/setIfAbsent/delete) cover ~95% of workloads; bulk would cut round-trips for sharded entity hydration scenarios but isn't pulling its weight yet."

issue "enhancement" "ZeroMQ broker actor (demand-driven)" \
"ZeroMqActor over the 'zeromq' npm package — REQ/REP, PUB/SUB, ROUTER/DEALER patterns.  Defer until somebody actually asks; the integration table currently lists it as 'maybe'."

issue "enhancement" "STOMP broker actor (demand-driven)" \
"StompActor over the 'stompjs' package for ActiveMQ / older RabbitMQ deployments.  Niche enough that it stays demand-driven."

# --- bugs --------------------------------------------------------------

issue "bug" "Pre-existing typecheck:dev failure in tests/unit/util/Option.test.ts:81" \
"bun run typecheck:dev (which includes the tests + benchmarks workspace) hits TS narrowing on let seen: number | null = null; ... ; expect(seen).toBe(42) — TS narrows seen to null after the assignment, the assertion fails to typecheck.  The test runs correctly at runtime; just needs an explicit cast or split into two variables.  Tracked but not blocking — the shipping bun run typecheck (src only) is clean."

issue "bug" "zstd peer-dep error surfaces only on first compress/decompress, not at plugin init" \
"When the user picks compression: { algorithm: 'zstd' } without a native runtime impl AND without fzstd installed, the error appears on the first persist call rather than at plugin-init.  Should be surfaced eagerly with a clear 'install fzstd' message during registerObjectStoragePlugins."

issue "bug" "FilesystemObjectStorageBackend ETag map is per-process — multi-process write is unsafe" \
"Documented in class JSDoc but worth a tracked issue: two concurrent processes hitting the same directory can corrupt the etag-based CAS map.  Recommendation: use S3 (or S3-compatible like MinIO) for any deployment with more than one writer process.  No fix planned; this is a deliberate scope cut."

# --- infrastructure ----------------------------------------------------

issue "infrastructure" "MinIO live-integration tests in CI" \
"Tests under tests/unit/persistence/object-storage/S3ObjectStorageBackend.test.ts skip themselves when env vars (S3_ENDPOINT etc.) are missing.  Add a CI job that brings up MinIO via Docker and sets those env vars so the integration tests actually run on PRs."

issue "infrastructure" "Mosquitto live-integration tests for MqttActor" \
"docker run --rm -p 1883:1883 eclipse-mosquitto + an env-gated test file mirroring the broker contract (publish, subscribe, QoS round-trip, LWT, reconnect)."

issue "infrastructure" "Redpanda live-integration tests for KafkaActor" \
"Redpanda is a kafka-compatible broker that boots in seconds (vs Confluent), so it's CI-friendly.  Test consumer-group offset commit, producer idempotency, partition-aware produces."

issue "infrastructure" "RabbitMQ live-integration tests for AmqpActor" \
"docker run --rm -p 5672:5672 rabbitmq:3-management + tests for queue / exchange / routing-key / prefetch / manual-ack flows."

issue "infrastructure" "NATS live-integration tests for NatsActor" \
"docker run --rm -p 4222:4222 nats:latest + pub/sub round-trip, request-reply, subject wildcards, reconnect-on-server-restart."

# --- documentation -----------------------------------------------------

issue "documentation" "Architecture diagrams in README — actor lifecycle, cluster gossip, sharding" \
"Mermaid diagrams or hand-drawn SVGs covering the three core mental models.  Keep them small + scannable; not a replacement for prose."

issue "documentation" "Documentation site (TypeDoc + custom layout)" \
"GitHub Pages deploy of TypeDoc-generated API reference plus the README sections rendered as standalone pages.  Adds a 'Docs' link to the README and reduces README length."

issue "documentation" "Performance benchmarks vs Akka.NET / Akka (JVM)" \
"benchmarks/ already has micro-benches.  Compare side-by-side: actor creation, tell throughput, ask latency, sharding rebalance time, persist throughput.  Sets realistic expectations for a TS port (we're slower than the JVM, but how much?)."

echo
echo "issues: done."
