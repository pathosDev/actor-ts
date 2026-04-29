# Changelog

All notable changes to this project follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is a pre-1.0 hobby project — every minor version is potentially
breaking.  See `ROADMAP.md` for what's coming, and `README.md` →
"What's in here / What isn't" for current scope honesty.

## [0.6.0] — 2026-04-30

### Added — multi-node test harness + cluster sharding hardening

- `MultiNodeSpec` test harness — in-process N-role cluster with
  failure-detector tightening, partition / heal helpers,
  `awaitMembers` / `awaitMemberStatus` / `awaitLeader` synchronisation,
  per-role downing-provider injection (#34).
- `ParallelMultiNodeSpec` — worker-thread variant for tests that need
  true parallelism across OS threads (#46).
- Sharding rebalance hardening + sharded-daemon failover; `Passivate`
  semantics across shard hand-off; coordinator state machine
  reviewed against partition / leader-change scenarios (#35).
- Persistent `ShardCoordinator` allocation state via `DistributedData`
  — survives leader hand-off without re-emitting allocations (#39).
- Persistent Remember-Entities — entity list rides through cluster
  restart instead of being re-discovered lazily (#49).
- `KubernetesLease` real implementation against the K8s coordination
  API (replaces the stub from 0.2) (#33).
- `ClusterSingleton` accepts an optional Lease for split-brain-safe
  handover (#38, #61).
- `ShardCoordinator` accepts an optional Lease for split-brain-safe
  coordinator handover (#60).
- `LeaseMajority` split-brain resolver — external Lease as tiebreaker
  in the partition-resolution race (#51).

### Added — persistence performance + projections + replicated ES

- Persistence Query / projections read-side query layer:
  `PersistenceQuery` with `eventsByPersistenceId` / `eventsByTag`, plus
  `ProjectionActor` with at-least-once delivery + offset persistence
  (`InMemoryOffsetStore`, `DurableStateOffsetStore`) (#36).
- Push-based `PersistenceQuery` — events delivered on append via
  `JournalEventBus` instead of polling (#42).
- SQLite tags join table — indexed `events_by_tag` query path (#43).
- Snapshotting for `ReplicatedEventSourcedActor` — vector-clock-aware
  snapshots survive multi-master replay (#41).
- Durable `DistributedData` — CRDT state survives full cluster
  restart via per-replica `DurableStateStore` records (#40).
- CRDTs + Replicated Event Sourcing core: `GCounter`, `PNCounter`,
  `GSet`, `ORSet`, `LWWRegister`, `DistributedData` extension with
  gossip replication; `ReplicatedEventSourcedActor` for multi-master
  event sourcing with conflict-resolver pluggability (#37).

### Added — additional CRDTs + persistent FSM + DX patterns

- `LWWMap`, `ORMap`, `MVRegister`, `GCounterMap` — round out the CRDT
  family.  All four implement the same `Crdt<Self>` interface,
  expose `equals` / `toJSON` / `fromJSON`, and are wired into
  `DistributedData`'s discriminator (#45).
- `PersistentFSM` — finite-state machine combined with event sourcing.
  Declare a transitions table, an `applyEvent` function, and the
  base class handles invalid-transition rejection, guard checks,
  and replay-driven state rebuild (#52).
- `BackoffSupervisor` — restart-with-exponential-backoff supervisor
  for transient failures, with optional message stash during the
  backoff window and a configurable counter-reset rule (#48).
- `ClusterRouter` — cluster-aware router with role filter + four
  routing strategies (round-robin, random, consistent-hashing,
  broadcast).  Routees auto-rebuild on `MemberUp` / `MemberRemoved`
  (#50).

### Added — observability stack

- `LogContext` — Mapped Diagnostic Context (MDC) backed by
  `AsyncLocalStorage`.  Propagates through `tell` / `ask` calls and
  across cluster nodes; `Logger.withFields` for static fields,
  `LogContext.run` / `with` for dynamic scoping (#53).
- Prometheus / OpenMetrics export — `MetricsRegistry` with
  Counter / Gauge / Histogram primitives, label support,
  `exportPrometheus` text-format renderer, `prometheusHandler`
  for `Bun.serve`.  Stock instrumentation: actor lifecycle counters,
  message-handler-duration histogram, cluster gossip + member-up
  metrics.  Opt-in via `MetricsExtensionId.enable()` so the no-
  metrics path is zero-cost (#11).
- OpenTelemetry-style distributed tracing — `Tracer` interface +
  `RecordingTracer` reference impl + W3C `traceparent` codec.
  `actor.receive` and `cluster.envelope.received` spans wired
  automatically; trace context rides cross-wire envelopes
  alongside MDC.  `@opentelemetry/api` is NOT a dependency — users
  bring their own SDK and wrap it in the framework's `Tracer` (#10).

### Added — schema migration & encryption polish

- Master-key rotation for client-side AES-256-GCM snapshots — new
  `MasterKeyRing` shape (`active` + `retired`), key-version byte
  in the body manifest (`FLAG_KEY_VERSIONED`), legacy single-key
  bodies remain readable (#8).
- Rolling-deployment-friendly schema migration — `MigrationChain`
  gains downcasters; `migratingAdapter` / `defaultsAdapter` accept
  a `writeVersion` so v2 nodes can keep emitting v1 events while
  v1 readers still exist (#7).
- One-shot migration helpers — `wrapEventAsEnvelope` /
  `wrapStateAsEnvelope` primitives plus `migrateInMemoryJournal` /
  `migrateSnapshotStore` bulk-rewriters for repos adopting
  schema-evolution after-the-fact (#9).
- Pluggable codec + in-process schema registry — `Codec<T>`
  interface with `jsonCodec` / `zodCodec` / `composeCodecs`,
  `validatedEventAdapter` / `validatedSnapshotAdapter` wrappers,
  `InMemorySchemaRegistry` with on-register compatibility checks
  (`'none'` / `'backward'` / `'sample'`) (#6).

### Added — production-grade brokers & WebSocket server-side

- Kafka exactly-once via manual offset-commit mode — opt-in
  `commitMode: 'manual'` pumps each message into a pending-promise
  map until the handler sends `commit` / `nack` / timeout fires;
  `commitOffsets` uses BigInt arithmetic so 2^53+ offsets stay
  exact (#2).
- NATS JetStream actor — durable streams + push consumer with
  `ack` / `nak` / `term` / `inProgress` handshake; auto-create-or-
  update streams + consumers; idempotent publish via `messageId`
  (`Nats-Msg-Id`) (#3).
- Server-side WebSocket — `ServerWebSocketActor` wraps a pre-
  upgraded socket; `serverWebSocketActorOf` for the `ws`-package
  family (Fastify, Hono); `bunWebSocketHandlers` for `Bun.serve`'s
  callback-style API (#1).

### Added — README architecture diagrams

- Three architecture diagrams in the README — actor lifecycle
  state machine, cluster gossip flow, sharding allocation +
  hand-off (#25).

### Fixed

- `DistributedPubSubMediator` — eager broadcast on subscribe /
  unsubscribe.  The previous "one random peer per gossip tick"
  scheme had a probabilistic gap (~3 % per 5-tick window) where
  a publish-immediately-after-subscribe could miss the new
  subscriber.  Eager-broadcast on state mutation closes the gap
  deterministically; periodic gossip stays as steady-state
  anti-entropy.  Eliminated CI flake on
  `tests/multi-node/pubsub-cross-node.test.ts` and
  `tests/multi-node/parallel-pubsub.test.ts`.
- Five small correctness items batched together: `tests/unit/util/
  Option.test.ts` typecheck:dev failure (#17), eager peer-dep
  validation at object-storage plugin-init for every codec
  (#18, #59), `ORSet` / `GSet` element-identity callbacks for
  non-JSON-serialisable values (#57), single-actor-per-pid
  enforcement for `ReplicatedEventSourcedActor` (#58).

## [0.5.0] — 2026-04-27

### Added — I/O & message-broker actors

- `BrokerActor` base with reconnect (exponential backoff + optional
  CircuitBreaker), outbound buffer, subscriber fan-out, lifecycle
  events on the EventStream, and a 3-layer settings resolver
  (constructor → HOCON → defaults).
- Phase 1 actors: `TcpSocketActor`, `UdpSocketActor`, `MqttActor`,
  `WebSocketActor`.
- Phase 2 actors: `KafkaActor`, `AmqpActor`, `GrpcClientActor`,
  `GrpcServerActor`.
- Phase 3 actors: `NatsActor`, `RedisStreamsActor`, `SseActor`.
- Examples: `examples/io/{mqtt-temperature,websocket-feed,grpc-sensor}.ts`.

## [0.4.0] — 2026-04-27

### Added — object-storage + schema migration + caching

- Object-storage persistence: `ObjectStorageBackend` interface,
  `FilesystemObjectStorageBackend` (built-in), `S3ObjectStorageBackend`
  (lazy AWS SDK; works against AWS / MinIO / R2 / Backblaze B2 /
  Wasabi).  `BodyCodec` with manifest header — gzip / zstd
  compression and AES-256-GCM client-side encryption (HKDF-SHA256
  per-pid subkey derivation, compress-then-encrypt).
- `ObjectStorageSnapshotStore` + `ObjectStorageDurableStateStore` with
  per-prefix compression / encryption resolvers and per-actor
  overrides via `PersistenceOptions`.
- Schema migration: `EventAdapter` / `SnapshotAdapter` / `StateAdapter`
  interfaces with a versioned `_v / _t / _e` envelope wire format,
  plus `MigrationChain` for hand-written upcasters and
  `defaultsAdapter` for additive evolution without code.  Hooks
  on `PersistentActor` + `DurableStateActor`.
- Cache abstraction: `Cache` interface (get / set / incr /
  setIfAbsent / delete) + 3 backends (`InMemoryCache`, `RedisCache`
  via lazy ioredis, `MemcachedCache` via lazy memjs).
  `CacheExtension` for named-cache registration.
- HTTP middleware: `rateLimit`, `idempotent` (Stripe-style), `cached`
  (response-cache with stampede protection).
- `CachedSnapshotStore` decorator wrapping any `SnapshotStore` for
  cold-start storms after sharding rebalance.
- Examples: `examples/cache/redis-rest-service.ts`,
  `examples/persistence/{event-migration,event-migration-chain,
  s3-snapshot-bank-account}.ts`.

## [0.3.0] — 2026-04-27

### Added — persistence + HTTP

- Persistence: `Journal`, `SnapshotStore`, `DurableStateStore`
  interfaces.  `PersistentActor` (event sourcing with
  snapshotPolicy + persist callback) and `DurableStateActor`
  (snapshot-only with strict CAS via expectedRevision).
- Three persistence backends ship: `InMemoryJournal` /
  `InMemorySnapshotStore` (default), `SqliteJournal` /
  `SqliteSnapshotStore` (Bun via bun:sqlite, Node via
  better-sqlite3 — abstracted by a `SqliteDriver`), `CassandraJournal`
  / `CassandraSnapshotStore` (lazy cassandra-driver).
- HTTP service stack: directives DSL (get / post / put / del / patch /
  path / pathPrefix / concat) compiling to backend-agnostic
  `CompiledRoute`; three backends — `FastifyBackend` (default),
  `ExpressBackend`, `HonoBackend` (with auto-detection of the right
  serve primitive per runtime).  `HttpClient` for outbound calls.

## [0.2.0] — 2026-04-27

### Added — distributed primitives

- HOCON config (parser + ENV interpolation + Duration / Size types).
- JSON + CBOR serialization (`Serializer<T>` interface with manifest
  tagging; SerializationExtension for plugin registration).
- `CoordinatedShutdown` (12-phase, dependency-ordered task runner) and
  `Lease` abstraction (with InMemoryLease + KubernetesLease impls).
- Cluster fabric: TCP / in-memory / worker-thread transports;
  membership state machine + gossip; failure detection (Phi-Accrual
  default + simple time-threshold variant); `ClusterEvents` on
  EventStream.
- Cluster sharding: `ShardCoordinator`, `ShardRegion`,
  `ClusterSharding` extension; `HashAllocationStrategy` /
  `LeastShardAllocationStrategy`; `Passivate` for entity lifecycle;
  `ShardedDaemonProcess` for fixed N workers across the cluster.
- Distributed pub/sub (`DistributedPubSubMediator`); `Receptionist`
  service-key registry; `ClusterSingleton` (manager + proxy + lease-
  based variant); `ReliableDelivery` (at-least-once point-to-point
  with explicit acks).
- Four split-brain resolvers (KeepMajority / KeepOldest /
  StaticQuorum / KeepReferee).
- Four seed providers (Config / DNS / Kubernetes API / Aggregate),
  with an in-process TTL cache on the DNS provider.
- Management endpoints: `/health`, `/ready`, `/cluster/state`, etc.

## [0.1.0] — 2026-04-27

### Added — minimum viable actor system

- `Actor` base class + lifecycle hooks (preStart / postStop /
  preRestart / postRestart) + `ActorRef` / `ActorContext` /
  `ActorPath` / `ActorSelection`.
- `ActorSystem`, `Props`, `Extension` registry, `SystemMessages` (the
  internal control protocol — Watch / Unwatch / Terminated / Suspend
  / Resume / Stop / …).
- Supervision: `OneForOneStrategy` / `AllForOneStrategy` with Resume
  / Restart / Stop / Escalate directives.
- Mailbox variants: unbounded (default), bounded with three overflow
  policies, priority (with caller-supplied comparator), per-actor
  stash.
- `ActorCell` + `Guardian` + `DeadLetterRef` + `LocalActorRef` +
  `PromiseActorRef`; deathwatch, `ReceiveTimeout`, become / unbecome,
  per-actor `TimerScheduler`.
- `Scheduler` (real timers + `ManualScheduler` for tests),
  `Dispatcher` variants, `Logger` (leveled + Noop), `EventStream`
  (system-wide pub/sub on classes).
- `typed` Behaviors DSL — functional facade over the OO API
  (`Behaviors.receive`, `Behaviors.same`, `Behaviors.stopped`,
  `Behaviors.setup`, supervise + withSupervision).
- TestKit: `TestProbe` (synchronous mailbox with expect-* timeouts),
  `ManualScheduler` (virtual clock).
- Patterns: `ask` (Promise-returning send) + `retry` (exponential
  backoff) + `CircuitBreaker` + `Router` (round-robin / random /
  broadcast) + `after` + `pipeTo`.
- `FSM` DSL — named-state finite-state-machine actor base.
- Utility primitives: `Option<T>`, `Lazy<T>`, `Try<T>`, `Either<L,R>` —
  Scala-style ergonomics, used throughout.
