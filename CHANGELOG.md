# Changelog

All notable changes to this project follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is a pre-1.0 hobby project — every minor version is potentially
breaking.  See `ROADMAP.md` for what's coming, and `README.md` →
"What is this?" for current scope honesty.

## [Unreleased]

### Added

- **`cluster_gossip_records_refused_total{reason}`** (#114, #138).  Counts
  gossiped member records a merge-path guard turned away.  `reason` is closed to
  `version-skew`, `map-cap` and `timestamp-skew` so the series count cannot
  follow an attacker's record count — the cardinality lesson from #131 applied at
  the point where it would have hurt most.

- **Utility helpers on the public surface** (#1034).  `randomString`,
  `randomHex`, `randomId`, `safeStringify` and `lazyImportModule` are now
  re-exported from the root barrel, together with the `RandomStringOptions`
  and `LazyImportOptions` types.  All five already existed under `src/util/`
  and the framework runs on them; nothing but the barrel kept them from
  consumers, since `package.json` ships only `dist/` and its `exports` map has
  no wildcard.  Each answers a problem that does not stop at the framework
  boundary: `randomId` names something so the name cannot be guessed — an
  actor name ends up in an actor path, and a path is an address that anything
  on the cluster wire can send to, which is why a counter is the wrong shape;
  `safeStringify` renders a value on a path where `JSON.stringify` would throw
  on a cycle or a `BigInt` and so replace the error being reported with one
  thrown from inside the reporting code; `lazyImportModule` imports an
  optional peer dependency or fails with a message naming the package and the
  install command — the pattern the docs already recommend for user-written
  integrations.  `wrapError`, `mergeOptions`, `CidrMatch` and the shared
  `Constants` stay internal, and `TokenBucket` deliberately so: #636 is an
  open bug in it and #666 changes its options shape, so exporting it now would
  turn both into breaking changes to a published API.  Documented on the new
  bilingual `reference/utility-helpers` page.

- **`actor-ts.distributed-data` HOCON block** (#856).  DistributedData read
  no configuration at all before this; it now layers `gossip-interval`,
  `max-pending-quorum-requests` and `max-quorum-timeout` under the explicit
  options in the documented precedence (options > HOCON > built-in
  defaults).  The block is top-level rather than under `cluster.*` because
  the module ships from `src/crdt/` and takes its cluster as a positional
  argument to `start`.  Only keys something actually reads are shipped, so
  the delta-CRDT, pruning and subscriber-notification keys the issue lists
  stay out until the features behind them exist.

- **Scatter/gather router** (#153).
  `Router.scatterGatherFirstCompleted(size, routee, options?,
  routeeOptions?)` asks every routee at once and answers the caller with the
  first reply — Akka's `ScatterGatherFirstCompletedPool`, the hedged-request
  pattern for tail latency.  The fan-out is fired without being awaited in
  the handler, so concurrent scatters overlap instead of serialising the
  router's mailbox; every failure rejects with an `AggregateError` carrying
  one error per routee (the message distinguishes "nobody replied in time"
  from "everyone failed"); the winning reply is attributed to the routee
  that produced it; and stopping or restarting the router fails its open
  scatters immediately rather than running out the configured clock.
  Configured through the new `ScatterGatherOptions` (`withTimeoutMs`,
  default 5 000 ms, validated at the factory call), instrumented with
  `router_scatter_gather_resolved_total{outcome}` and
  `router_scatter_gather_latency_seconds`, and documented on the new
  bilingual `routing/scatter-gather` page.
- **TCP listener actor** (#158).  `TcpServerActor` binds a port and serves
  every connection it accepts, closing the one half of the raw-TCP API that
  was genuinely missing — framing applied per accepted connection with its
  own re-assembly buffer, TLS and mTLS through the same cross-runtime TCP
  layer the cluster transport uses, and a `maxConnections` admission cap
  that refuses at the door rather than accepting a socket nobody reads from.
  Connections are addressed by an opaque `connectionId` instead of getting
  an actor each, because an actor's restart semantics cannot resurrect a
  peer's TCP connection; the configured `target` receives one kind-tagged
  union (`connectionOpened` / `frame` / `connectionClosed`) and the actor
  takes `send` and `close` for a single connection.  A frame past its size
  cap drops only the offending connection, a half-configured `tls`
  credential fails the actor's start instead of retrying forever behind the
  reconnect policy (#144), and `outboundBuffer` defaults to `0` because a
  write buffered while the port is down names a connection id that can never
  come back.  Configurable under `actor-ts.io.broker.tcp-server`; `tls` is
  code-only on purpose, since a config file is the wrong place for a private
  key.
- **`TcpFraming` moved to its own module** (#158).  The three framing
  strategies and their two size caps are now shared by `TcpSocketActor` and
  `TcpServerActor` rather than copied, so the parsing that four open
  security issues hang off exists once.  Behaviour is unchanged and the
  package-root export is unchanged; only a deep import of `TcpFraming` from
  `io/broker/TcpSocketActor.js` has to move to `io/broker/TcpFraming.js`.
- **Cluster subscriptions: `CurrentClusterState` snapshot replay +
  `ReachabilityChanged`** (#161).  `cluster.subscribe(listener, {
  replayMode: 'snapshot' })` replaces the per-member replay burst with one
  `CurrentClusterState` carrying the members, the unreachable subset and the
  leader — one callback instead of one per member, and it marks where the
  replay ends, which the event form cannot; the default stays `'events'`,
  unchanged for every existing subscriber.  The same change fixes what that
  replay used to say: it walked the raw member map and stopped after `up`,
  so a `removed` tombstone — kept for up to `tombstoneTtlMs`, a day by
  default — was replayed as `MemberJoined` for that whole day, and an
  `unreachable`, `leaving` or `down` member reached a late subscriber as
  nothing but `joined`.  The replay now follows `getMembers()` in address
  order and announces each member in the status it actually holds.
  `ReachabilityChanged(address, reachable)` is new alongside it:
  `MemberUnreachable` is a membership transition, so it also fires for a
  peer that *someone else* stopped hearing from — status travels in gossip —
  and it is only ever emitted for a member that was `up`, leaving a peer
  that falls silent while `joining` or `leaving` with no reachability signal
  at all; the new event is strictly the local failure detector's verdict,
  emitted on transition.  It carries no observer set — that needs an
  observer-to-subject table on the wire.  `MockCluster.subscribe` mirrors
  the real replay event for event, and the DevTools `cluster` stream gains a
  `reachability-changed` payload.

- **JetStream Key-Value actor** (#74).  `JetStreamKeyValueActor` +
  `JetStreamKeyValueOptions` bring JetStream's KV view into the actor
  system: `put` (with an optional `expectedRevision` for compare-and-swap
  writes), `get`, `delete`, `purge`, `keys`, and a `watch` / `unwatch`
  change feed.  Replies are `kind`-tagged messages delivered to the `target`
  the command carries, the same request/reply seam `GrpcClientActor` uses; a
  `watch` is held as desired state by `BrokerActor`, so it survives a
  reconnect and one issued during an outage lands on the next connect.  A
  per-key failure — a compare-and-swap conflict, say — is reported as
  `keyValueOperationFailed` rather than thrown, because throwing out of the
  dispatch path is how the base class learns the transport died.
  Configurable under `actor-ts.io.broker.jetstream-key-value`.
- **JetStream Object Store actor** (#74).  `JetStreamObjectStoreActor` +
  `JetStreamObjectStoreOptions` cover the object-bucket view with `put`,
  `get`, `delete`, `info` and `list`.  v1 moves an object as a **single
  message** and enforces that with `maxObjectBytes` (1 MiB by default): an
  oversized `put` is refused before the body enters the bounded outbound
  buffer, and an oversized `get` is refused from the object's metadata
  before the body is fetched — the buffer is sized in messages, not bytes,
  and evicts oldest-first, so a multi-megabyte body riding it would mean
  unbounded resident memory and silently discarded uploads.  Both refusals
  answer `objectStoreOperationFailed` naming the limit; `info` and `list`
  are unaffected.  Configurable under
  `actor-ts.io.broker.jetstream-object-store`.
- **DistributedPubSub anycast** (#155).  `Publish` takes a third argument,
  `delivery`, and `'one-subscriber'` hands the message to exactly one
  subscriber cluster-wide instead of all of them — the work-queue shape,
  where N workers share a topic and every task is handled once, and the one
  thing a broadcast bus cannot do without the workers coordinating among
  themselves.  Selection rotates a per-topic cursor over the local
  subscribers and the remote nodes claiming the topic, so ten tasks over
  three workers land 4/3/3 rather than "probably roughly even"; a remote
  node counts as one candidate however many subscribers sit behind it,
  because the gossip frame deliberately carries topic names and not
  subscriber counts (#80), which is also the granularity Akka routes at.
  `ClusterRouter` has load-balanced across cluster members since 216db160,
  but only over routees it spawns or looks up — anycast is for a recipient
  set that registers and leaves at runtime and that the publisher never
  names.  An anycast with no candidate, and one that crossed a hop to find
  the far side's subscribers gone, both go to dead letters; the second is
  not re-routed, which would trade the at-most-one-hop guarantee for a race
  against the gossip round about to correct the sender.  **BREAKING:** the
  third constructor slot used to be `sendOneMessageToEachGroup`, Akka's
  per-consumer-group anycast flag, which nothing ever read because this
  mediator has no groups for it to range over — `new Publish(topic, message,
  true)` broadcast to every subscriber, exactly as `false` did.  Migrate by
  **dropping the argument**: `new Publish(topic, message)` keeps the
  behaviour both values actually had.  Do **not** rewrite `true` to
  `'one-subscriber'` — the old flag was a no-op and the new value is not, so
  the swap silently turns a fan-out to every subscriber into a delivery to
  exactly one.  Reach for `'one-subscriber'` only where anycast is what you
  want.
- **Live and cursor-paginated persistence-id queries** (#156).
  `PersistenceQuery` gains `allPersistenceIds()` — a live stream of every
  persistence id the journal has seen plus each new one as it first appears,
  the fan-out primitive for starting a per-entity consumer as its entity
  shows up — and `currentPersistenceIdsPaginated()`, which walks the same
  ids a page at a time (`pageSize`, default 256; `afterPersistenceId` to
  resume) instead of materialising all of them into one array.  The cursor
  is a persistence id rather than an opaque token, so a checkpoint stays
  readable and reconstructible.  Paging is pushed into the backend wherever
  a sorted key over ids exists — `ORDER BY … LIMIT` on SQLite and on all six
  relational backends via `SqlDialect.rowLimit`, a clustering-column range
  over the `all_persistence_ids` partition on Cassandra — through a new
  **optional** `Journal.persistenceIdsPaginated`, which no journal
  implementer has to add; MongoDB (`distinct` has no cursor) and DynamoDB (a
  `Scan` has no order across partition keys) have no such index and fall
  back to an in-process page.  **BREAKING:** the two query methods are
  required on `PersistenceQuery`, so an out-of-tree `implements
  PersistenceQuery` must add them — extend `InMemoryQuery` to inherit both,
  or implement them over `Journal.persistenceIdsPaginated` and the exported
  `persistenceIdPage` helper.  `currentPersistenceIds()` is unchanged and
  deliberately not deprecated: a small journal is a permanent case, not a
  legacy one.

- **gRPC client-streaming as its own call mode** (#5).  `GrpcClientCommand`
  gains `clientStreamStart` / `clientStreamSend` / `clientStreamClose`, and
  `GrpcHandler` a fourth `clientStream` kind carrying a
  `GrpcClientStreamCall` (consume the request stream via `onData`, answer
  once via `respond` / `respondError`) — so all four gRPC call classes are
  now genuinely covered, which the documentation had already claimed in both
  languages while the mode was simply absent.  The handshake deliberately
  does **not** copy bidi's: `clientStreamStart` answers with a new
  `stream-started` inbound frame carrying a `GrpcStreamHandle` whose `token`
  is 64 bits of crypto-grade randomness, so the registry lookup is itself
  the ownership check rather than a guessable sequential id — bidi keeps its
  in-band `{ __streamId }` handshake until #788 migrates it onto the same
  seam.  **BREAKING:** `GrpcInbound` gains `stream-started`, so an
  exhaustive `match` over it needs one more arm.
- **Request-stream chunks are no longer lost before the handler subscribes**
  (#5).  `handler.target.tell(call)` only enqueues, so a `clientStream` or
  `bidi` handler cannot have called `onData` by the time grpc-js starts
  pushing — the opening chunks were silently dropped, which for a
  client-streaming call is the entire request.  Both modes now hold what
  arrives early and replay it on the first subscribe.
- **`buildGrpcMethodImplementation` exported from `src/io/broker`** (#5).
  The server's method-implementation builder is now a free function over a
  handler descriptor, the same seam `grpcHealthCheckImplementation` already
  uses, so all four call shapes are exercisable without `@grpc/grpc-js`, a
  bound socket or an actor system; its four arms dispatch through
  `match(...).exhaustive()`, so a fifth call class cannot be added without
  handling it.
- **Avro and Protobuf serializers** (#73).  `AvroSerializer` and
  `ProtobufSerializer` take a compiled schema you bring — an `avsc` type, a
  `protobufjs` reflection type, a JSON descriptor, or generated static code
  from pbjs / ts-proto — so neither library becomes a dependency of
  actor-ts, the same call `zodCodec` makes with `ParserLike`.  They own the
  parts that are easy to get wrong by hand: the `Buffer` coercion `avsc`
  needs on the read path (a plain `Uint8Array`, which is what base64 framing
  yields, throws deep inside its decoder on every runtime), detaching
  protobufjs's pooled writer output before it reaches a journal row, running
  `verify()` before encoding, converting a decoded `Message` to a plain
  object with defaults filled in, and refusing a payload written under a
  different manifest — which is the only guard, since Avro carries no field
  tags and Protobuf no message name.  Wire ids below 100 are rejected at
  construction.  Round-trip and byte hygiene are verified on Bun, Node and
  Deno.
- **`serializerCodec(serializer)`** (#73).  Adapts any byte-native
  `Serializer` into a migration `Codec`, so a `SchemaRegistry` can hold a
  different wire format per `(manifest, version)` — a v1 already on disk in
  Avro and a v2 written in Protobuf coexist in one stream, which a
  store-wide `withSerializer(...)` cannot express.  The bytes ride the
  journal's existing tagged-JSON framing instead of a second base64 layer,
  and the `serializerId` travels with the row so reading it back with the
  wrong serializer is a named error rather than silent nonsense.
- **Stable-observation cluster bootstrap** (#148).  `StableObservation` in
  `src/cluster/bootstrap/` polls a `SeedProvider` until the contact-point
  set has been unchanged for `stableMarginMs`, then elects the
  lowest-addressed node as the initial seed and returns both the seed list
  and the `selfElection` policy to hand to `Cluster.join`; a failed lookup
  counts as *no* observation rather than an empty set, and a set that never
  settles throws a `StableObservationError` instead of joining anyway.  Opt
  in with `ClusterBootstrapOptions.withStableObservation(...)`, tune it
  under `actor-ts.cluster.bootstrap.*`.  It closes the cold-start split
  brain (each node forming a cluster out of the subset discovery happened to
  show it) and the symmetric-seed-list deadlock, where every node listing
  every node left no node with the empty seed list ordinary self-election
  requires, so no member ever reached `up`.
- **`ClusterOptions.selfElection`** (#148).  Decides whether — and when — a
  node may declare itself the first member of a new cluster: `'immediate'`
  (the unchanged default, self-elect only on an empty seed list), `'never'`,
  or a millisecond grace after which it self-elects if no peer has promoted
  it.  The grace is what makes an address-ordered election safe against a
  cluster that is already running: the elected node dials its seeds like
  everybody else and forms a cluster only if that produced nothing, so a
  scaled-up pod whose address happens to sort first joins instead of
  splitting.
- **`CLUSTER_HOST` environment variable** (#944).  `bootstrapCluster` reads
  it ahead of `POD_IP` / `HOSTNAME` as the host a node advertises, and the
  stable-observation phase refuses a wildcard advertised host outright — an
  election ordered on `0.0.0.0` puts every node first, so every node would
  believe it won.

- **gRPC health checking** (#4).  `GrpcServerActor` can now host the
  standard `grpc.health.v1.Health` service alongside your own, so
  `grpc_health_probe`, the Kubernetes gRPC probe and gRPC load balancers can
  ask a node whether it is ready.  Enable it with
  `GrpcServerOptions.create().withHealth(registry)`, handing it the same
  `HealthCheckRegistry` that feeds the management server's `/ready` endpoint
  — `Check` answers `SERVING` only while every readiness check passes, is
  re-evaluated per call, and returns `NOT_FOUND` for an unknown service
  name; `Watch` stays `UNIMPLEMENTED`, the documented signal for clients to
  poll `Check`.  There is deliberately no boolean toggle and no HOCON leaf:
  a health service that answers `SERVING` unconditionally would keep a pod
  in rotation straight through an outage, so switching it on requires naming
  where the status comes from.  No new peer dependency — the service
  definition is generated through the `@grpc/proto-loader` the actor already
  requires.  Server reflection, the other half of #4, is not included and
  the issue stays open for it.
- **`smallest-mailbox` for the cluster router** (#69).  `ClusterRouter`
  gains the load-aware strategy the local `Router` already had: each message
  goes to the node whose routee last reported the shortest queue.  Routees
  are ordinary user actors that cannot be made to answer a framework
  question, so a responder on the fixed envelope path
  `/cluster/mailbox-depth-agent` answers for them — and because the routing
  path is synchronous, the readings are cached and refreshed on a background
  tick rather than asked for per message, which keeps the decision as cheap
  as round-robin's modulo.  A node with no usable reading is skipped rather
  than assumed idle, and a cold or fully expired cache degrades to
  round-robin order instead of dropping anything.  Tune it with
  `mailboxDepthRefreshMs` (default 200 ms) and `mailboxDepthStaleAfterMs`
  (default 1000 ms, `0` disables the expiry); a window shorter than the
  refresh that refills it is rejected at construction.  A router serves
  depths on its own node, so a single node and the homogeneous deployment
  need nothing extra — nodes that host routees but no router call
  `ClusterMailboxDepthAgent.serve(cluster)`.

- **Smallest-mailbox router** (#154).  `Router.smallestMailbox(size, routee,
  routeeOptions?)` and the exported `smallestMailboxStrategy()` send each
  message to the routee with the shortest queue, so one expensive message no
  longer parks the next 1-in-N arrivals behind it — the load-balancing
  round-robin structurally cannot do.  Ties rotate, which makes an idle pool
  behave exactly like round-robin and makes a saturated one spread its
  overflow evenly instead of piling onto a single routee; the scan stops at
  the first empty mailbox, so a pool that is keeping up costs one depth read
  per message regardless of its size.  A routee that has stopped is skipped
  rather than chosen: a terminated cell dead-letters instead of enqueueing,
  so its depth would otherwise read `0` forever and make the dead routee the
  permanently emptiest one in the pool.  A routee whose depth cannot be read
  — one that is not locally hosted — is weighed as empty instead of being
  passed over, so a mixed pool cannot starve it.  Local only in the sense
  that matters: mailbox depth is in-process state, and it stays internal to
  the runtime rather than becoming a public `ActorRef.mailboxSize`.

- **Death watch with a custom termination message** (#159).
  `context.watchWith(ref, message)` — and its `TypedActorContext`
  counterpart — registers a death watch that delivers a message of the
  watcher's own protocol instead of `Terminated(ref)`, so an actor that
  watches several kinds of actor no longer has to carry the signal in its
  message union and tell the deaths apart by ref identity.  Last call wins
  over a previous `watch`/`watchWith` of the same ref, `unwatch` removes
  either, and the registration is keyed by incarnation — a re-spawned name
  is a fresh subject that needs its own call.

- **Typed `Behaviors.intercept` / `monitor` / `logMessages`** (#152).  Three
  combinators for the concerns that cut across an actor's own logic: a
  generic interceptor that observes, transforms, drops or short-circuits
  every message before the wrapped behavior sees it; a tap that forwards
  each message to another actor (a probe, an audit trail) first, swallowing
  that delivery's failures; and per-message logging at `debug` or `info`
  with an optional formatter.  Unlike the other decorators an interceptor is
  not resolved away at startup — it stays wrapped around whatever the inner
  behavior becomes, so a behavior that returns a fresh `Behaviors.receive`
  on every message is still intercepted on the next one.

- **`acquireLock(cache, key, ttlMs)` — mutual exclusion over any `Cache`
  backend** (#141).  Exported from the package root.  It writes a random
  128-bit token and releases only while that token is still in place, so a
  holder that overran its TTL cannot evict its successor mid-critical-section;
  `release()` returning `false` reports exactly that overrun.  `ttlMs` is
  required — expiry is the only recovery path from a crashed holder.

- **The `Cache.setIfAbsent` atomicity contract is written down** (#141).  It
  was previously unstated: a hard per-key guarantee on every backend (Redis
  `SET … NX`, Memcached `ADD`, and a `Map` read/write pair the single-threaded
  event loop cannot interleave), the rule that `ttlMs` applies only to the
  write that wins, and the limit that matters — the scope is one key on one
  server, so a Memcached topology change can rehash a key onto a node that has
  never seen it and hand the same lock out twice.

- **`LogContext.runFresh(fn)` and `LogContext.runEach(entries, fn)`** (#129).
  MDC primitives for work that outlives the turn that started it.
  `AsyncLocalStorage` binds a store when an async resource is *created*, not
  when it runs, so an un-awaited promise, a later-flushed buffer or a batched
  queue drain keeps whatever context was ambient at creation time and stamps it
  onto every `tell` its continuation makes; across a tenant boundary that is a
  data leak rather than a confusing log line.  `runFresh` runs with the context
  emptied — for deferred work that belongs to nobody.  `runEach` runs each
  entry sequentially under the context captured when that entry was enqueued,
  ignoring the context ambient at drain time — for batches that mix principals.

- **Logging docs cover deferred work, tenant isolation and
  `LogContext.snapshot()`** (#129).  `snapshot()` was missing from the
  operations table despite being the only safe way to carry a context across a
  boundary — `get()` returns the live readonly reference for the whole scope,
  `snapshot()` copies afresh on every call.  The same page carried an inverted
  warning claiming raw `setTimeout` loses the MDC while `context.timers`
  preserves it; both halves were wrong — both paths propagate — and the
  corrected text names the real failure mode.

- **DevTools overview: an `actor-ts` tile in the Common section** (#911).
  The running framework version now sits beside the actor system's name —
  together they are the identity of what you are looking at — instead of
  living only in the connection badge's tooltip.  It is the first thing a
  bug report quotes, and a tooltip does not survive the screenshot people
  actually paste.  Hovering the tile still gives the tap protocol
  version.  Read from the existing `welcome.serverVersion`, so no
  protocol change.

- **`BidirectionalMap<K, V>`** (#1035).  A `Map` that also answers
  `value → key`.  It exists because a reverse index written by hand is two
  maps that have to be updated in lockstep, and the failure mode when they
  drift is silent: a stale entry keeps answering for a pair that is already
  gone.  Values back the reverse map, so they are unique and the relation is
  1:1 in both directions.  `set` binds the pair unconditionally, evicting
  whatever held either side before — the one departure from the `Map`
  contract it implements, deliberate so the type stays usable wherever a
  `Map` is expected, with `trySet` for callers that want the collision
  reported instead of absorbed.  Both directions compare by SameValueZero, so
  `NaN` works as a key and a value and two structurally equal objects are two
  different values.  `inverse()` is a view over the same storage rather than
  a copy.

- **`BidirectionalMap` round-trips through every store** (#1035).  It is the
  first framework class the tagged JSON tree knows about, under
  `__bidirectionalmap__` alongside `__map__` and `__set__`, so it can be held
  in an actor's state directly — no snapshot adapter, no serializer
  registration, nothing at the boundary.  Only the forward pairs are written;
  the inverse is rebuilt on decode, which also means a row carrying a
  duplicate value resolves last-wins rather than restoring a map whose halves
  disagree.  A store configured with `withSerializer(new CborSerializer())`
  is the exception — that codec does not carry `Map` or `Set` either
  (tracked as #1036).

- **`BidirectionalMultiMap<L, R>`** (#1037).  The many-to-many sibling of
  `BidirectionalMap`, for the shape a subscription registry has: one
  subscriber holds many topics, one topic has many subscribers, and the
  message telling you a subscriber is gone carries only the subscriber.
  Written by hand that is two maps of sets, re-derived at every site, where
  dropping a participant means reaching into every set it appears in.  The
  invariant it adds over the 1:1 version is that **there is no such thing as
  an empty participant** — losing your last partner removes you from both
  directions.  That is where the leak lives in a many-to-many relation: a
  topic left holding an empty subscriber set is invisible to a pair count,
  keeps occupying whatever cap bounds the topics, and would let `inverse()`
  hand back something related to nothing.  `size` counts pairs rather than
  participants, since that is what a cap is usually written against.
  Equality is SameValueZero, as with the sibling.  Two deliberate
  departures from it, both documented on the class: `get()` returns the
  **live** internal set typed `ReadonlySet`, not a copy, because the
  relation is read on fan-out paths once per published message where an
  O(n) copy is not payable — so casting it back to `Set` and mutating it
  corrupts the inverse; and it does not implement `Map`, which it could not
  honour anyway since `get` returns a set.

- **`BidirectionalMultiMap` round-trips through every store** (#1037).  The
  second framework class the tagged JSON tree knows, under
  `__bidirectionalmultimap__`, so a many-to-many relation can be held in an
  actor's state with no adapter and no registration.  It needs the tag more
  than its sibling did: a `BidirectionalMap` falling through to the plain
  object encoder would at least come back with its data intact and only its
  class gone, where this one holds both directions as `Map<_, Set<_>>`
  behind private fields the walker never reaches — the row would be a pair
  count and no pairs.  Written as a forward adjacency list rather than a
  flat pair list, because one participant with many partners is the shape
  every call site has; the inverse is rebuilt on decode, so the two halves
  cannot be restored disagreeing.  The `CborSerializer` exception applies
  here too (#1036).

### Fixed

- **`BrokerActor` now actually prunes a subscriber that stops** (#1111).
  `subscribeRef` death-watched the ref and its documentation — the class
  JSDoc and `docs/io/broker-actor-base` alike — promised the subscription
  was removed automatically when it stopped.  Nothing implemented it.
  `Actor.onReceive` is abstract, so the base class never sees a message,
  and the reverse index commented "for O(1) cleanup on Terminated" had no
  reader on that path at all; a stopped subscriber stayed in every topic it
  held and cost a dead-lettered `tell` on each fan-out.  Sealing
  `onReceive` in the base class would have taken the dispatch table away
  from all thirteen subclasses for the sake of one hook, so the seam is
  explicit: **subclasses call `pruneTerminatedSubscriber(ref)` from their
  `Terminated` arm**, as the corrected docs now show.  It deliberately does
  not `unwatch` — the cell has already dropped the watch by the time it
  delivers `Terminated`.  The index is also keyed by path now rather than
  by ref object, which is what makes it work on that path at all: a
  `Terminated` carries the cell's own `self` ref, which need not be the
  object that subscribed.  `postStop` clears the ref sidecar too, which the
  old pair left behind.

- **SQLite persistence now sets an explicit `busy_timeout` on every
  connection it opens** (#124).  Until now no `busy_timeout` was set
  anywhere in the tree, so the value in force was whatever the driver
  happened to default to — and the drivers disagree: measured, `bun:sqlite`
  0, `node:sqlite` 0, `better-sqlite3` 5000.  The identical journal
  therefore failed a contended write on the first tick under Bun and Deno
  but blocked for five seconds under Node, which makes this a break of the
  project's identical-behaviour-on-Bun/Node/Deno promise rather than merely
  an unset knob.  Every handle now gets 1000 ms by default, settable per
  store through `busyTimeoutMs` (`0` disables the wait, a negative value is
  rejected because SQLite reads it as "retry forever"); the default stays
  well below the failure detector's 2000 ms unreachable threshold on
  purpose, because `SqliteDriver` is synchronous and the whole wait is
  event-loop freeze — inheriting `better-sqlite3`'s 5000 would let one
  contended write stall a node long enough for its own cluster to evict it.
  `SqliteJournal.append` additionally takes its write lock up front (`BEGIN
  IMMEDIATE`) instead of using the driver's deferred `transaction()` helper,
  because a transaction that reads before it writes makes SQLite return
  `SQLITE_BUSY` without ever consulting the busy handler — measured at 1 ms
  to failure with an 800 ms timeout configured, against 956 ms for the same
  statements under `BEGIN IMMEDIATE`.
- **`DEFAULT_SQLITE_BUSY_TIMEOUT_MS` and `buildSqliteDatabase` are exported
  from the package root** (#124).  The root barrel is the only published
  entry point, so both were previously reachable only through the internal
  `src/persistence/index.ts` — which left the new default unobservable from
  outside the package and made the documented "share ONE handle across
  stores" route unusable.

- **HOCON `include` now refuses itself with an explanation instead of a
  syntax error** (#135).  `include "base.conf"` reported `Expected '=' or
  ':' after key "include"`, which names the keyword but not the reason and
  left the reader to discover from the parser source that the omission was
  deliberate.  The parser now states that the directive is refused, quotes
  line, column and the include target, and points at the composition that
  does work — `Config.parseFile(base).merge(Config.parseFile(app))`.  All
  forms are covered (`"…"`, `file(`, `url(`, `classpath(`, `required(`), at
  any nesting depth, while a key legitimately named `include` — `app {
  include = "x" }`, `include { a = 1 }`, `include.a = 1` — keeps parsing
  untouched.
- **The configuration reference no longer documents `include` as a working
  feature** (#135).  `reference/configuration.mdx` advertised HOCON "with …
  includes" and carried an active "Includes" section describing the
  directive as supported, and `extras/design-decisions.mdx` listed "File
  includes" among the reasons to prefer HOCON over YAML/TOML — so following
  our own reference led straight into the parse error.  Both pages now state
  the refusal and its rationale and show the in-code merge instead (EN +
  DE).

- **A `PersistentFSM` state timeout could fire after a transition had already
  renewed it** (#143).  A `_timeout` fire travels through the mailbox, so it
  becomes irrevocable the moment the timer callback enqueues it — `cancel()`
  can no longer reach it, and the FSM may process any number of commands
  before it is dequeued.  `fireTimeoutTransition` compared only the state
  name, which cannot express "this window was replaced": a heartbeat command
  transitioning `active → active` — the archetypal idle-session timeout —
  re-armed the timer, and the queued fire still expired the session.  A fire
  now carries the arm generation it was scheduled under and is dropped once a
  re-arm has superseded it; the state-name check remains as a second layer.

- **A fully compacted journal no longer blocks every later `persist`**
  (#628).  Recovery raised its sequence only from a snapshot or from
  replayed events, so an actor whose journal had been compacted past
  everything recovered at 0.  That used to be harmless, because the journal
  said 0 too — but since #379 the backends remember what they deleted, so
  `highestSeq` correctly reports N while recovery reported 0, and the next
  `persist` sent `expectedSeq=0` into a journal that had seen N.  The result
  was a `JournalConcurrencyError` on every attempt, permanently, with no way
  out short of editing the store.  Recovery now falls back to the journal's
  high-water mark when there was nothing to replay — one extra query only in
  that case, and a no-op for a brand-new actor.

- **`deleteHistory(toSeq)` keeps the snapshot it compacts past** (#629).
  `SnapshotStore.delete` is documented as inclusive, so compacting past a
  snapshot deleted that snapshot along with the events it replaced — leaving
  an actor with neither.  It now prunes snapshots strictly before `toSeq`,
  and `toSeq <= 0` prunes nothing.  This is the first test the method has
  ever had; it had no caller in the repo either.

- **A terminated `ActorSystem` no longer keeps the process alive** (#641,
  #762).  `Scheduler.shutdown()` set a flag, which suppresses the scheduled
  callbacks but leaves the underlying `setTimeout` / `setInterval` handles
  armed — and an armed interval holds the event loop open.  A flag could
  never have fixed it: each handle lives inside the closure that created it.
  Schedules now register with the scheduler, so `shutdown()` has something to
  clear.

- **A fired one-shot timer reports itself finished** (#642).  `Cancellable`
  only flipped its flag on an explicit `cancel()`, so a timer that simply ran
  claimed to be pending for the rest of the process: `isCancelled` stayed
  false, `cancel()` returned `true` for a schedule that had already fired,
  and `context.timers` listed dead keys as active while its map grew by one
  entry per key for an actor that cycles through them.  A repeating schedule
  still ends only when cancelled.

- **`CoordinatedShutdown.removeProcessHooks()` removes only its own
  listeners** (#644, #764).  It called `process.removeAllListeners(signal)` —
  every SIGTERM/SIGINT listener in the process, including the application's
  own graceful shutdown, other libraries', and a second `ActorSystem`'s.
  `installProcessHooks` recorded only the signal name, so the handler it had
  just installed was unreachable; the pair is now kept and removed with
  `process.off`.

- **A stopping actor releases its event-stream subscriptions** (#645, #763).
  `unsubscribe` had one caller in the entire framework, so the subscriber
  list only grew — every publish walked entries for long-gone actors and
  turned each into a dead letter.  `publish` also iterated the live array
  while a synchronous `tell` could mutate it; it now iterates a snapshot, so
  the recipient set is fixed when `publish` is called.  The docs' advice to
  "rely on the dead-letter cleanup" described something that never existed,
  and is corrected in both languages.

- **A Deno node can join an mTLS cluster** (#576).  `Deno.connectTls` accepts
  a client `key`/`cert` pair, but `DenoTcpBackend.connect` never passed them —
  so a Deno node could not answer a listener that (correctly, since #565)
  demands a certificate, and could not join at all.  The same call passed the
  SNI override as `hostname_`, which is not a Deno option; the adapter's
  hand-written `DenoGlobal` interface declared the typo, so the compiler could
  not see it and the value was silently dropped.  Deno takes the SNI name from
  `hostname`.

  Hosting an mTLS *listener* on Deno remains impossible — `Deno.listenTls`
  takes only a cert and key, with no way to request or verify a peer
  certificate — and is still refused at bind time rather than started in a
  state weaker than it reads as.  The error now says which half is
  unavailable.  `rejectUnauthorized` has no Deno equivalent and is documented
  as unmapped rather than silently ignored.

- **The DevTools handshake reported the wrong framework version** (#657).
  `DEVTOOLS_SERVER_VERSION` is hand-maintained and had said `0.11.0`
  since that release, so every DevTools session misreported the version
  through `0.12.0` and `0.13.0` — in the one field you trust when
  triaging.  It is now correct, and a test asserts it against
  `package.json`, so a release that forgets the bump fails the suite
  instead of shipping the lie.

### Security

- **CIDR matching only accepts canonical IPv4 addresses** (#145, #312).
  `ipv4ToBigInt` parsed every octet with `Number()`, which understands far
  more than a dotted quad — `Number('1e1')`, `Number('010')` and
  `Number('0x0a')` are all `10` — so `1e1.0.0.1`, `010.0.0.1`, `0x0a.0.0.1`,
  `0xa.0.0.1` and `10.0.0.0x1` all matched `10.0.0.0/8`.  That is a bypass
  rather than a cosmetic flaw because `net.isIP` scores each of them `0`:
  the transport hands the same string to `net.connect({ host, port })`,
  which resolves it through DNS, so a `pinnedAddresses` check that concluded
  "inside the pinned network" produced a connection to wherever the
  attacker's resolver pointed.  The same primitive backs the HTTP
  `IpAllowlist`, which carried the identical bypass since #312 — a spoofed
  `X-Forwarded-For: 1e1.0.0.1` walked through a `10.0.0.0/8` allowlist via
  the extractor its own JSDoc recommends.  Octets are now decimal-canonical
  only (no leading zero, no `0x`, no exponent, no sign, no whitespace), and
  `ipv6ToBigInt` was audited and does not share the weakness.
  **Migration:** a pin or allow entry written non-canonically
  (`'010.0.0.0/8'`) now throws at construction instead of silently pinning a
  different network — rewrite it in canonical form.
- **Prefix lengths are decimal-only, so a trailing-slash typo no longer
  means `/0`** (#145).  `parseCidr` read the prefix with `Number()` too, and
  `Number('')` is `0`, so `'10.0.0.0/'` parsed as `/0` — a pin meant to
  admit a single network admitting the entire address space instead.
  `'/0x8'`, `'/8e0'`, `'/ 8'`, `'/+8'` and `'/010'` were accepted just as
  loosely; all of them now throw `invalid prefix length`.
- **An all-numeric host-suffix pin is rejected** (#145).  Suffix matching is
  string comparison, so an entry like `'0.1'` matched the tail of any
  address ending `.0.1`.  No DNS zone is all digits; write a CIDR instead.
  This closes the path by which a non-canonical address — now classified as
  a hostname rather than an IP — could otherwise have reached the suffix
  pins.

- **Every gossiped record is held to the merge-path caps, not just the first**
  (#114, #138).  The version cap was split in two — tight where a record
  *introduces* an address, 24 h where it updates one — and both halves were
  reachable with the same move, because "already on the list" is a property of a
  map the attacker can write to first: two records for one address inside a
  single frame (`mergeMember` re-reads the map per record), or a frame carrying
  no member records at all, whose sender fallback enters the address itself.
  Either one then pushed through attacker-chosen roles and a version dated 23 h
  ahead, which the address's real owner could no longer outbid.  There is now one
  cap, `maxVersionSkewMs`, for every gossiped member version; the flat 24 h
  remains only for the two fields that are timestamps rather than versions,
  `removedAt` and the heartbeat `ts`.  `maxMembers` / `maxTombstones` are
  likewise charged to the bucket a record moves *into* rather than only when an
  entry is created: a tombstone reborn as `up` otherwise cleared the tombstone
  bucket without giving back a map slot, and alternating that with a fresh
  tombstone flood grew the member map without bound while every single step
  honoured both caps — measured at 6, 11, 16, 21, 26, 31 entries against a
  ceiling of 11.  The mirror direction (a live member gossiped as `removed`)
  pumped the tombstone bucket the same way and is closed with it.

- **A refused gossip record is reported once per frame, not once per record**
  (#114, #138).  The version guard and the `removedAt` guard each wrote a WARN
  line per record — precisely the log amplification the memory caps were meant to
  remove, reachable by anyone able to send one large frame.

- **BREAKING: `persistenceId` is validated before it becomes a storage key**
  (#133).  The new `PersistenceIdValidator` rejects an empty id, one longer
  than 255 characters, a `/` or `\` path separator, a whole-id `.` / `..`,
  and control characters — the rules `assertValidName` (#134) already
  applies to actor names, mirrored onto the one identifier in the
  persistence layer that had no validator at all.  It runs in
  `PersistentActor.preStart` and `ReplicatedEventSourcedActor.preStart`
  (both ahead of any journal access), in the new
  `DurableStateOptionsValidator` where a violation is an `OptionsError` on
  the `persistenceId` field, and again in the `append` of all six journals
  as defence in depth.  Banning the separators also closes an object-storage
  collision: the stores lay an id out as a directory
  (`<prefix><persistenceId>/<seq>.json`) and read it back by listing that
  prefix, so `a/b` nested inside `a` — `a`'s `loadLatest` returned `a/b`'s
  snapshot and its `delete` pruned it.  Commas and `|` stay legal on
  purpose: the comma-separated journal column carries tags rather than ids,
  and the projection offset store puts the id last in
  `<projection>|seq|<persistenceId>`, which is what keeps the chat example's
  `dm-channel-alice|bob` working.  Migration: read paths are deliberately
  not validated, so `journal.read(oldId, 1)` still returns data stored under
  a now-invalid id and it can be copied to a corrected one; check your ids
  ahead of the upgrade with the newly exported `assertValidPersistenceId`.

- **Replay refuses a journal that breaks its read contract** (#122).
  `replayState` folded whatever `journal.read()` returned and took
  `sequenceNr` from the last entry *delivered*, so a shuffled stream
  replayed history in an order it never happened in — non-commutative events
  landing the wrong way round — and left recovery one sequence short, after
  which every `persist` failed with a `JournalConcurrencyError` pointing at
  a perfectly healthy journal, one restart away from its cause.  The
  returned slice is now checked before the fold, so a rejected stream never
  reaches user code: sequence numbers must be safe integers ≥ 1, strictly
  ascending, contiguous and inside the requested window, otherwise
  `JournalIntegrityError`.  The ordering half has no in-tree trigger — all
  eight journals sort, Cassandra explicitly — and defends the plugin
  contract against third-party journals and store manipulation; the
  contiguity half does fire on shipped code, through
  `CassandraJournal.append`'s claim-then-write window.  DevTools time travel
  opts out of the compacted-prefix part, so the panel still opens on
  entities whose history was compacted.
- **BREAKING — recovery over a journal compacted without a covering snapshot
  now fails instead of inventing a state** (#122).  It previously folded the
  surviving tail onto `initialState()` and handed that to `onCommand` as the
  current state.  Reachable through the public API, not just through
  tampering: `deleteHistory(n)` on an actor that never snapshotted.
  Migration: compact only past a snapshot — `deleteHistory(seq)` keeps the
  snapshot at `seq` for exactly this reason — or take one before compacting.
- **Seed providers can pin the addresses they accept** (#145).
  `DnsSeedProvider` and `KubernetesApiSeedProvider` gained `pinnedAddresses`
  plus a `log` callback that reports every drop, so a spoofed DNS answer or
  a written-to `Endpoints` object can no longer steer the bootstrap at an
  arbitrary peer.  Entries are CIDRs for resolved IPs and host suffixes —
  matched on a label boundary, so `svc.cluster.local` never admits
  `evilsvc.cluster.local` — for the target hostnames SRV records carry; a
  list that cannot match anything in the configured mode is rejected at
  construction rather than silently discarding every seed, and non-matching
  addresses are filtered and logged rather than failing the whole lookup.
  This is defence in depth behind mTLS (#565, #912) and the only
  discovery-layer control left standing where mTLS is not configured.
- **CIDR matching moved to `util/CidrMatch`** (#145).  Extracted verbatim
  from the `IpAllowlist` HTTP middleware (#312) so the cluster bootstrap and
  the HTTP edge share one IPv4/IPv6 implementation instead of growing a
  second hand-rolled parser that drifts; `IpAllowlist` behaviour and error
  messages are byte-identical and its test file is unchanged.

- **AES-GCM IVs are generated inside the encrypt call** (#110).
  `aesGcmEncryptSafe(subkey, plaintext)` derives a fresh IV per call and
  returns it beside the ciphertext, so the object-storage body codec no
  longer holds an IV it could recycle; the IV-taking `aesGcmEncrypt` and
  `randomIv` remain for that wrapper and the decrypt-side tests but are
  marked `@internal`.  No IV was ever actually reused — `aesGcmEncrypt` is
  re-exported from no `index.ts` and the package `exports` map has no
  wildcard subpath, so this was in-tree misuse potential rather than
  anything a consumer could reach — but nothing asserted IV freshness
  either, and regression tests now do at both the primitive and the manifest
  layer.
- **`X-Content-Type-Options: nosniff` on every response** (#127).  All three
  HTTP backends now write the header before a response's own headers — an
  explicit header from a handler still wins — so it also reaches what no
  middleware ever sees: the backend's own error mapping, the `fallback()`
  404 and the body-too-large 413.  Static files get it too; until now only
  the directory listing sent it while the served file right beside it did
  not, which is exactly the upload-echo case the header exists for.  **The
  response headers of every endpoint change**;
  `newServerAt(…).withSecurityHeaders(false)` opts out.
- **`newServerAt(…).withSecurityHeaders(…)` applies the security-header
  bundle server-wide** (#127).  Passing `SecurityHeadersOptions` (or a plain
  object) stamps the full `securityHeaders()` set — its own defaults
  included — at the backend chokepoint instead of as a middleware, which is
  the only way to cover the error, not-found and upgrade-reject paths;
  `false` disables the mechanism.  Only `nosniff` is on without
  configuration: `X-Frame-Options` and `Cross-Origin-Resource-Policy` would
  break iframes, cross-origin embedding and OAuth popups, so they stay
  opt-in.
- **A ClusterClient no longer learns why an ask failed inside the cluster**
  (#130).  A ClusterClient is not a peer — it never joined the membership
  ring, carries no gossip or heartbeat duty, and a contact point is by
  design reachable from outside whatever boundary protects the cluster's own
  links — so the receptionist stopped forwarding the rejection text, which
  is authored by arbitrary actor code and routinely carries file paths, SQL
  fragments, driver internals or a stack.  The client gets a fixed sentence
  plus a correlation id drawn on the node, and the full text is logged there
  under that id at `warn`, so an outside caller quotes the id and an
  operator greps for it.  The unknown-path reply also drops the node's own
  `selfAddress`, which behind a load balancer or NAT is not the address the
  client dialled.  **BREAKING:** `ClusterClient.ask()` rejects with the
  generic message; model a failure a client must act on as a reply the actor
  authors (`{ kind: 'rejected', reason: 'out-of-stock' }`), which is still
  passed through untouched.
- **An HTTP throw that becomes a redacted 500 is now logged where operators
  actually look** (#130).  Redaction only works if the detail survives on
  the server, and it did not: the escaped-throw branch logged `err.message`
  at `debug`, a level nothing runs at in production, so the generic 500 was
  the sole trace of the failure anywhere.  It now logs at `error` and passes
  the error *value* through so a sink that formats stacks still gets one,
  excludes a deliberate `HttpError` such as a 404 (a response the handler
  chose does not belong in the error log), and covers `fallback()`, which
  maps to a 500 without re-throwing.  The line carries the caller's
  `x-request-id` when it is well-formed, read through the newly exported
  `requestIdOf(request)` — the same shape check the `requestId` middleware
  applies, which is what stops a client-controlled string from forging a log
  record through an embedded newline.
- **DistributedData bounds its pending quorum requests** (#140).
  `updateAsync` / `getAsync` now share a `maxPendingQuorumRequests` budget
  (default `1000`, `0` disables) and a `maxQuorumTimeout` ceiling on the
  caller-supplied `timeoutMs` (default `30s`, `0` disables); a request past
  the cap is rejected outright instead of tracked, and an oversized deadline
  is clamped.  The default is deliberately an order of magnitude below the
  replicator's mailbox (10 000, `drop-head`): at mailbox saturation the
  oldest queued envelope is discarded together with the caller's
  `resolve`/`reject`, so the `updateAsync` promise never settles and nothing
  is logged — a cap set at 10 000 would never fire first and would convert
  nothing, while a cap of 1000 turns that silent drop into an explicit
  rejection naming the knob.  Four bounded-cardinality metrics come with it:
  `distributed_data_quorum_pending`,
  `distributed_data_quorum_timeouts_total`,
  `distributed_data_quorum_rejected_total` and
  `distributed_data_dropped_values_total`.

- **Ambiguous master-key rings are now rejected** (#111).  A `MasterKeyRing`
  whose `active` and `retired` entries claimed the same version was accepted
  and then resolved silently in favour of `active` — bodies written under
  the older of the two keys decrypted with the newer one and failed on the
  AES-GCM authentication tag with an error that named nothing.
  `validateMasterKeyRing` refuses duplicate versions, versions outside `[0,
  255]`, and keys that are not 32 bytes, at plugin registration, at the
  store's own encrypt/decrypt entry points, and at the start of
  `reEncryptObjectStorage` (where it replaces a range check that covered
  only `active`).  Reaching this state needed no exotic key history —
  promoting a key without renumbering it is enough — so a deployment
  carrying such a ring today will now fail loudly at startup instead of
  corrupting reads.
- **Warning when the master-key version space runs low** (#111).  From
  active version 240 on, `registerObjectStoragePlugins` warns and points at
  the remedy.  The single manifest byte is not a cap on how often a
  deployment may rotate: it caps how many versions may be live in one corpus
  at once, and a completed re-encryption sweep frees every other number for
  reuse.  The proposed wide-version wire flag was deliberately not reserved
  — bit 4 is `FLAG_INTEGRITY_HMAC` since #116, and the case it would address
  is one the sweep already resolves.
- **Prometheus-Kardinalitaet pro Metrik-Familie gedeckelt** (#131).  A label
  value derived from user-controlled input — a URL path, a header, an id —
  used to mint one time series per distinct value with nothing bounding it,
  growing the exposing process's resident memory (prom-client never expires
  a series) until the Prometheus server OOMed ingesting them.
  `DefaultMetricsRegistry` and the `promClientRegistry` bridge now stop
  minting at `maxSeriesPerFamily` (default 10 000, `0` disables) and fold
  every further tuple into a single overflow series, so a family gains at
  most one extra series no matter how many distinct tuples arrive; the first
  overflow logs one warning naming the family and the rejected tuple.
  Configure it with
  `MetricsRegistryOptions.create().withMaxSeriesPerFamily(n)` passed to
  `MetricsExtension.enable(...)`, or `withMaxSeriesPerFamily(n)` on
  `PromClientAdapterOptions`.  The default is 10 000 rather than a lower
  round number because `actor_mailbox_dropped_total` carries a
  per-actor-path label, so a node hosting a few thousand sharded entities
  under back-pressure legitimately crosses 1 000 series and a tighter cap
  would discard real operating data.  Deployments already producing more
  than 10 000 tuples in one family see those folded into the overflow series
  — raise the cap or bound the label to keep them separate.
- **`bucketize(value, allowed)` exported** (#131).  Maps a
  possibly-unbounded label value onto a fixed allow-list, returning
  `'other'` for anything outside it, so a family can never hold more than
  `allowed.length + 1` series.  This is the fix for a high-cardinality
  label; the registry cap is only the backstop for the labels nobody
  bounded.
- **Cluster membership is capped** (#138).  The local member map grew
  without bound from gossip: both paths that create an entry —
  `mergeMember`'s first-sighting branch and the sender fallback in
  `onGossip` — set unconditionally, and every guard in front of them decides
  whether a claim is *believable*, never how many believable claims one peer
  may make.  Two caps now bound it, `actor-ts.cluster.max-members` (default
  `1000`) and `actor-ts.cluster.max-tombstones` (default `10000`), settable
  in code as `withMaxMembers(…)` / `withMaxTombstones(…)` and disabled with
  `0`.  The tombstone cap is the load-bearing one, which inverts how the
  issue ranked its tracks: a phantom in an active status is reclaimed by the
  failure detector within `down-after`, while a gossiped `removed` record is
  reclaimed by nothing until `tombstone.time-to-live` a day later — so it is
  the only variant that accumulates.  The practical damage arrives well
  before an out-of-memory kill: gossip carries the whole member list, so at
  roughly 110 000 entries a node's own frame outgrows the 16 MiB wire cap
  and every peer terminates the connection on the length prefix.  Tombstones
  a node mints itself (`leave`, a downing decision, `down()`) convert an
  existing entry and bypass the cap, and the failure detector's sample map
  is bounded on the same path so the leak does not simply move one map to
  the left.

- **Membership housekeeping is configurable from HOCON** (#841).
  `weakly-up-after` and `tombstone.{time-to-live, prune-interval,
  min-retention}` under `actor-ts.cluster` were code-only `ClusterOptions`
  fields with no config form at all; a deployment can now move them into
  `application.conf`, where they layer under explicit options as usual.
  `min-retention = 0s` means *derive the floor from
  `failure-detector.down-after`* — the same thing an unset field means — so
  a file that spells the default out behaves like one that omits it, and
  `ClusterOptionsValidator` accepts `0` where it used to reject it.
- **A TLS cluster listener no longer binds in plaintext when only half the
  credential is configured** (#144).  All three TCP adapters decided for
  themselves whether to bind TLS by testing `cert && key`, so a `tls` option
  carrying only one of the two made the listener conclude "no TLS" and bind
  **in the clear** — while the dialing half of the very same options object
  treats any `tls` value as TLS, so the cluster still formed and the node
  still looked TLS-configured.  A half-applied secret rotation or one typo'd
  environment variable was enough.  The rule now sits in
  `assertListenerTlsIsCoherent` beside the existing #565/#576 guards, and
  every adapter reaches it through a new `listenerUsesTls` that welds the
  check to the decision — after this, "plaintext" can only mean "no `tls`
  was supplied at all"; anything else either binds TLS or throws.  Empty
  material counts as absent, since that is what an unset variable or a
  mis-mounted secret looks like on arrival.  The dial path is deliberately
  untouched: `{ ca }` with no client certificate is ordinary one-way TLS and
  `ClusterClient`, which never listens, depends on it.  **Operator note:** a
  node that has been quietly serving plaintext this way now fails at bind
  instead of starting mis-secured, so a rolling restart can take such a node
  down — intended, but check for a half-set `cert`/`key` before rolling.

- **BREAKING — the HKDF `info` parameter is now required for client-side
  encryption** (#108).  `EncryptionConfig.info` was optional and
  `deriveSubkey` substituted the constant `'actor-ts/snapshot/v1'`.  HKDF's
  `info` is its context binding (RFC 5869 §3.2), so a framework-wide
  constant meant any two deployments holding the same master key derived
  byte-for-byte the same subkey for the same `persistenceId` — a staging
  environment restored from a production dump, or a DR region, could read
  production's blobs, and nothing in the config or docs said so.  `info` is
  now mandatory on both `client-aes256-gcm` arms of the exported
  `EncryptionConfig`, and `deriveSubkey` takes it positionally without a
  default.  *Migration:* add `info` to every client-side encryption config,
  encoding environment + purpose + version (`info:
  'acme/prod/snapshot/v1'`); to keep an existing corpus readable without a
  sweep, pass the old default `'actor-ts/snapshot/v1'` verbatim.
- **HKDF context rotation for the re-encryption sweep** (#108).
  `reEncryptObjectStorage` gains `newInfo`: bodies are decrypted under
  `info` and rewritten under `newInfo`, so a deployment can move off a
  shared derivation context without a second tool.  Because the key version
  is stamped in the body manifest but the context is not, the version
  fast-path is disabled while `newInfo` differs from `info` — without that
  the sweep would report every object as `skipped-current` and change
  nothing.  Re-runs stay idempotent: a body that fails to decrypt under
  `info` is retried under `newInfo` and counted as skipped, while failure
  under both re-raises the original decrypt error.
- **Eager rejection of a missing or blank `info` at plugin registration**
  (#108).  `registerObjectStoragePlugins` now validates every reachable
  client-side encryption config — including ones behind `encryptionByPrefix`
  resolvers — and `deriveSubkey` guards at the call itself.  The type
  already covers TypeScript callers; these guard JavaScript consumers, `as
  any` call sites and configs deserialised at runtime, where a missing
  `info` would otherwise be encoded as the literal string `"undefined"` —
  the same deployment-wide constant, only invisible.
- **A first-sight gossip record is held to a tight version-skew cap**
  (#114).  Versions are seeded from `Date.now()`, so "highest version wins"
  also decided what happened the *first* time an address was mentioned at
  all — and a self-announcement is the one claim the authority rules from
  #562 never refuse.  A stranger could therefore claim an address before the
  node that owns it exists, date the claim up to a day ahead and attach
  roles of its choosing; the leader's promotion loop then lifted the phantom
  into the active set, where roles decide routing, sharding placement,
  singleton hosting and downing quorums, and the real node's own record —
  versioned from its own clock, therefore lower — lost every merge
  afterwards.  A record that *introduces* an address must now be within
  `firstSightMaxVersionSkewMs` (default 5 min,
  `ClusterOptions.withFirstSightMaxVersionSkewMs`) of the local clock,
  against the 24 h that still governs every later merge.  A rejection is not
  exclusion: a self-announcing node is still recorded and its next frame
  merges through the normal path, so the cost is one gossip round.
- **BREAKING — `redirect()` now rejects off-origin targets** (#125).  The
  helper wrote the caller's URL into the `location` header unchecked, and
  `location` is set nowhere else in `src/http/`, so nothing behind it caught
  a bad target.  Forwarding a `?next=` parameter into it was therefore a
  textbook open redirect: a phishing link bounced a freshly authenticated
  victim to a look-alike host.  `redirect` now accepts same-origin targets
  only (a relative reference); an absolute URL, a protocol-relative `//host`
  target, or a control character throws `HttpError(400)`.  Classification
  mirrors the browser — leading whitespace is ignored and backslashes read
  as slashes, so `/\host`, `\/host` and `\\host` are caught too — and the
  rejection never echoes the target back to the client.  *Migration:*
  replace a deliberate off-origin `redirect(...)` with
  `redirectExternal(...)`, or compute a relative target.
- **`redirectExternal(url, status?)` for the deliberate off-origin hop**
  (#125).  Same signature as `redirect`, minus the origin rule.  A separate
  function rather than a flag on purpose: `grep redirectExternal` enumerates
  every off-origin redirect in a codebase, which a boolean in a third
  argument never could.  Control characters stay rejected on both helpers —
  measured on Bun and Node, CR/LF/NUL are already refused at header-write
  time (so the check only trades an opaque 500 for a 400 that names the
  reason), but a TAB is *accepted* by both `fetch` Headers and Node's
  `setHeader` while browsers strip it before parsing, which let a TAB hidden
  inside `javascript:` reach the browser as a working scheme.

- **BREAKING — the two cluster-wide subscriber registries are bounded and
  watched** (#137, #139).  `Receptionist` gained `maxSubscribersPerKey` /
  `maxSubscribersTotal`, `DistributedPubSubMediator` gained
  `maxSubscribersPerTopic` / `maxTopics` / `maxRemoteNodesPerTopic`, and both
  now watch their subscribers — one that stops without `Unsubscribe` releases
  its slot instead of being pinned forever.  The topic caps also apply to
  **gossip**, which is the axis worth naming: a peer claiming 100 000 topics
  allocated an entry per name on every receiving node, with no local
  `Subscribe` involved.
  **BREAKING:** a refused `Subscribe` is answered rather than discarded, so
  `Receptionist`'s `Subscribe.replyTo` / `Unsubscribe.replyTo` widen from
  `ActorRef<Listing<T>>` to `ActorRef<Listing<T> | SubscribeRejected<T>>` — a
  subscriber that matches its inbox exhaustively has to handle the new variant
  (exported from the package root as `ReceptionistSubscribeRejected`).

- **BREAKING — `DistributedPubSub`'s `Subscribe` takes an optional `replyTo`**
  (#139).  It names where the `SubscribeAcknowledgment`, or the new
  `SubscribeRejected`, is delivered.  The acknowledgment used to run through
  `context.sender`, which is empty for the documented
  `mediator.tell(new Subscribe(…))` call from outside an actor — the caller
  most in need of a refusal was the one that could not receive it.  Existing
  calls compile unchanged and keep following the sender; pass `replyTo` where
  you want to observe the answer.

- **An unbounded `keys` map in the `Receptionist` gossip path** (#137).  A
  peer's contribution is replaced wholesale on every round, but `maybeDrop`
  never ran afterwards, so a key that existed only because that peer named it
  left an empty entry nothing removed.

- **`actor-ts.cluster.pub-sub.*` and `actor-ts.cluster.receptionist.*` HOCON
  sections** (#857).  Gossip intervals, every cap above, and
  `send-to-dead-letters-when-no-subscribers`.  With the toggle on (the
  default), a publish that reached nobody goes to `system.deadLetters` instead
  of vanishing, so a mistyped topic is distinguishable from one whose
  subscribers have not gossiped in yet.  `routing-logic` and
  `removed-time-to-live` from the original proposal are deliberately absent
  rather than shipped inert — the first needs a send-to-one protocol this
  implementation does not have, the second the tombstones its gossip model
  does not use — so #857 stays open for them.

- **DistributedData credits the connection, not the payload** (#719, #723,
  #768).  `Cluster._onWire` has always handed its handlers the peer whose
  connection a frame arrived on; this extension registered a one-parameter
  arrow and dropped it, then read the payload's self-declared `from`.  So a
  write- or read-request naming a third party made the node dial that
  address and queue a full CRDT snapshot in a buffer that is never drained;
  a quorum counted votes by self-declared name, letting one member ack under
  every other member's and have its own state accepted as agreed; and a
  reply was matched on its correlation id alone, with no check that it
  concerned the same key or came from a node that was asked.  Frames now
  travel with the authenticated peer, and the handlers take it as a
  parameter rather than being free to read `from` by accident.

- **A failed durable load no longer wipes the persisted replica** (#725).
  `DurableDistributedDataStore.load()` adopted the stored revision before
  decoding, so a decode that threw left the caller with no state and the
  store holding a valid concurrency token — the next save of the empty view
  then passed the check and replaced the record.  Since the load failure is
  only logged as a warning, one undecodable entry silently destroyed the
  whole durable replica.  The revision is adopted only after every entry has
  decoded; a save then fails loudly instead of overwriting.

- **CRDT payloads are validated before they are merged** (#699, #720, #722,
  #724, #767).  `src/cluster/WireValidation.ts` forwards frame kinds it does
  not know, on the stated grounds that the extension validates its own
  payload — and DistributedData did not.  Every `fromJSON` checked `kind`
  and trusted the rest, so whatever `JSON.parse` produced went into the
  merge machinery.

  That is worse than a handler throwing, because absorbing a peer's state
  and keeping it is what a CRDT is for.  Each decoder now checks the shape,
  the types and the plausibility of what it is handed: a `GCounter` slot must
  be a non-negative safe integer, so `value(): number` can no longer return a
  string (#720); `ORSet` tombstone and element lists must be bounded arrays
  of strings (#722); an `LWWRegister` timestamp must be finite,
  non-negative and within five minutes of local time, so a year-3000 stamp
  no longer beats every honest write from then on (#724); and the
  CRDT-internal maps — the replica-id and tag keyed ones — reject a
  `__proto__` key rather than accept one no re-encode can carry (#767).

  What validation does **not** settle is a defect whose payload is
  well-formed, and three of the issues above are exactly that.  Each needed a
  second change, listed separately below: a value that will not decode has to
  be *dropped* rather than thrown out of a wire handler (#699); an `ORSet`
  tag has to be unguessable, because a forged tombstone is a well-formed
  string and passes every check here (#722); and a store key has to survive
  re-encoding, which is a defect in the encoder that no decoder can reject
  its way out of (#767).

  Still open, and deliberately not claimed here: `Number.MAX_SAFE_INTEGER`
  *is* a non-negative safe integer, so a peer can still write it into another
  replica's `GCounter` slot and pin it there, since max never decreases
  (#720).  The own-slot authority rule that issue proposes is not the answer
  — a replica legitimately relearns its own slot from peers after restarting
  without a durable store, and refusing that leaves two replicas permanently
  disagreeing about the same key.  Nor does it close the inflation itself: a
  peer can reach the same ceiling through `increment` on its own slot, which
  is a legal local operation.

  **BREAKING:** previously-accepted frames are now rejected — in practice,
  malformed or hostile ones.

- **A malformed peer value is dropped, not escalated** (#699, #721).
  Validating means `decodeCrdt` *throws*, and every call site is a wire
  handler — so the checks above made the reachable throw paths more numerous
  rather than fewer, and an exception out of one is an actor failure: twelve
  of them exhausted the DistributedData actor's restart budget and terminated
  it for the life of the process, taking every unsettled read and write
  promise with it.  A value that will not decode is now dropped and logged
  with the peer and the key it came from, per entry rather than per frame —
  entries that travel in one frame are independent CRDTs that merely share a
  ride, and a state-based replica re-sends everything on the next tick, so a
  dropped entry costs a gossip round and nothing else.

- **A `__proto__` store key gossips and persists like any other** (#767).
  `JSON.parse` makes `__proto__` an own enumerable property and every decode
  target is a `Map`, so the key went in fine — but every re-encode built an
  object literal and assigned into it, and for that one key an assignment
  invokes `Object.prototype`'s inherited setter instead of creating a
  property.  The entry vanished from every outbound frame and every durable
  snapshot while `get`/`keys` still reported it locally, with nothing logged
  anywhere; when it was the only key, the empty-payload short-circuit
  suppressed the gossip tick outright.  Store keys are the exposed layer
  because they are raw application strings — a key derived from untrusted
  input, a username or a tenant id, is the realistic trigger rather than a
  planted frame.  Payloads are now built with `Object.fromEntries`, which
  defines the property, in `gossipTick`, in the durable save, and in the four
  collection encoders whose keys are identity-fn output.  Same remedy as the
  CBOR map decoder under #581.

- **A decoded `LWWRegister` replica id must be a string** (#724).  `ReplicaId`
  is a bare `type ReplicaId = string`, so nothing at runtime kept the wire
  from carrying something `assign` could never produce — and the field is
  compared, not merely carried.  `>` between a string and a number is false
  in *both* directions, so a numeric replica id makes a same-timestamp merge
  non-commutative and the two replicas never converge on that key; an array
  is the mirror image, coercing to its single element so that one holding a
  high code point wins every tie while not being a string at all.  A
  legitimately typed id that sorts above every real `system@host:port` still
  wins those ties — that is what a deterministic tie-break costs, and the
  timestamp bound is what keeps it from mattering.

- **A gossip frame cannot exhaust the stack or freeze the event loop**
  (#698, #721).  `decodeCrdt` recursed once per nested `ORMap` level with no
  depth bound, and `MVRegister.merge` scanned every entry against every
  other over an unbounded, peer-supplied array: a 442 KiB frame — far under
  the 16 MiB frame cap — froze the loop for ~33 s, and since none of the
  entries dominated another they were all kept, so every later merge was
  slower than the last.  Nesting is capped at 32; multi-value registers get
  their own tighter entry cap, since an entry there is a concurrent write
  nobody has superseded rather than ordinary collection data.  Merge also
  skips already-dominated entries as dominators, which makes the common
  causal-chain case linear.

- **A cluster `hello` identity is bound to the TLS peer certificate** (#912).
  mTLS decided *whether* a peer belonged in the cluster; nothing decided
  *which* member it was.  The `hello` frame carries a `NodeAddress` and no
  credential, so a single CA-signed node could announce itself under another
  member's address — and since the gossip-authority rules from #562, #564
  and #572 all key off the connection's peer, it inherited that member's
  standing along with the traffic addressed to it.  The duplicate-identity
  guard did not cover it: a fresh claim, or one made after the real holder's
  connection dropped, is not a duplicate.

  When a peer presents a certificate, the claimed address must now be one
  the certificate vouches for — its host, or the full `systemName@host` for
  deployments that mint per-node identities — with leftmost-label wildcards
  honoured for the host, as in TLS hostname verification.  Two nodes sharing
  one host certificate remain indistinguishable, which is documented rather
  than papered over.

  Clusters with no certificate to read are untouched: plain TCP, one-way
  TLS, and Deno (whose `TlsConn` exposes no peer certificate at all) behave
  exactly as before.  There is no new configuration key, so the check cannot
  be left switched off on a deployment that thinks it has mTLS.

- **The DevTools WebSocket enforces the same-origin default it documented**
  (#566).  `DevToolsOptions` and the DevTools page both promised
  "same-origin only", but `routes()` passed no origin rules when
  `allowedOrigins` was unset, and an empty allowlist built no upgrade guard
  at all — so the tap accepted a handshake from any origin.  A WebSocket
  upgrade is not subject to the same-origin policy, so the loopback bind
  that makes the default feel private stops nothing: any page the developer
  visited could open `ws://127.0.0.1:9333/api/ws`, complete the
  unauthenticated handshake and read the actor tree, mailboxes, spans and —
  time-travel being on by default — raw persisted events and reconstructed
  actor state.  `DevTools.mount()` put the same socket on an application's
  own server, behind whatever ambient auth that server had.

  The tap now always requires the upgrade's `Origin` to name the tap
  itself.  `allowedOrigins` widens that rule instead of replacing it, so
  configuring one cannot lock out the tap's own UI, and a request with no
  `Origin` is still allowed — CSWSH needs a browser, and a browser always
  sends one.

  Routes get `requireSameOrigin` for the same purpose.  It belongs on the
  route's upgrade `authorize` rather than in middleware: an upgrade is a
  GET, and `requireSameOrigin` from `Csrf.ts` waves safe methods through.

- **A CBOR map key can no longer pick the decoded object's prototype**
  (#581).  Map decoding assigned each pair with `out[key] = value`, and
  assignment consults the prototype chain — so a 21-byte payload whose key
  is `"__proto__"` reached `Object.prototype`'s setter and re-parented the
  decoded object instead of adding a field to it.  Keys are now defined
  rather than assigned, which ignores setters: `__proto__` becomes an
  ordinary own property, so the value survives the round-trip instead of
  being rejected or silently dropped.

- **A CBOR body can no longer stall the event loop** (#567, #618).  Two
  unbounded paths in `CborDecoder`, both reachable from an ordinary
  `entity()` route: `Content-Type` alone selects the codec, so an
  application that only ever meant to accept JSON still handed an
  attacker's `application/cbor` body to the CBOR decoder.

  Tag 2 / tag 3 bignums were rebuilt one byte at a time with
  `value = (value << 8n) | BigInt(byte)`, which reallocates the whole
  accumulated bignum per iteration — quadratic in the declared length, and
  the only ceiling was the 10 MB body limit.  A few hundred KB bought
  seconds to tens of seconds of blocked event loop, during which no other
  request, actor message or cluster heartbeat is served.  The magnitude is
  now parsed in one pass, and capped at 1024 bytes (8192-bit) as a
  backstop.

  Separately, `readValue` recursed once per array, map and tag level with
  no depth bound, so a couple of hundred KB of `0x81` bytes exhausted the
  JS stack.  Nesting is now capped at 256.

  Journals and snapshots are unaffected — nothing under `src/persistence/`
  serializes through this codec.

- **A socket that closes during the upgrade window is no longer lost on Hono**
  (#570).  The per-connection actor attaches its socket listeners from
  `preStart`, two mailbox hops after the upgrade returns.  The `ws`-package
  adapter buffers everything that arrives in that window; the Hono adapter
  buffered messages only, so `close` and `error` hit a null listener and
  vanished.  Nothing else stops the connection actor — the hub's `_clients`
  entry, the `ConnectionTracker` entry and the `maxConnections` decrement all
  hang off that one dropped callback — so every client that closed inside the
  window leaked an actor and a connection slot for the life of the process.
  With `maxConnections` configured, the hardening knob became the denial of
  service: a burst of open-then-close connections exhausted the budget
  permanently.  Sequential clients almost never hit it, which is why it
  survived a green suite; concurrency is what widens the window.

  The buffer is now one function, `bufferWebsocketEvents()`, that both
  adapters share, rather than a per-adapter array each is free to get
  half-right.  A burst test in the shared backend suite covers all three
  backends.

- **Extension wire handlers credit the connection, not the payload** (#574,
  #582, #711).  `Cluster._onWire` has always passed the connection's peer to
  every handler; the receptionist, the pub-sub mediator and the
  cluster-client receptionist each ignored it and read the payload's
  self-declared `from` instead.  Both gossip handlers *replace* a sender's
  contribution wholesale — that is how deregistrations propagate — so any peer
  could name another node and wipe what that node had registered cluster-wide.
  The cluster-client receptionist additionally threw a `TypeError` out of the
  frame-dispatch loop when `from` was absent, and sent its reply to whatever
  address the payload named.

- **Shard ids are bounded by `numShards`** (#583, #569).  A shard id is
  `hash(entityId) % numShards`, so no honest region can ask for one outside the
  range — but neither side checked.  The coordinator allocated, recorded and
  *persisted* whatever id it was handed, and the allocation map is durable
  state replayed at every coordinator start, so the growth survived restarts.
  On the region side the id becomes a **child actor name**, minting a permanent
  child under an attacker-chosen name.  `ShardCoordinatorOptions` gained
  `numShards` (`withNumShards`) for the coordinator half.

- **Two `.exhaustive()` matchers no longer fail their actor on an unrecognised
  message** (#713).  `Receptionist` and `ClusterSingletonManager` both sit at
  resolvable paths, so anything a peer addresses to them lands in their
  matcher.  The receptionist's arms all match on `instanceof`, and a body
  delivered over the wire arrives as a plain JSON object — so one remotely
  delivered envelope failed the actor holding the node's whole service
  registry.  Both now drop the message through an `otherwise` arm and log it.

- **Gossip claims need authority, not just a high version number** (#562,
  #564, #572, #573).  The merge was decided purely by version magnitude, and
  versions are seeded from `Date.now()` — so an attacker could always pick a
  winning number.  Nothing checked *who* was entitled to say what:

  - One frame set the receiving node's **own** record to `removed`, which
    dropped it out of its own active set and flipped `isLeader()` to false, so
    the cluster stopped admitting new members (#562).
  - `onLeave` read the departing node from `message.node` instead of the
    connection, and writes a tombstone at `version + 2` — above anything the
    victim can say about itself.  One 120-byte frame evicted any member
    cluster-wide for the 24-hour tombstone TTL (#564).
  - `onHeartbeat` credited liveness to `message.from` and sent the
    acknowledgment there, so a peer could keep a dead node looking healthy —
    blocking singleton and shard failover — and make the receiver dial an
    attacker-chosen `host:port` (#572).
  - The envelope's MDC went unfiltered into `LogContext.run`, letting a peer
    overwrite `JsonLogger`'s own `ts`/`level`/`source`/`msg` (its record
    spreads the context last) and inject newlines into `ConsoleLogger`'s
    one-line-per-record output, forging whole log lines (#573).

  Claims are now keyed on the **connection's** peer rather than the payload's
  self-declared `from`.  A node is the author of its own status — except for
  promotion into `up`, which is the leader's call and is therefore carved out
  explicitly.  Claims about a *third* node require the sender to be a member
  this node already considers active.

  Unreachability is deliberately still merged from third parties: "I cannot
  reach C" is inherently a third-party observation, and every node must
  converge on the same view before a downing provider decides.

  This is not authentication — `hello` still carries no credential, so an
  unauthenticated peer can announce itself and wait to be promoted.  It removes
  the free-for-all; mTLS remains the control for untrusted networks.

- **Wire frames are validated before anything reads them** (#563, #571,
  #705, #587).  `FrameDecoder` ended in `JSON.parse(json) as WireMessage` —
  a cast, not a check — and every layer downstream read the frame as if the
  type were true.  Three things followed from that, all remotely reachable:

  - A `null` frame (8 bytes, `JSON.parse('null')`) was dereferenced by
    `TcpTransport.onMessage` above the handshake gate, so **no `hello` was
    needed**: an unauthenticated remote process kill on Node.
  - A gossiped member `status` outside the seven legal values reached
    `emitStatusTransition`'s `match(...).exhaustive()`, which throws — from
    a socket callback, and *after* the member had been written to the map.
    The node died **and** re-gossiped the poisoned entry, so one frame at one
    reachable node propagated to the whole cluster.
  - A `port` arriving as the string `"2552"` keyed every map identically to
    the number but never compared equal, permanently desyncing a node's view
    of its own identity.

  Frames now pass shape validation at the decode boundary (`WireValidation.ts`),
  `NodeAddress.fromJSON` and `Member.fromData` reject impossible values rather
  than constructing from them, and the frame-dispatch loop is wrapped: a
  malformed frame is dropped and the connection survives, while a handler that
  throws drops the connection instead of escaping into the runtime's socket
  callback.  `ClusterClient` got the same treatment — its `decoder.push` call
  was unguarded, so one malformed frame from a contact point killed the client
  process (#587).

  `MemberStatus` is now *derived* from a runtime `MEMBER_STATUSES` list, so the
  type and the values it is checked against cannot drift apart.

  Extension frame kinds (sharding, pub-sub, receptionist, DistributedData,
  DevTools) deliberately pass this layer and validate their own payloads.

- **`ORSet` tags are minted from entropy instead of a counter** (#722).  A tag
  was `${replica}#${seq}` off a per-replica sequence that travelled in the
  payload, so both halves were readable from any gossip frame and the tags a
  replica had not issued yet were arithmetic.  Tombstones veto by tag on
  merge, are unioned unconditionally and are never pruned — so one frame of
  forged tombstones made a victim's next writes vanish on the following merge,
  indistinguishable from a concurrent remove and with no API to take a
  tombstone back.  Tags now carry 96 bits from the platform's cryptographic
  random source, which is the conclusion #120 already reached for
  `ClusterClient` ask ids and #896 for quorum correlation ids.

  The two other parts of the reported fix are deliberately not implemented:
  requiring a tombstone's tag to name the sending peer stops removes from
  propagating at all, because `remove` legitimately tombstones tags other
  replicas minted; and dropping tombstones for tags no side has observed
  resurrects removed elements under out-of-order gossip.

  **BREAKING:** the `counters` field is gone from the `ORSet` wire shape,
  since nothing mints from it any more.  A frame — or a durable record — from
  an older peer still carries it and is accepted; an older peer *requires* it
  and rejects one without it.

  **Migration:** upgrade every node.  During a rolling upgrade `ORSet` values
  flow only from old nodes to new ones, and the not-yet-upgraded side logs one
  dropped value per gossip round; nothing is lost, because a dropped entry
  does not mutate state and state-based gossip re-sends everything, so
  convergence resumes once the last node is up.  Tags minted by either version
  keep working on both — a tag is an opaque string to every comparison it
  takes part in, and the two formats cannot collide.

### Changed

- **The receptionist, the pub-sub mediator and the broker base index their
  subscribers through `BidirectionalMultiMap`** (#1037).  All three kept the
  same relation by hand, each with a comment explaining why it had to, and
  all three now converge on the same pair: the relation plus a
  `path → ActorRef` map for the fan-out target and the unwatch handle.
  Behaviour is unchanged; what goes away is the lockstep discipline and one
  latent defect with it.  `Receptionist.totalSubscribers` no longer exists —
  it was exactly the pair count, so it is `subscriptions.size`, and with it
  goes a counter that decremented *before* its own "did this subscriber
  exist" guard.  Today's single caller happened to guard it, so the count
  stayed right; a second one that did not would have drifted the subscriber
  cap downward permanently, and a derived value cannot drift.  In the
  mediator, `SubscriberSet` becomes `TopicState` — what a topic holds
  besides its subscribers — and the four hand-written copies of the
  empty-topic guard become one `maybeDropTopic`.  The fan-out paths there
  gain one map lookup per local subscriber per publish, the price of keying
  on paths rather than on ref identity — identity keying is what does not
  survive death watch.  Measured on `benchmarks/cluster/pubsub-fanout.ts`
  at 1000 local subscribers, three runs each, it does not show: 63.3 / 61.5
  / 61.9 µs per delivery before against 60.0 / 62.8 / 55.9 µs after.  The
  lookup is inside the noise of the mailbox hop it sits next to.

- **The `fn` parameter name is spelled out across the API** (#1112).  136
  sites in 34 files under `src/` still used `fn`, the short form `AGENTS.md`
  bans by name alongside `Cmd`/`Msg`/`Ctx`/`Impl`/`Ctor`.  Parameter names
  reach users — they are part of the published `.d.ts`, the generated
  TypeDoc and IDE signature help — so this touches public surface:
  `Dispatcher.execute(task)`, `Scheduler.scheduleOnceFunction(delayMs,
  task)`, `LogContext.run/with/runFresh/runEach(…, callback)`,
  `Tracer.withActiveSpan(span, callback)`, `TestKit.within(durationMs,
  callback)`, `SqliteDb.transaction(body)`,
  `HealthCheckRegistry.addLiveness/addReadiness(check)`,
  `DistributedData.update/updateAsync(key, factory, mutator)`,
  `ORMap.updateWith(…, mutator)`, `EventDispatcherBuilder.on(kind,
  handler)`, and the four HTTP middleware builders, where the new name is
  the field the builder writes (`withGenerate(generate)`,
  `withValidate(validate)`, `withOnTimeout(onTimeout)`,
  `withOriginPredicate(predicate)`).  **Not breaking:** arguments are
  positional, and every type whose *field* was renamed (`ManualScheduler`'s
  task record, DistributedData's update message, the Node worker adapter's
  listener map) is module-local or private.  No behaviour change.

  Three declarations that transcribe a vendor shape — better-sqlite3's
  `transaction`, `@opentelemetry/api`'s `context.with`, and the
  `bun:test`/Vitest/Jest `beforeAll`/`afterAll` hooks — were renamed too:
  structural assignability ignores parameter names, so only the *member*
  names have to stay verbatim, and those did.

- **Documentation corrected where it named parameters that no longer
  existed** (#1112).  `persistence/fsm/*` documented `onEnter(state, fn)` /
  `onExit(state, fn)` / `onTransition(fn)` where the source says `hook` /
  `hook` / `cb` and the method is `onExitState` (`onExit` is a private
  field); `fundamentals/event-stream` documented `cluster.subscribe(fn, …)`
  against a parameter named `listener`; and the
  `operations/upgrades/rolling-migration` helper table listed
  `migrateSnapshotStore(store, pids, fn)` for `(store, persistenceIds,
  manifestFor)`.  All pre-existing drift, fixed in EN and DE together.

- **BREAKING — `ClusterOptions.firstSightMaxVersionSkewMs` is now
  `maxVersionSkewMs`** (#114).  *Migration:* `withFirstSightMaxVersionSkewMs(ms)`
  → `withMaxVersionSkewMs(ms)`, same default (5 min), same unit; the option never
  had a HOCON key, so `reference.conf` is unchanged.  The old name stopped being
  true once the cap applied to every merge rather than to a first sighting.
  Behaviour changes with it: a refusal is now permanent — a node whose clock runs
  further ahead than the budget stays in the member list without roles until its
  clock comes back, instead of getting through on its own second frame.  That was
  always this cap's verdict; the second frame was the bypass.

- **Sharding resolves entities and regions by index instead of scanning**
  (#1035).  `Passivate` and `Terminated` arrive carrying a ref and nothing
  else, so `Shard` found the entity they refer to by walking every entry in
  its entity map — O(n) per entity stop, and therefore O(n²) to drain a shard
  during handoff, on the one path that runs once per entity and precisely
  when a shard is at its largest.  It now keeps a `BidirectionalMap` of
  entity id ↔ actor path; the path *string* is indexed rather than the ref,
  because that is what `ActorRef.equals` compares.  `ClusterSharding`
  likewise suffix-matched every registered path to resolve a region by type
  name, on a path reached for every message sent through a sharded type, and
  now keeps a direct index.  No behavior change.

- **A resumed actor's children are resumed with it** (#635).  A failure
  suspends the failing actor's subtree so nothing in it runs while the
  supervisor decides, but `Directive.Resume` only ever reached the actor that
  failed.  Its children stayed suspended permanently: mailboxes filled,
  nothing was processed, and there was no error and no dead letter to notice
  it by.  `suspend` and `resume` now walk the same tree.

- **BREAKING — a restart stops the actor's children** (#634).  A restart
  replaces the `Actor` instance while the cell, and with it the child map,
  survives.  Children were therefore inherited by the new incarnation — which
  made an ordinary pattern impossible: `postRestart` re-runs `preStart`, so an
  actor that spawned a *named* child there hit `Child name … is not unique` on
  its first restart and never recovered.

  The children are now stopped after `preRestart` and **before** the
  replacement is built, and the restart waits for them, so the fresh instance
  starts from an empty child map.

  **Migration:** an actor whose children should outlive a restart overrides
  the new `Actor.stopChildrenOnRestart()` to return `false`, and adopts the
  survivor in `preStart` — `this.child = this.context.child('name')
  .toNullable() ?? this.context.spawn(Child, 'name')`.  An instance field
  cannot carry that across a restart: `preStart` runs on a fresh instance, so
  `this.child ??= …` is always unset and re-spawns into the name the surviving
  child still holds.  It is a hook rather than a
  `preRestart` override because the teardown has to be awaited, and
  `preRestart` cannot tell the framework it started something worth waiting
  for.

- **BREAKING — a sharded entity's child name escapes its id injectively**
  (#568).  `entityName()` folded every character outside `[A-Za-z0-9_-]` to
  `_`, which is many-to-one.  Two ids that differed only in punctuation
  produced the same child name, and when they also hashed into the same
  shard the second one missed the shard's id-keyed map, called
  `createEntity`, and `_createChild` threw `Child name … is not unique`.
  That throw kills the Shard actor — and with it every unrelated entity
  living in that shard, including other tenants'.  It needed no attacker:
  `a.b@x.com` and `a-b@x.com` collided, and `extractEntityId` is documented
  as reading the id straight off an inbound message.

  A code unit outside `[A-Za-z0-9_-.@:+]` is now escaped as `~` plus four
  hex digits.  Ordinary ids are unchanged — `user-42`, `a.b@x.com` and
  `tenant:eu` all read as themselves — and the escape works per UTF-16 code
  unit rather than percent-encoding UTF-8, so it is total: a lone surrogate
  cannot make it throw inside the shard, which would recreate the very
  failure being fixed.

  **Migration:** entity actor *paths* change shape for ids containing
  escaped characters — visible in the DevTools tree, in log lines, and in
  remote path rendering.  Nothing persists a path (remembered entities store
  ids), so there is no data migration.  Code that recovered an id by slicing
  the `entity-` prefix off `context.path.name` must read `this.entityId`
  instead; that accessor has existed since #832 and is the supported route.
  Nothing decodes a path segment, and `parsePathSegments` now says so — the
  escape is injective only while it stays escaped end to end.

- **BREAKING — the cluster wire protocol's discriminator is `kind`** (#494).
  The framework had three spellings for the same concept: `t` on the cluster
  wire (`hello`, `gossip`, `envelope`, `leave`, …) and on the internal
  coordinator/singleton event unions, `$t` on the sharding protocol
  (`sharding.Register`, `sharding.ShardHome`, …), and `kind` everywhere else —
  which is the one AGENTS.md prescribes. All three are now `kind`.

  **Migration:** a rolling upgrade is not possible. A v0.13.0 node and a
  v0.14.0 node cannot talk to each other — the discriminator they read is
  absent in the other's frames, so every frame is unrecognised. Stop the
  whole cluster, then start it again on the new version. Nothing in the
  public API changes; this affects only the bytes on the wire between nodes
  (and anything speaking that protocol directly, e.g. a hand-rolled
  `ClusterClient` peer or a test that constructs raw frames).

  The DevTools tap protocol already used `kind` and is untouched, so the
  embedded UI bundle and any tap client keep working across the upgrade.

## [0.13.0] — 2026-08-05

### Removed

- **BREAKING — `Props` is gone from the public API** (#547).  Spawning takes
  the actor class or a factory directly, and per-actor configuration is an
  ordinary options family:

  ```ts
  // before
  system.spawn(Props.create(() => new Greeter()), 'greeter');
  system.spawn(Props.create(() => new Worker(db)).withMailboxCapacity(500), 'w');

  // after
  system.spawn(Greeter, 'greeter');                      // zero-arg class
  const workerOptions = ActorOptions.create<WorkerMessage>().withMailboxCapacity(500);
  system.spawn(() => new Worker(db), 'w', workerOptions);
  ```

  `Props` bundled two unrelated things — *what* to construct and *how* to run
  it — and 75 % of its ~970 call sites used only the first.  The second half
  is now `ActorOptions`, a regular `XOptions` family (`ActorOptionsType` /
  `ActorOptionsBuilder` / `ActorOptions` / `ActorOptionsValidator`), which is
  what per-actor configuration should have been all along; it was the one
  place in the framework that did not follow that convention.

  **Migration:** drop `Props.create(` and its closing `)` — what is left is
  already a valid factory, and a zero-argument class needs no closure at all.
  Move each `.withX(…)` into a third `ActorOptions` argument; `asInternal()`
  becomes `withInternal()`.  Renamed carriers: `entityProps` → `entityActor`
  (+ `entityOptions`), singleton `props` → `actor` (+ `actorOptions`),
  `singletonProps` → `singletonActor`, `childProps` → `child`
  (+ `childOptions`), `routeeProps` → `routee` (+ `routeeOptions`),
  `behaviorFor` → `actorFor`; `BackoffSupervisor.props` → `.factory`,
  `ClusterRouter.props` → `.factory`, `typedProps` → `typedActor`.

  Two behavioural notes.  `ActorOptions` **mutates in place** where `Props`
  was copy-on-write, so a builder is one configuration — sharing one and
  re-chaining it no longer branches.  The settings are snapshotted at spawn,
  so mutating a builder afterwards never reconfigures a running actor.  And a
  class whose constructor takes arguments is now rejected at the spawn call
  naming the factory form, instead of being constructed with `undefined`
  dependencies and failing later — this also closes the same hole in the
  existing `ClusterSharding.start` / `ClusterSingleton.start` shorthands.

### Added

- **`ActorOptions`** (#547) — `withSupervisorStrategy`, `withDispatcher`,
  `withMailboxCapacity`, `withMailbox`, `withInternal`, `withEntity`,
  `withDisplayName`, plus an `ActorOptionsValidator` that rejects a
  non-positive `mailboxCapacity` at the `spawn` call rather than from inside
  the mailbox constructor.  Accepted as a builder or as a plain object, like
  every other options family.

- **`ShardInfo.resident`** (#901).  `ClusterSharding.shards()` now reports
  whether each shard actor was materialised when its region answered.
  `entityCount: 0` cannot say that on its own — a running-but-empty shard and
  one that passivated report the same count — so this is what to read when
  tuning `shardPassivationIdleMs` or counting the actors a node really holds.
  It says nothing about reachability: `ref` works either way.

- **`Actor.displayName()` — a readable name for an actor in logs and DevTools**
  (#891).  A path is an address, not a name: under sharding the log source
  grows to ~120 characters of machine identifier, and the business identity it
  stands for had to be repeated by hand in every message the entity logged.
  Override `displayName()` and the actor says it once; the name joins the line
  as its own segment after the source
  (`... - User(test-user-590) - recovery complete`), and labels the row in the
  DevTools actor tree — worth the most for `Behaviors` actors, whose class
  column reads `TypedActor` on every row.  Also settable from the spawn site
  with `ActorOptions.withDisplayName(...)` (which outranks the method, as
  `withSupervisorStrategy` does) and at runtime with
  `context.setDisplayName(...)` (which outranks both) — the latter being the
  way in for a `Behaviors` actor, which has no subclass to override, and for a
  name that only settles after recovery.
  Resolved on every record rather than captured once, so it may be derived from
  state and follows a restart; a throw or a non-string falls back to the path
  and warns once.  Defaults to the path, so **existing log output is unchanged**
  — and it stays a label: metric labels, tracing attributes, dead letters,
  `ActorRef.toString()` and every cluster-wire identifier keep using the path.
  Structured loggers get a separate `displayName` field beside `source`;
  `interface Logger` is untouched, so third-party implementations keep working.
- **Empty shards passivate** (#892).  A shard actor used to outlive its
  entities indefinitely: it appears when the coordinator allocates it to a
  node and, apart from a handoff, nothing ever stopped it again.  Since entity
  ids spread over the hash space, a long-running node accumulated one idle,
  empty shard actor per `numShards` — 64 of them with the default.  A shard
  that has stood empty for `shardPassivationIdleMs` is now stopped too.  The
  region keeps ownership, so the shard stays routable and the next message
  re-creates it with no coordinator round trip; only an *empty* shard is ever
  stopped, so no entity state is at stake, and messages arriving mid-stop are
  buffered and replayed exactly as they are for an entity.
- **`shardPassivationIdleMs` / `withShardPassivationIdleMs()` /
  `actor-ts.sharding.shard-passivation-idle`** (#892).  Unset it follows
  `passivationIdleMs` — a shard stands empty precisely because its entities
  went idle — and `0` keeps empty shards resident while entities still
  passivate.  It is deliberately absent from `reference.conf`: a shipped value
  is exactly what "unset" would have to be distinguishable from.

### Changed

- **Spawning an actor class is the standard form across the whole repo**
  (#547).  `spawn(() => new MyActor())` was the shape every call site had
  copied from the `Props` era; the ~500 zero-argument closures in `src/`,
  `tests/`, `examples/`, `benchmarks/` and the docs are now
  `spawn(MyActor)`.  The sweep covers every slot that takes an
  `ActorClassOrFactory` — `spawn` / `spawnAnonymous`, `withEntityActor` /
  `withActor` / `withSingletonActor`, the `entityActor` / `singletonActor` /
  `actor` / `child` fields, and the `Router.*` routee position.  No API
  change: the closure form still works, and is still the way to pass
  constructor arguments (`() => new Worker(database)`).

- **BREAKING — idle entities passivate by default, after 5 minutes** (#892).
  `passivation-idle` shipped as `0ms`, so nothing ever passivated until an
  operator went looking for the key, and entity sets only grew.  The reference
  value and the built-in fallback are now `5m`.
  **Migration:** an entity that keeps state in memory and does not rebuild it
  in `preStart` now loses that state after five minutes idle — persistent
  entities recover, plain ones do not.  Set `passivation-idle = 0ms`, or
  `withPassivationIdleMs(0)` per type, to restore the previous always-resident
  behaviour.  Note that under `rememberEntities` a passivation is also a
  *forget*, so a remembered fleet left on the default drains over time; decide
  explicitly which of the two you want.  `ShardedDaemonProcess` opts out on
  its own — its daemons are meant to run continuously.
- **BREAKING — anonymous actors are named `$anonymous-<n>-<random>`, not `$1` /
  `$2`** (#895).  `spawnAnonymous`, `spawnTypedAnonymous` and
  `context.spawn(behavior)` without a name drew from a bare per-parent counter,
  which is both opaque (a DevTools row reading `$1` gives no hint the name is
  framework-generated) and guessable — `/user/$1` is the first anonymous actor
  of every run, and an actor path is an address anything that can render one can
  send to.  The name now carries a per-parent counter *and* twelve random hex
  characters from `crypto.getRandomValues`; the counter is kept so spawn order
  stays legible in a log line and in the actor tree.  Same reasoning that moved
  `ask`'s reply refs off a counter in #120.  Note this is the *path* segment —
  `Actor.displayName()` above is the cosmetic label and is unaffected.
  **Migration:** nothing you name yourself changes — only the value the
  framework picks when you don't.  Code that hard-codes an anonymous path
  (`actorSelection('/user/$1')`) or parses `$<n>` out of a name must spawn with
  `spawn(actor, name)` and a name of its own.
- **BREAKING — unnamed reliable-delivery controllers are
  `consumer-<n>-<random>` / `producer-<n>-<random>`** (#897).  The fallback name
  came from a module-global counter, so `/system/delivery/consumer-1` was the
  first one of every run — a derivable address for an actor that is reachable by
  path — and two `ActorSystem`s in one process drew from the same sequence.
  Same shape as the anonymous-actor names above: counter first so spawn order
  stays legible, random half to close the guessability.
  **Migration:** passing an explicit `name` to `ReliableDelivery.consumer()` /
  `.producer()` is unchanged.  Code addressing a generated controller by path
  must pass a name of its own.
- **BREAKING — actor names starting with `$` are reserved for the framework**
  (#900).  `spawn(actor, name)` and `spawnTyped(behavior, name)` now reject a
  name beginning with `$`, the prefix `spawnAnonymous` generates
  (`$anonymous-<n>-<random>`).  Until now anyone could claim it, so a
  hand-picked `'$anonymous-1-…'` could collide with — or stand in for — a name
  the framework was entitled to hand out, with spawn order deciding which won.
  A `$` anywhere other than the first character is unaffected (`'order$42'`
  still spawns).
  **Migration:** rename any actor whose name starts with `$`, or let the
  framework name it with `spawnAnonymous`.  Note the rule sits on the *spawn
  call*, not on `ActorPath`: paths are also rebuilt from cluster-wire strings,
  and rejecting `$` there would break every remote reference to an anonymous
  actor — so receiving, resolving and rendering such a path all still work.

### Fixed

- **Two nodes that dial each other at the same moment no longer stay split
  forever** (#697).  `openOutbound` registers a connection in `byPeer` *before*
  the handshake, with `peer` still unset, and the hello-hijack guard compared
  identity alone — so in a crossing dial each node held an un-acked outbound
  under the other's key and rejected the other's perfectly legitimate `hello`.
  Neither dial then received its `hello-ack`, `peer` stayed `null`, and
  `onClose` deleted the `byPeer` entry only *if* `peer` was set: the slot was
  never reclaimed, the address never re-dialled, and every frame for that peer
  accumulated silently in the handshake buffer.  The pair was partitioned for
  the lifetime of the process — reachable in the real-network suite, where two
  nodes logged one hijack rejection naming each other in the same millisecond
  and cluster-wide receptionist and pub-sub state then converged at 4 of 5 on
  exactly those two.
  Cleanup is now keyed on the *dialled* address rather than on `peer`, so a
  dead dial always gives its slot back and the next send re-dials; a 5 s
  handshake deadline reclaims a dial that connects but never acks (the
  accepts-TCP-but-never-speaks case, which had no recovery path at all); the
  handshake buffer is capped at 1 000 frames, dropping oldest; and a crossing
  dial is settled by address order, so exactly one of the two survives instead
  of both standing down.  An **established** peer connection is still never
  displaced — only a node's own unfinished dial gives way — so the hijack
  defence the guard exists for is unchanged, and it now has a test saying so.
- **`rememberEntities` no longer forgets every entity when a shard rebalances**
  (#632).  `ShardRegion.onHandOff` announced an `EntityStopped` to the
  coordinator for *every* entity of the departing shard.  The coordinator
  applied and persisted those as `stopped`, which deleted the shard's whole
  entry from its registry — so when `onHandOffComplete` reallocated the shard
  and went to ship the remembered set to the new owner, there was nothing left
  to ship.  The new owner started empty, only the entity named by the next
  message ever came back, and the coordinator went on listing the rest with
  `started` events that would never see a `stopped`.  A rebalance is the
  ordinary path, so this was `rememberEntities` failing at precisely the thing
  it exists for; it survived because the only coverage was a cold restart,
  which reloads the registry from the journal and never exercises a live
  handoff.
  A stopping entity and a moving entity look identical on the wire, so the fix
  is on both sides: the departing region no longer reports the move as a stop
  (the same way an unexpected shard death already reported none, #894), and the
  coordinator ignores an `EntityStopped` for a shard that is mid-rebalance —
  which also covers an entity that passivates on its own inside the handoff
  window, newly likely now that passivation is on by default.  Note this is
  distinct from an ordinary passivation, which under `rememberEntities` is
  still deliberately a forget.
- **Filesystem object storage stopped recognising its own temp files** (#909).
  The `Math.random()` removal below (#898) changed the atomic-write temp path
  from `<key>.tmp.<pid>.<ts>.<rand>` to `<key>.tmp.<pid>.<random>` without
  updating the pattern `list()` uses to skip them — three all-digit groups
  against a two-group name whose second half is hexadecimal, so it could not
  match at all.  A temp file only survives if the process died between the
  write and the rename, which means it holds a *partial* body; `list()` began
  reporting those as ordinary objects, so any prefix scan — a sweep, a
  migration, a durable-state enumeration — saw a key that was never committed.
  Caught only after release-time review because the test wrote the old shape by
  hand: that literal still matched the stale pattern, so the assertion passed
  while the behaviour it guards was broken.  The fixture is now built from the
  same `randomId` the writer uses, leftovers in the pre-#898 shape are still
  skipped so an upgrade does not start surfacing them, and there is a test that
  an ordinary key which merely looks temp-ish is not swallowed.
- **Messages buffered during a handoff are no longer stranded** (#893).
  `completeHandOff` cleared the region's cached shard home without ever
  replaying the buffer, and the coordinator announces a new placement only to
  the new owner and to regions with an outstanding query — so the region that
  had just handed the shard off waited for an unrelated later message to
  trigger a lookup.  On a shard that went quiet after the rebalance, that
  never came.  The region now re-asks for the home whenever its buffer is
  non-empty.
- **A shard ref for a remote shard no longer drops messages while that shard is
  passivated** (#901).  `shardRefFor()` and `ShardInfo.ref` handed out a ref
  addressed at the shard's path on its owning node.  That was safe while an
  allocated shard always had a running actor; since #892 it does not, and in
  the gap nothing resolved the path, so the receiving node dropped the message
  into the envelope catch-all.  Remote shard traffic now goes to the owning
  region — always up — which materialises the shard before forwarding, the
  same shape entity traffic has always had.  The ref keeps the shard's path as
  its identity, so logging, comparison and `ref.path` are unchanged.
- **Remembered entities return after an unexpected shard death** (#894).  When
  a shard actor died outside a handoff, ownership stayed put — which is what
  lets the next message re-create the shard — but that also meant neither
  `onRegister` nor `tryAllocate` ever ran again, and those were the only paths
  that shipped the remembered registry.  The shard came back empty, only the
  entity named by the next message returned, and the coordinator kept listing
  the rest with `started` events that would never see a `stopped`.  The region
  now asks the coordinator to re-send what it remembers.
- **`preRestart` never stopped children, whatever its documentation said**
  (#899).  `Actor.preRestart`'s JSDoc, the `onRecreate` call site and the
  supervision page all promised the default stops the actor's children.  It only
  ever called `postStop()` — children belong to the cell, which outlives the
  instance being replaced.  No behaviour changed here; the documentation now
  matches, and the consequence it was hiding is spelled out: because
  `postRestart` re-runs `preStart` with the previous incarnation's children
  still in place, an actor that spawns a **named** child in `preStart` fails its
  first restart with `Child name '<name>' is not unique`.  Spawn anonymously, or
  stop the children yourself in an overridden `preRestart`.  Both the survival
  and the collision now have tests.
- **The sharding-failover churn test no longer measures the scheduler**
  (#902).  `tests/multi-node/sharding-failover.test.ts` → "burst of asks
  during repeated coordinator state churn" drove asks for a fixed 1.5 s and
  then asserted on how many it had managed (`replies > 0`, `replies +
  failures > 20`) — a **count** bounded by a **wall clock**.  Instrumenting
  the loop in a full-suite run showed the ask costing p50 0 ms and max 4 ms
  while `Bun.sleep(5)` cost 15–16 ms, one full Windows timer quantum (#477):
  the sample count was ~100 % timer granularity, leaving `> 20` a mere 4.6×
  over a floor that says nothing about sharding.  One stalled event loop then
  reds the build two ways — the window yields under 21 iterations, or the
  first ask hits its own 4 s timeout and, 4 s being longer than the 1.5 s
  window, the loop exits with `replies` still 0.  The burst is now bounded by
  a fixed count, and the graceful leave is keyed to the driver's progress
  rather than to a sleep — which also fixes an interleaving that was
  machine-dependent, landing the leave after ~13 asks on an idle machine but
  after the first one on a stalled machine.  Ruled out along the way: the
  #892 passivation defaults cannot fire here (both sweeps share one timer
  whose first tick is at 300 s, against a 30 s test timeout), and graceful
  leave does not in fact race in-flight asks at the wire — a probe firing the
  leave at t=0 saw 0 failures across ~1 400 asks.  Test-only change; no
  runtime behaviour changed.

### Security

- **BREAKING — the cluster TLS listener actually requests a client certificate
  now** (#565).  `requestCert` hard-defaulted to `false` in both the Node and
  the Bun adapter, and `requestClientCert` was never set to `true` anywhere in
  `src/`, `examples/` or `docs/`.  On a server, `rejectUnauthorized` does
  nothing unless `requestCert` is on — so the mTLS recipe the *Cluster
  security* page documents, `{cert, key, ca, rejectUnauthorized: true}`,
  produced server-authenticated TLS only.  Since the `hello` handshake carries
  no credential of its own, that left the peer certificate — the cluster's only
  admission control — unrequested: anyone who could reach the remoting port
  completed the handshake with no certificate at all and then claimed whatever
  node identity they liked.  This is also the mitigation the #896 note below
  leans on, so until now that note promised more than the transport delivered.
  `requestClientCert` now **defaults to `ca !== undefined`** — a trust bundle
  on a cluster listener has no other purpose — and the option object both
  adapters hand to the runtime is built in one shared place, since the defect
  survived review by being spelled out identically twice.
  Two configurations are now refused at bind time rather than started in a
  weaker state than they read as: `requestClientCert: true` with no `ca`, and
  **mutual TLS on Deno**, where `Deno.listenTls` cannot request a client
  certificate and the dialer sends none, so peers would be unauthenticated in
  both directions.
  **Migration:** a Node or Bun cluster already passing `ca` starts demanding
  peer certificates — which is what its configuration always claimed — so every
  node must present one signed by that CA.  Set `requestClientCert: false` to
  keep one-way TLS.  A Deno cluster configured with `ca` no longer binds; run
  it on Node.js or Bun for mTLS, or opt out explicitly.
- **A `ClusterClient`'s own wire identity no longer comes from `Math.random()`**
  (#565 sweep).  A client without an explicit `clientIdentity` names itself
  `50_000 + Math.floor(Math.random() * 15_000)`, and that port goes straight
  into the `NodeAddress` it announces on the wire and keys the cluster's
  `byPeer` map — so it is an address, not a coin flip, and a peer that can
  predict it can address, impersonate or pre-claim the client's slot.
  `Math.random()` is not a CSPRNG and its state is recoverable from a handful
  of observed outputs; the comment above the line claimed hrtime-derived
  randomness, which the code did not do.  It is now drawn with
  `crypto.getRandomValues` across the whole IANA ephemeral range — the old
  15 000-slot window also made an accidental collision likely at a few dozen
  clients per process, which was a correctness problem on its own.  The last
  of the generated-identifier findings this release sweeps up (#896, #897,
  #898, #895).
- **Quorum correlation ids in `DistributedData` are no longer guessable**
  (#896).  `nextPendingId()` returned `p<Date.now()>-<counter>`.  That value
  travels on the wire and the peer echoes it back on its acknowledgment, so an
  id that can be guessed is an id whose acknowledgment can be forged —
  satisfying a quorum write or read that no peer actually confirmed.  A
  timestamp is observable and the counter starts at 1 in every process, which
  made guessing arithmetic rather than search.  It is now sixteen random hex
  characters.  (The counter was also module-global rather than per-system, so
  two systems in one process shared a sequence.)  Reachable only by something
  that can already send cluster wire messages, which mTLS on the transport
  excludes — see *Cluster security* — so this is defence in depth, not an open
  door on a hardened cluster.
- **Filesystem object-storage temp paths no longer come from `Math.random()`**
  (#898).  The atomic-write temp file was named
  `<key>.tmp.<pid>.<Date.now()>.<Math.random()>`; the clock is observable and
  `Math.random()` is not a CSPRNG, so a local process sharing the directory
  could predict the path and pre-create it or plant a symlink there.  The
  suffix is now drawn from `crypto.getRandomValues`.

### Documentation

- **`fundamentals/spawning` no longer contradicts itself about constructor
  arguments** (EN + DE, #907).  The page declared `Worker` with two required
  constructor arguments, showed `system.spawn(Worker, 'worker-1')` as the form
  that is *rejected* — and then used that identical line fifty lines later as
  the correct naming example, with three further samples calling
  `new Worker(database)` one-armed against the two-argument class.  A reader
  copying the naming example got exactly the error quoted above it.  `Worker`
  now takes the one dependency every other sample on the page passes it, and
  the sections that are not about arity use the zero-argument `Greeter`.
- **The docs API-drift guard covers the `Props` removal** (#907).
  `docs/scripts/check-api-drift.mjs` runs in CI and its own header says to add
  a pattern whenever an API is renamed or removed — the largest removal the
  project has made added none, which is how a broken call shape survived in the
  docs long enough to be filed.  It now rejects `Props.create`, `Props.empty`,
  `spawn(props`, `entityProps`, `singletonProps`, `childProps`, `routeeProps`,
  `typedProps`, `behaviorFor`, `asInternal(`, `BackoffSupervisor.props` and
  `ClusterRouter.props`, with a per-pattern allowlist so the Akka migration
  pages keep Akka's own spelling in their `scala` / `csharp` fences.
- **`fundamentals/props` is now `fundamentals/spawning`** (EN + DE, #547) —
  rewritten around what the reader is doing rather than around a type.  The
  old slug redirects.

- **The docs lead with the actor class at every spawn site** (EN + DE, #547)
  — the samples follow the code trees onto `spawn(MyActor)`, and the prose
  that described them followed.  `quickstart` and `fundamentals/actor` were
  the sharpest mismatch: both called the argument "the factory" directly
  above a sample passing a class, and `actor.mdx` carried a dangling "`...`
  wraps the factory + supervisor strategy" sentence where `Props.create(…)`
  used to be named.

## [0.12.2] — 2026-08-04

### Fixed

- **BREAKING — persistence stores no longer silently corrupt rich payload
  types** (#888).  Every journal, snapshot store and durable-state store wrote
  payloads with bare `JSON.stringify`, so a persisted `Set`/`Map` recovered as
  `{}`, a `Date` as a string, a `Uint8Array` as an index-keyed object, and a
  `bigint` threw — and because the write path folds the original object, the
  corruption only surfaced on the next recovery.  Payloads now use the tagged
  JSON tree format `JsonSerializer` already used (`__date__`, `__bytes__`,
  `__map__`, `__set__`, `__bigint__`, plus a new `__literal__` escape so user
  data shaped like a tag round-trips as data), on every backend.
  **Migration:** none for readers — rows written by older versions decode
  unchanged.  Rows written from this version on carry tag objects where plain
  JSON would corrupt the value, so *older* framework versions (and
  non-actor-ts JSON consumers) reading *new* rows see the tag shape instead of
  a bare value.  `JsonSerializer` also now honours `toJSON()`, reports
  circular references as a `SerializationError` naming the key path instead of
  overflowing the stack, and only interprets a tag when it is an object's sole
  own key.

### Changed

- **The in-memory journal / snapshot store / durable-state store round-trip
  payloads through the same codec as the real backends** (#888).  Dev/prod
  parity: an event that cannot be stored fails in the test suite instead of on
  the first production recovery, and mutating an object after `persist` no
  longer aliases into the store.  Like the real stores, they still return and
  publish the caller's original objects.

### Added

- **Full type fidelity for stored payloads and `JsonSerializer`** (#889).
  `NaN` / `Infinity` / `-Infinity` / `-0`, `undefined` in value positions
  (array slots, `Set` members, `Map` entries — object properties still drop,
  matching `JSON.stringify`), `RegExp` (source + flags), `URL`, `Error`
  (name + message + cause, incl. subclass constructors and
  `AggregateError.errors` — deliberately no stack, which would leak
  filesystem paths into long-lived rows) and every typed array / `DataView` /
  `ArrayBuffer` now round-trip through every store and the JSON serializer.
  `Number`/`String`/`Boolean` wrapper objects unwrap like `JSON.stringify`;
  `Promise`, `WeakMap` and `WeakSet` throw a `SerializationError` at persist
  time instead of being silently stored as `{}`.
- **Per-store `serializer` option** (#888, the persistence half of #450).
  Every journal / snapshot store / durable-state store options builder — and
  every `Register<X>Plugins` bundle — takes `withSerializer(serializer)` to
  route a custom `Serializer` into stored rows via a self-describing
  `__serialized__` framing.  Default-format rows and framed rows coexist in
  one stream; reading a framed row without (or with a mismatching) serializer
  fails with an actionable `SerializationError`.  Registry auto-binding and
  the cluster wire remain tracked in #450.

## [0.12.1] — 2026-08-03

### Changed

- **BREAKING — `ReplicatedEventSourcedActor` no longer takes a `Cluster`, and
  `replicaId` now has a default** (#833).  Both existed only because the actor
  could not reach its own cluster; now that it can, they are boilerplate every
  subclass was copying:

  ```ts
  // before
  class Counter extends ReplicatedEventSourcedActor<Command, Event, State> {
    readonly persistenceId = 'counter-1';
    readonly replicaId: string;
    constructor(cluster: Cluster) {
      super(cluster);
      this.replicaId = cluster.selfAddress.toString();
    }
  }
  new Counter(cluster);

  // after
  class Counter extends ReplicatedEventSourcedActor<Command, Event, State> {
    readonly persistenceId = 'counter-1';
  }
  new Counter();
  ```

  **Migration:** drop the `cluster` constructor argument and the `super(cluster)`
  it fed (a subclass with no other dependencies can drop its constructor
  entirely).  `replicaId` defaults to `this.cluster.selfAddress.toString()`,
  which is what every in-repo subclass set it to by hand.

  A **custom** `replicaId` becomes a getter — as a field it now collides with
  the base-class accessor (`TS2610`):

  ```ts
  override get replicaId(): string { return process.env.REPLICA_ID!; }
  ```

  Override it when the id must survive a re-address (a fixed region name, say);
  two replicas that ever share an id dedupe each other's events away, so the
  node-address default is the safe one.  The actor must now run on a system
  that joined a cluster — it did before too, it just took the cluster by hand.

### Added

- **`actor-ts.sharding.max-entities` — the per-node entity cap is configurable**
  (#835).  `maxEntities` LRU-passivates the coldest entity when a node is at
  capacity; it was the one passivation trigger with no HOCON form, which left
  the time bound (`passivation-idle`) tunable per environment and the memory
  bound code-only.  An entity count is exactly the value that differs between a
  laptop and a 64 GB production node:

  ```hocon
  actor-ts.sharding {
    passivation-idle = 2 minutes
    max-entities     = 50000        # 0 = no cap (the default)
  }
  ```

  Same layering as the rest of the block — an explicit `withMaxEntities(…)`
  still wins — and the reference value is `0`, so nothing changes for anyone
  who does not set it.

- **An actor can reach its own `Cluster`** (#833).  `this.context` and
  `this.system` were always there; the `Cluster` was the one runtime object
  that had to be threaded in by hand — through a constructor argument, an
  options field, or a captured closure — and a framework-constructed actor (a
  sharded entity, a singleton) has no call site to thread it through at all.

  ```ts
  class CartEntity extends Actor<CartMessage> {
    override preStart(): void {
      // No constructor argument, no closure, no options field.
      this.log.info(`cart ${this.entityId} on ${this.cluster.selfAddress}`);
    }
  }
  ```

  Three accessors, all additive:

  - `system.cluster` — `Option<Cluster>`, filled in by `Cluster.join`.
  - `this.context.cluster` — the same `Option`, for an actor that must also
    run unclustered.
  - `this.cluster` — unwrapped, throwing when the system never joined one, on
    the same "this code already knows" trade-off as `this.entityId`.  The
    error names `Cluster.join` and the `Option` form rather than just the
    symptom.

  `cluster.sharding` / `cluster.singleton` come along with it, so an actor can
  start a region or a singleton from the inside.  All three read through to
  the system on every access: an actor that outlived the join sees the
  cluster, and a system that rejoined after `leave()` resolves to the new
  instance rather than the dead one.  It stays an `Option` deliberately —
  a cluster binds a transport and starts gossip/heartbeat/failure-detection
  timers, so a local-only system must never grow one on demand.

  Registration is a new `ClusterExtension` (`clusterOf(system)`, mirroring
  `metricsOf` / `tracerOf`) that `Cluster.join` is the sole writer of.  Core
  keeps its runtime independence from the cluster layer the same way
  `EntityContext` does: type-only import of `Cluster`, value import of just
  the extension id.

- **A sharded entity can read its own `entityId`** (#832).  The id an entity
  was routed by used to stop at the `Shard` that spawned it — the entity could
  only get it back by slicing the `entity-` prefix off its actor path, which is
  boilerplate at every call site and, worse, lossy: actor names have a
  restricted alphabet, so `Shard` folds everything outside `[A-Za-z0-9_-]` to
  `_` (#568) and `user:42` and `user/42` both read back as `user_42`.

  ```ts
  class CartEntity extends PersistentActor<CartCommand, CartEvent, CartState> {
    // one journal stream per entity, from the id sharding actually routed
    override get persistenceId(): string { return `cart-${this.entityId}`; }
  }
  ```

  Three accessors, all additive:

  - `this.entityId` — the value `extractEntityId` returned, verbatim.
  - `this.entity` — that plus `typeName` and `shardId` (`EntityContext`).
  - `this.context.entity` — the `Option` form, `None` for a non-entity actor;
    the two getters throw there instead.

  Available from `preStart` onwards — early enough for a `PersistentActor` to
  build its `persistenceId` before recovery — and stable across a restart.  It
  is a getter, not a field: the context is attached after construction, so a
  field initializer would still run too early.  The identity sits on the entity
  and nowhere else; an entity's own children get `None`.

  `Props.withEntity({ entityId, typeName, shardId })` is the same door
  `ClusterSharding` uses, left public so an entity can be unit-tested without a
  cluster around it.  `ShardedDaemonProcess` no longer regex-parses its own
  actor name to find its daemon index, and the chat example's two
  `PersistentActor`s drop their path-stripping getters — the direct-message
  channel's `persistenceId` is now built from the real `|`-separated pair id
  rather than the sanitized one.

### Documentation

- **A new page publishes the complete `reference.conf`** — every setting the
  framework ships, verbatim, so "what can I configure?" has one exhaustive
  answer instead of a curated example.  The Configuration page keeps
  explaining what each key does and links across.

  The copy is pinned to the source: a test compares the page's HOCON block to
  `REFERENCE_CONF` and fails on any drift, in both languages.  A published
  default that no longer matches the shipped one is the same lie as a
  documented key nothing reads, which is what the rest of this release is
  about.

### Fixed

- **A guard against the next dead config key** (closes #653).
  `tests/unit/config/NoDeadConfigKeys.test.ts` asserts, for every leaf in
  `REFERENCE_CONF`, that it is reachable from `ConfigKeys` *and* referenced
  from somewhere under `src/`.  A key added to the reference config without a
  reader now fails CI with a message naming the key.

  Knowingly-unimplemented keys go in `KNOWN_DEAD_KEYS` with the issue that
  will remove them — the list has exactly one entry (`remote.tls.enabled`,
  #591), and the guard also checks that each excused key still *exists*, so
  an exception cannot outlive its key.

  The check proves a reference rather than a correct read: a key mentioned in
  dead code would still pass.  That ceiling is deliberate — the defect worth
  catching is "declared and never wired up", and modelling config flow
  through the options mergers would be a lot of machinery for the rest.

  `PersistenceExtension` moved its two raw path literals onto
  `ConfigKeys.persistence.*` along the way; it was the last reader in `src/`
  still spelling paths by hand.

- **`actor-ts.system.name`, `actor-ts.worker-cluster.*` and
  `actor-ts.coordinated-shutdown.*` are actually read** (part of #653) — the
  last of the inert blocks.

  `ActorSystem.create()` now takes an **optional** name: omit it and the
  system is named from `actor-ts.system.name`, falling back to `"default"` as
  before.  `create('billing')` still wins.

  `CoordinatedShutdown` picks up all three of its keys.
  `default-phase-timeout` seeds the 12 canonical phases (it was hardcoded to
  `5_000`, now `DEFAULT_PHASE_TIMEOUT_MS` in `util/Constants.ts`).
  `terminate-actor-system = false` drops the built-in terminator task while
  leaving the phase and any user tasks in it intact — for a host process that
  owns the system's lifetime.  **`exit-jvm` is renamed to `exit-process`** —
  it is a JVM-ism in a TypeScript framework, and it now does something: with
  it on, `process.exit(0)` runs once the pipeline completes, which is how you
  stop a lingering handle from making a finished shutdown look like a hang.

  **The `worker` block is now `worker-cluster`, and `count` is `workers`** —
  named after `WorkerClusterOptions`, whose fields they fill in, and in
  lockstep with them.  `WorkerCluster.spawn` is a static with no `ActorSystem`
  in scope, so it loads the config chain itself (the same one
  `ActorSystem.create` uses).  An unknown `restart-policy` is now rejected by
  `WorkerClusterOptionsValidator` instead of falling through the internal
  `match` and silently meaning "never restart" — that check was missing for
  code-supplied values too.

- **`actor-ts.http.backend` and `actor-ts.http.shutdown-grace-period` are
  actually read** (part of #653).  `newServerAt(...).bind()` hardcoded
  `new FastifyBackend()` and the auto-registered shutdown task called
  `unbind()` with no grace period at all — so the documented 5 s drain window
  was, in practice, zero.

  ```hocon
  actor-ts.http {
    backend = "hono"
    shutdown-grace-period = 10s
  }
  ```

  `useBackend(...)` still wins; the config only decides what `bind()` picks
  when the builder was given nothing.  An unrecognised name now fails the
  `bind()` with a `ConfigError` naming the key and the accepted values,
  instead of silently falling back.  Express and Hono are imported
  dynamically, so naming neither keeps both out of your bundle.

  The reference comment advertised **`fastify | bun | express`** — a `bun`
  backend that has never existed, and no mention of the Hono backend that
  does.  Corrected to `fastify | express | hono`, and `backend = "bun"` now
  fails loudly rather than being ignored.

  **`shutdown-grace-period`'s published default moves `5s` → `0ms`**, the same
  correction as `max-frame-bytes`: `unbind()` has always been called with no
  grace period, so `0` — force as soon as the server closes — is what every
  deployment has actually been running.  Making the documented `5s` live
  turned out to cost real time rather than none: where a backend's `close()`
  cannot settle (Express with a live WebSocket on Bun), the window is not an
  upper bound that resolves early but a deadline that is always reached, so
  every such shutdown would have gained five seconds.  Raise it deliberately
  if you want in-flight requests to finish.

- **The `actor-ts.cluster.*` and `actor-ts.remote.*` config blocks are actually
  read** (part of #653; closes #754).  Same defect as the sharding block: the
  keys shipped in `reference.conf`, the Configuration page documented them, and
  `Cluster.join` took every value from `ClusterOptions` alone.  `Cluster.join`
  now layers them underneath, so **explicit options > HOCON > built-in
  defaults** holds here too.

  The bind address comes with it, which is what the docs have shown all along:

  ```hocon
  actor-ts.remote.tcp {
    host = "0.0.0.0"
    port = ${?ACTOR_TS_PORT}   # env-var substitution — now actually applied
  }
  ```

  One consequence worth knowing: `host` / `port` are validated on the *merged*
  settings, and the reference config supplies both, so a `Cluster.join` that
  omits them no longer throws `OptionsError` — it binds `0.0.0.0:2552`.  That is
  the point of the feature, but it turns a startup error into a running node,
  so pin the address in config if you were relying on the throw.

  `failureDetector` merges **per threshold**, not per object: setting only
  `downAfterMs` in code keeps `heartbeat-interval` and `unreachable-after` from
  the file.  A shallow merge would have silently reset the two the caller never
  mentioned.

  **`remote.max-frame-size` → `remote.max-frame-bytes`, and its documented
  default was wrong.**  The key is renamed to match the field it feeds
  (`ClusterOptions.maxFrameBytes`, new, with `withMaxFrameBytes(…)`), and the
  reference value moves `1M` → `16M`.  The `1M` in the docs was never the
  effective cap — nothing read the key, so every cluster has always run at
  `DEFAULT_MAX_FRAME_BYTES` (16 MiB).  Publishing `16M` states what the
  framework actually does; the alternative, keeping `1M` now that it is live,
  would have tightened every existing cluster's wire cap 16× on upgrade and
  broken anyone sending large envelopes.  **If you sized your deployment
  against the documented 1 MiB, set `max-frame-bytes = 1M` explicitly — it now
  works.**  The cap applies to the transport the cluster builds for itself; an
  injected `withTransport(…)` keeps the cap it was constructed with.

  **Two dead keys removed rather than wired:**

  - `cluster.leader-election = "lowest-address"` — the leader is always the
    lowest-addressed up-member and there is no second strategy, so the key
    documented a choice the framework does not offer.
  - `remote.transport = "tcp"` — a custom transport is an object passed to
    `withTransport(…)`, never a string; the in-memory transport is a test
    detail. `ConfigKeys.transport` (`'actor-ts.transport'`) went with it — it
    matched no documented path and was referenced nowhere.

  `remote.tcp.hostname` is now `remote.tcp.host`, matching `ClusterOptions.host`
  and the `withHost(…)` that sets it.  All four renamed/removed keys were inert,
  so no working configuration changes meaning — but a config file that named
  them was never doing anything anyway.

  `remote.tls.enabled` stays dead **on purpose** (#591): it is now flagged as
  such in the docs and named in the dead-key guard's exception list, rather than
  being quietly wired to a TLS implementation that does not exist yet.

- **The `actor-ts.sharding.*` config block is actually read** (#834, part of
  #653).  `reference.conf` shipped all five keys and the Configuration page
  documented them with their defaults, but nothing in `src/` ever looked at
  them: every sharding setting came from `ShardingOptions` alone.  An operator
  who wrote

  ```hocon
  actor-ts.sharding.passivation-idle = 2 minutes
  ```

  got no passivation whatsoever — entities stayed resident forever, with no
  warning, because the value was never read rather than rejected.
  `examples/config/application.conf` sets exactly this key, which made it look
  like a working example.

  `ClusterSharding.start` now layers the block under the caller's options, so
  the precedence the rest of the framework documents — **explicit options >
  HOCON > built-in defaults** — finally holds for sharding too, per field:

  ```ts
  // actor-ts.sharding: number-of-shards = 128, passivation-idle = 2 minutes

  const shardingOptions = StartShardingOptions.create<CartCommand>()
    .withTypeName('cart')
    .withEntityProps(Props.create(() => new CartEntity()))
    .withExtractEntityId((command) => command.entityId)
    .withNumShards(256);

  cluster.sharding.start(shardingOptions);
  // numShards 256 (explicit), passivationIdleMs 120_000 (config file)
  ```

  All five keys land: `number-of-shards`, `remember-entities` and
  `passivation-idle` reach the region, `rebalance-interval` and
  `hand-off-timeout` the per-type coordinator — `start` is the only call that
  feeds both, which is why the merge lives there and not in `ShardRegion`.
  The keys are now reachable from `ConfigKeys.sharding`, and an explicit
  `undefined` counts as "not set" and falls through to the file instead of
  shadowing it.

  **No behaviour change without a config file:** the reference values are
  identical to the built-in fallbacks (64 / 2s / 10s / false / 0ms), and a
  regression test pins them together so wiring the block cannot drift into
  changing defaults.

  Internally, `mergeOptions` / `stripUndefined` moved from
  `io/broker/BrokerOptions.ts` to `util/OptionsMerge.ts` — the precedence rule
  is project-wide, and sharding is its second caller.  Not a public export;
  no import path in the published API changes.

  The other dead blocks — `cluster.*`, `remote.*`, `http.backend`, `worker.*`,
  `coordinated-shutdown.*` — remain open under #653.

## [0.12.0] — 2026-08-01

### Added

- **`SingletonKey` and `ShardKey` — typed, class-declared identities** (#523).
  A singleton's name and its message type used to be two unlinked facts: the
  `typeName` string went one way, the `<T>` generic another, and
  `get<T>(typeName)` re-asserted the type with no checking at all.  Both keys
  tie them together the way `ServiceKey` already did for the Receptionist, and
  both are meant to be declared on the actor itself:

  ```ts
  class UserRepository extends PersistentActor<UserRepositoryCommand, Event, State> {
    static readonly singleton = SingletonKey.of<UserRepositoryCommand>('user-repository');
    constructor(private readonly users: ActorRef<UserCommand>) { super(); }
  }
  class UserActor extends PersistentActor<UserCommand, Event, State> {
    static readonly shard = ShardKey.of<UserCommand>('user', (command) => command.userId);
  }

  const users = cluster.sharding.start(UserActor);
  const repository = cluster.singleton.start(UserRepository, () => new UserRepository(users));
  ```

  A static is the carrier because TypeScript's `implements` constrains only
  the **instance** side of a class — there is no `static implements`, and
  `abstract static` is a compile error — so a `SingletonActor` marker
  interface would be structurally empty and check nothing.  It is deliberately
  not shipped.  A static also composes with any base class, which matters
  because these actors are usually `PersistentActor`s and TypeScript has
  single inheritance.  `ShardKey` carries the `extractEntityId` alongside the
  name (identity is the name alone, so a lookup-only node can omit the
  extractor); an extractor in options still overrides it.  The sharding half
  is purely additive — every existing calling shape keeps working.
- **`ClusterSingleton.ref(key)` — a singleton ref without hosting it** (#523),
  the counterpart to `ClusterSharding.startProxy` that the singleton API never
  had.  Works on a node that never calls `start`.  `ref` and `start` return
  the same memoised ref per key, and the local manager is resolved per
  delivery — so a node that calls `ref` first and `start` later keeps the same
  ref, which simply begins delivering locally instead of over the wire.  A
  leader that never called `start` hosts nothing, so its ref dead-letters with
  a single latched warning rather than buffering: unlike "no leader elected
  yet", that state does not heal on its own.
- **`cluster.singleton`** (#523) — the facade mirroring `cluster.sharding`,
  plus `ClusterSingleton.get(system, cluster)` for callers holding the two
  separately, and `stop(key)` / `managerFor(key)` / `isStarted(key)`.
- **`WorkerClusterOptions.withBackend()` and the same option on
  `ParallelMultiNodeSpecOptions`** (#520) — spawn workers through a given
  `WorkerBackend` instead of the one `getWorkerBackend()` detects.  For a
  runtime the detection does not know, and for driving fake workers in a test
  without mocking a module.  `WorkerBackend` is exported from the package root
  now that it is part of a public options shape.  See *Fixed* for why the seam
  had to exist.
- **Shard introspection: `ClusterSharding.shards()`, `shardRefFor()`, and the
  `StartEntity` / `GetShardStats` shard commands** (#151).  The sharding
  protocol had no query message of any kind — `ShardCoordinator` handled seven
  variants, none of them a `Get*` — so "which shards exist, and where?" had no
  answer short of the `/cluster/shards` management endpoint, which reads a
  DistributedData snapshot and only works if you opted into a
  `coordinatorStateStore`.  The multi-node tests went as far as reaching into
  the coordinator's private fields.  `shards(typeName)` now answers
  cluster-wide with a `ShardInfo` per placed shard: shard id, hosting node,
  region path, live entity count, whether it is local, **and a usable `ref`**.
  The coordinator owns the shard map but not the entity counts — only the
  hosting region knows those — so it fans `GetShardRegionStats` out to the
  registered regions and joins the answers against `shardHome`; a region that
  misses the deadline contributes `0` rather than failing the call.  Refs are
  materialised on the *asking* node, so the wire payload stays plain data and
  no ref has to survive serialisation.  `shardRefFor(typeName, shardId)` hands
  back one shard's ref and allocates the shard if it had no home yet, exactly
  as a first message for it would have.  Because a shard is a real actor now,
  that ref is the real thing — the local actor, or a `RemoteActorRef` at
  `/user/sharding-<type>/shard-<n>` — so `tell` works from anywhere; `ask` on
  it works when the shard is local, and cross-node queries pass their own
  actor's `self` as `GetShardStats.replyTo` (a one-shot ask ref is not
  addressable from another node, which is why the sharding protocol correlates
  replies by path in the first place).
- **`ClusterSharding.entityRefFor(typeName, entityId)`** (#512) — a
  location-transparent handle to a single entity, the counterpart to the region
  ref that sharding has handed out until now.  With only a region ref, every
  message has to embed its own entity id so `extractEntityId` can dig it back
  out; the identity of the entity is implicit and there is nothing you can pass
  to another component that means "this one entity".  `entityRefFor` returns an
  ordinary `ActorRef`, so `tell` and `ask` work as usual, and it wraps each
  message in an id-addressed envelope that the region routes without consulting
  `extractEntityId` at all — the message type no longer has to know how it is
  routed.  Synchronous, because the shard is `hash(entityId) % numShards` and
  needs no lookup; location-transparent, because it routes through the local
  region, which already knows how to buffer for an unplaced shard and how to
  forward across nodes.  A proxy region is enough to hand one out.
- **BREAKING — a shard is a real actor now: `Region → Shard → Entity`** (#511).
  A shard used to be nothing but a number key in `ShardRegion`'s maps, with the
  entities spawned as direct children of the *region*.  That left "give me an
  `ActorRef` for shard 7" with no referent at all, made handoff a
  fire-and-forget loop that reported `HandOffComplete` *before* the entities had
  actually stopped, and hid the shard dimension from the actor tree entirely.
  Entities are now grandchildren of the region:
  `/user/sharding-<type>/shard-<n>/entity-<id>` — **migration:** anything that
  resolved an entity by path has to insert the `shard-<n>` segment (the shard id
  is `hashShardId(entityId, numShards)`); `ActorPath.parent` of an entity is now
  its shard.  The new `Shard` actor owns the entity lifecycle only — spawn,
  watch, stop, and the buffer that holds traffic for an entity on its way out.
  Routing, buffering, coordinator registration and the ask-correlation machinery
  stay in the region, and so does the passivation *policy*: both the idle sweep
  and the `maxEntities` LRU are decided there and executed by the owning shard
  through a `PassivateEntity` command.  Keeping the policy one level up is what
  lets `maxEntities` go on meaning "per node" instead of quietly becoming "per
  shard" — a knob that would otherwise have changed meaning without changing
  name.  Handoff is now simply "stop the shard": the runtime terminates the
  entities underneath and only then delivers `Terminated`, so `HandOffComplete`
  finally means what it says.  Shards are created eagerly when the coordinator
  assigns one, not lazily on the first message, so an allocated-but-empty shard
  still has a live ref.  The cost was accepted deliberately and is not small:
  every message to a local entity now takes one extra node-local hop, and
  `benchmarks/cluster/sharded-roundtrip.ts` measures it as **~40k → ~29k ask/s
  on one node (−28 %, +9 µs per ask)** and **~42k → ~25k on two nodes (−41 %,
  +16 µs)** — medians of three runs each, on the same machine.  If you are
  routing hot-path traffic through a region and were relying on the old
  numbers, this is the change that moved them.
- **CI gate for the benchmarks: `typecheck:bench` + `bench:smoke`** (#506).
  Nothing looked at `benchmarks/` at all — `bun run typecheck` uses the build
  tsconfig, which deliberately excludes them, and `test.yml` does not even
  trigger on `benchmarks/**` — so a `src/` change that orphaned a benchmark was
  invisible from the benchmark side of the diff.  Two checks, in a new
  `benchmarks` workflow that also triggers on `src/**`:
  `bun run typecheck:bench` compiles `src` + `benchmarks` against the new
  `tsconfig.bench.json` (deliberately narrower than `tsconfig.dev.json`, which
  also pulls in `tests/` and `examples/` — a tight scope is fast and, unlike the
  dev config, green, so it can actually gate), and `bun run bench:smoke` runs
  every suite for real.  The new `ACTOR_TS_BENCH_SMOKE=1` collapses each case to
  one unwarmed iteration, so the full suite finishes in ~30 s; the numbers it
  prints are noise, the point is that each suite still executes.  The typecheck is
  the stricter of the two for a missing export — that is a compile error even when
  the imported binding is never called, whereas Bun silently elides an unused
  named import at runtime.  `run-all.ts` gains `--exclude=<group>`, and the
  workflow excludes `worker` for the same reason the worker-thread multi-node
  suites are quarantined on hosted runners (Bun there cannot respawn functional
  worker threads after the first).
- **`--devtools-host` for the examples** (#492) — the shared `--devtools` wiring
  bound `127.0.0.1` and only let you move the port, which is unreachable when the
  browser is not on the machine running the example (a container, a VM, a WSL or
  remote dev box).  `--devtools-host=<host>` / `DEVTOOLS_HOST` now sets the
  interface.  A non-loopback host there implies `allowRemote`, so DevTools binds
  and logs its "reachable without auth" warning rather than refusing on a rule
  written for applications; the free-port probe binds the same interface it is
  asking about, and a wildcard bind (`0.0.0.0`, `::`) is reported as a loopback
  URL because `http://0.0.0.0:9333` is not an address a browser can open.
- **Package-health CI: publint, arethetypeswrong and knip** (#416).  Three
  failure modes the test suite structurally cannot see, because they are
  properties of the published tarball rather than of the code: a broken `exports`
  map or a `files` list missing the built output (publint); declarations that
  resolve for the author but not for a consumer under their module resolution
  (attw); and a module reachable from no entry point, or an import with no
  manifest entry behind it — which works locally and breaks on a fresh install
  (knip).  All three pass today, so this locks in the current state rather than
  fixing a defect.
  Two configuration notes, since both were judgement calls.  attw runs with
  `--profile esm-only`: this package ships no CJS, so the "ESM (dynamic import
  only)" note for a CJS consumer describes the design and has no fix short of
  shipping CJS.  And knip is unusable here unconfigured — it reports ~341
  "unused files" and several hundred duplicate exports, because its defaults
  assume an *application*, where anything unreachable from one entry is dead and
  two names for one value is a mistake.  Neither holds for a library whose whole
  surface is its exports, and one of them is a documented convention: AGENTS.md
  *requires* every options family to export `XOptions` as both a type union and a
  value alias for the builder, in ~60 files.  `knip.jsonc` therefore turns off the
  rules that fight the project and keeps the ones that catch real problems, with
  the reasoning recorded against each.

- **`"sideEffects": false`** (#415) — nothing in this package does work at import
  time, so a consumer's bundler may drop whatever it does not reference.  Backed
  by a test rather than asserted: it bundles a narrow import and measures what
  survives.  `import { Actor }` comes out at **~1.5 KB** against **~2.3 MB** for
  the whole barrel, and the embedded DevTools UI — the largest single artefact in
  the tree — is absent.  A companion test proves that canary is a real one by
  showing the UI *does* appear when the DevTools entry point is imported;
  without it the assertion would keep passing even if tree-shaking broke.

- **`ActorPath.toString()` is memoized** (#412).  Every field is `readonly` and
  the parent chain is fixed at construction, so the rendering cannot change once
  computed — and it is called far more often than it looks: `equals` renders
  *both* sides, ref comparison goes through `equals`, and dead-letter routing,
  the receptionist and the DevTools taps all key on the string.  A deep path was
  re-walking its ancestors and re-joining an array on every one of those.
  Computed lazily rather than in the constructor, since a path is created on every
  spawn, including for actors whose path is never rendered.

- **`SqliteDurableStateStore`** (#392) — the last gap in the backend matrix.
  SQLite shipped a journal and a snapshot store but no durable state, so it was
  the only family whose three-component set was incomplete;
  `LibSqlDurableStateStore` covered the remote case and said so in its own
  JSDoc.  The schema is the SQLite dialect's, identical to libSQL/Turso and
  Cloudflare D1, so a database moves between a local file and either without a
  migration.
  The enabling piece is a new **`SqliteClient`** — a `SqlPool` adapter over the
  local driver.  Local SQLite was the one family without one, because
  `SqliteJournal` predates the relational base layer and drives `SqliteDb`
  directly while every other backend has an `XClient.ts`.  Two things made it
  more than a wrapper.  The driver is **synchronous and split** — `.all()`
  returns rows, `.run()` returns `changes`, and asking for the wrong one throws
  on `better-sqlite3` — so statements are classified before they run.  And its
  transactions are **real**, which means they need serializing: one `SqliteDb`
  is one connection, so without a queue a second `withTransaction` could issue
  its `BEGIN` while the first was still awaiting, collapsing the two into one
  transaction that commits early.
  Because it talks to a file rather than over HTTP, `withTransaction` is a
  genuine `BEGIN IMMEDIATE … COMMIT`.  `SqlPool` specifies isolation as
  adapter-defined so the HTTP-fronted stores can offer *less*; this one offers
  more than the contract requires.  `IMMEDIATE` rather than the default
  deferred, so a read-then-write sequence cannot fail to upgrade its lock
  partway through.  A remote URL is refused at construction with a pointer to
  `LibSqlDurableStateStore`, since the local driver cannot open one and
  silently creating a *file* by that name is the confusing outcome.
  It is also the first durable-state harness in the shared contract suite to run
  against a **real SQL engine** rather than a fake — an in-memory database needs
  no container.
  Follow-ons filed rather than left implicit: **#491** (collapse `SqliteJournal`
  onto `RelationalJournal`, now possible) and **#490** (the Cassandra-LWT half of
  #392).

- **A by-tag projection accepts a full `TagFilter`** (#393).  The query layer has
  supported `all` / `any` / `not` since it was written, but a projection was the
  one consumer still limited to a single tag string — so "every order that is not
  cancelled" needed a hand-rolled projection instead of a filter.
  `ByTagProjectionOptions.withTag` now takes either.  A bare string keeps working
  *and keeps its exact cursor*: `OffsetStore` is keyed by string, so the new
  `tagFilterCursorKey` maps a plain string to itself — any other mapping would
  have orphaned every persisted cursor and silently replayed each deployed
  projection from the beginning.  Object filters get a canonical key with each
  operator's tags sorted, so two filters that mean the same thing share one
  cursor however they were written.

- **`close?()` on `DurableStateStore`** (#393).  `Journal` and `SnapshotStore`
  have carried a teardown hook since they were written; durable state was the one
  contract of the three without it, even though its implementations hold the same
  kind of resource — a connection pool, an HTTP client, a file handle.  The
  remaining #393 items are tracked as **#493**.

- **Cloudflare D1 persistence backend** (#438) — `D1Journal`, `D1SnapshotStore`
  and `D1DurableStateStore`, completing the umbrella's five backends.  Spoken over
  D1's REST API with the framework's own `HttpClient`, so it adds **no dependency
  at all** — D1 has no Node SDK, which for once makes the SDK-free path the only
  path.  The SQL is `sqliteDialect`'s, so the schema is identical to the local
  SQLite and libSQL backends and a database can move between all three without a
  migration; the whole backend is a client plus three constructors.
  `withTransaction` provides no isolation because the HTTP API has no `BEGIN` and
  no parameterized batch — which `SqlPool` always documented as adapter-defined,
  and which the journal survives because concurrency rests on the primary key
  rejecting a racing writer.  The cost is documented: a multi-event append can
  persist a prefix if the connection drops midway.
  **Verification stops at the fake**, deliberately: D1 has no emulator that fits a
  container suite (locally it exists only inside `wrangler`/Miniflare), so there is
  no live suite and no CI row, and the docs say so plainly.
- **DynamoDB persistence backend** (#398) — `DynamoDbJournal`,
  `DynamoDbSnapshotStore` and `DynamoDbDurableStateStore` over
  `@aws-sdk/client-dynamodb` (a new optional peer, the same SDK family already
  used for S3).  Its optimistic concurrency is the **strongest** of any backend:
  the append is one `TransactWriteItems` where every put carries
  `attribute_not_exists`, so it is atomic across all items and a losing writer
  cannot leave a partial append behind — no equivalent of MongoDB's prefix
  caveat.  DynamoDB caps a transaction at 100 items, and an append beyond that is
  refused with a clear error rather than silently chunked, which would break that
  atomicity.  The compaction high-water mark lives in the same table at the
  reserved sort key 0, raised with a conditional update that expresses `GREATEST`
  as a condition.  Reads, deletes and `persistenceIds` page through
  `LastEvaluatedKey`; there is no indexed tag query yet, so `currentEventsByTag`
  falls back to the journal scan as it does on Postgres.
- **`MsSql`/`Mongo`/`DynamoDb` option validators** now reject an endpoint that is
  not an `http(s)` URL.  Worth noting because `new URL('localhost:8000')`
  *succeeds* — it reads `localhost:` as the scheme — so a bare `host:port` used to
  pass validation and fail later at connect time.
- **MongoDB persistence backend** (#397) — `MongoJournal`,
  `MongoSnapshotStore`, `MongoDurableStateStore` and `MongoQuery`, the first
  document-store backend and the first with an indexed tag query outside the
  SQL/Cassandra families (a multikey index over the `tags` array).  Optimistic
  concurrency uses the same two-layer scheme as the relational backends, with a
  unique compound index on `(persistenceId, sequenceNr)` and server error 11000
  standing in for a primary key and SQLSTATE 23505.  It needs **no
  transactions** — appends are contiguous from the head, so a losing writer fails
  on its first document and writes nothing — which keeps it working on a
  standalone `mongod` rather than requiring a replica set.  Payloads are stored as
  JSON text so a document with dotted or `$`-prefixed keys round-trips exactly.
  **Pin the driver to `mongodb@^6`**: version 7's bundled `bson` calls
  `v8.startupSnapshot.isBuildingSnapshot()` at module scope, which Bun does not
  implement, so importing it throws before any framework code runs.
- **`LazyStore`** — the store lifecycle (lazy connection, memoized init, one-shot
  schema preparation, ownership-aware teardown) is now shared by the relational
  and MongoDB families instead of living inside `RelationalStore`.
- **CockroachDB and YugabyteDB certified on the Postgres stores** (#401).  Both
  speak the PostgreSQL wire protocol, so they need no new backend — but "should
  work" is not the same as verified.  Two live suites now run the full
  persistence contract against them via the unmodified `PostgresJournal` /
  `PostgresSnapshotStore` / `PostgresDurableStateStore`, plus a docs page
  recording what is certified and what is not.  Notably CockroachDB's
  SERIALIZABLE isolation can reject a contended append with a retry error
  (SQLSTATE 40001) rather than a duplicate key, which currently surfaces as
  `JournalError`; that is documented rather than silently papered over.
- **Contract scenario for racing appends** — the persistence contract now
  asserts that concurrent `append`s at the same `expectedSeq` leave exactly one
  winner, no lost or duplicated events, and a `JournalConcurrencyError` for every
  loser.  This is the scenario that reaches the duplicate-key backstop at all,
  which nothing previously covered.  It also surfaced a genuine limitation in
  `CassandraJournal`, whose append is a read-then-write with no conditional write
  behind it — see the capability gate on its harness.
- **Microsoft SQL Server persistence backend** (#399) — `MsSqlJournal`,
  `MsSqlSnapshotStore` and `MsSqlDurableStateStore` on the relational base, via
  the `mssql`/tedious driver (a new optional peer dependency).  T-SQL needed four
  genuine dialect additions: `IF OBJECT_ID(…) IS NULL`-guarded DDL (there is no
  `CREATE TABLE IF NOT EXISTS`), `MERGE … WITH (HOLDLOCK)` upserts (the hint
  matters — without it two concurrent merges can both take the `NOT MATCHED`
  branch), `OFFSET/FETCH` row limiting, and named `@pN` parameters, which the
  pool adapter maps from the ordered array every other driver takes.  Requires
  SQL Server 2016+: the tags table's four-column key needs 1036 index bytes, so
  its primary key is nonclustered.  The driver is pure JavaScript and verified to
  import and build a pool on Bun, Node **and Deno 2** — the 2021 tedious
  crypto-shim issue that made Deno support an open question is fixed.
- **`SqlDialect.rowLimit(count)`** — row limiting moved into the dialect, since
  T-SQL has no `LIMIT` at all.  Unchanged for the `LIMIT`-based dialects.
- **libSQL / Turso persistence backend** (#400) — `LibSqlJournal`,
  `LibSqlSnapshotStore` and `LibSqlDurableStateStore`, SQLite reached over
  HTTP or WebSocket via `@libsql/client` (a new optional peer dependency,
  imported through its `/web` entry point so nothing native loads at runtime).
  The statements match the local SQLite backend's, so a database can move
  between a local file and Turso without a migration, and it is the first
  durable-state store in the SQLite family.  Remote URLs only — a `file:` or
  `:memory:` URL is rejected at construction with a pointer to `SqliteJournal`,
  because the HTTP driver cannot open one either.  Registration works like
  Postgres': `registerLibSqlPlugins` plus the plugin ids
  `actor-ts.persistence.{journal,snapshot-store,durable-state}.libsql`.
- **SQLite persistence now runs on Deno** (#400).  `getSqliteDriver()` used to
  throw there, because both drivers need a native binding — so `SqliteJournal`,
  `SqliteSnapshotStore` and `SqliteQuery` were unavailable and the docs pointed
  Deno users at the in-memory or Cassandra journal.  The new `NodeSqliteDriver`
  wraps the built-in `node:sqlite` (Deno >= 2.2, Node >= 22.13, recent Bun), so
  every supported runtime now has a SQLite driver that needs no install.  On
  Node, `better-sqlite3` is still preferred when present — existing deployments
  keep the driver they run — and `node:sqlite` is the fallback, which makes the
  peer dependency genuinely optional there.  A new `06-sqlite-journal` smoke
  case verifies append / read / concurrency on Bun, Node and Deno.
- **Relational persistence base layer** (#389) — `RelationalJournal`,
  `RelationalSnapshotStore`, `RelationalDurableStateStore` and the `SqlDialect`
  / `SqlPool` contracts are now exported.  A new SQL backend is a dialect
  (placeholder syntax, conflict clauses, duplicate-key classification, DDL)
  plus a pool adapter, instead of a third hand-written copy of three stores;
  `PostgresJournal` shrank from 280 lines to 31 on top of it.  `withTransaction`
  is deliberately specified as *adapter-defined* isolation, so an HTTP-fronted
  store that can only offer an atomic batch (libSQL, Cloudflare D1) still
  implements the journal correctly — the duplicate-key backstop, not the
  transaction, is what makes optimistic concurrency sound under a racing
  writer.  The Postgres dialect classifies conflicts by SQLSTATE rather than
  message text, which is what lets CockroachDB and YugabyteDB reuse it.

- **DevTools — embeddable web UI for a running system** (`actor-ts/devtools`,
  new `"./devtools"` subpath export).  `DevTools.attach(system, options)` binds
  a small server whose dashboard shows the system at a glance and links into
  one panel per tool; `DevTools.mount(system)` returns the routes for an
  existing server instead.  This first drop is the foundation — the versioned
  tap protocol, the WebSocket hub and the UI shell with its dashboard.  The
  panels themselves (actor tree + cluster, tracing, explain plan, time travel,
  profiler) follow, and the UI already lists them, marking each unavailable
  with a reason until it lands.  #445
  - **Security:** binds `127.0.0.1` unauthenticated by default, and
    `DevToolsOptions` *refuses* a routable bind unless `auth`, `ipAllowlist`
    or an explicit `allowRemote: true` is present — DevTools reads live actor
    state, so exposing it cannot be the result of a typo.  Auth and the IP
    allowlist wrap the UI, the JSON endpoints and the WebSocket upgrade alike.
    Individual panels can be switched off via `withPanels({ … })`.
  - Creating the extension does nothing: no port, no taps, no instrumentation
    until `attach()`, and each panel's collection runs only while a browser is
    subscribed to it.
  - The UI is vanilla TypeScript bundled at build time and embedded in the
    package — no UI framework in the dependency tree, no CDN loads, no
    filesystem access at runtime.
  - **Every example is wired for it**, opt-in via `--devtools` (see
    `examples/devtools.ts`).  An argument rather than only `DEVTOOLS=1`,
    because `VAR=value command` is a parser error in PowerShell — the flag
    works in every shell.  Short-lived example scripts park just before
    shutdown so there is time to open a browser; multi-system examples give
    each system its own port counting up from `--devtools-port`.  Without the
    flag their timing and output are unchanged.  The chat and voice backends
    pass their `Cluster` through, so the cluster panel is live there.
  - A DevTools attachment now ends with the system it debugs:
    `system.terminate()` releases the port even though it does not run
    `CoordinatedShutdown`.  Previously a terminated system left the server
    bound, keeping the process alive.
  - **Actor and cluster panels**, plus an overview with live figures.  The
    actor panel shows the live supervision tree with mailbox depths,
    filtering and restart highlighting; the cluster panel shows topology,
    members, shard distribution and membership history (pass
    `withCluster(cluster)` — a system cannot hand out its own).  Both
    sampling streams idle until a panel subscribes.  #204
  - A cluster member that leaves is **kept in the panel for an hour**,
    struck through and red, with how long ago it was last seen.  The
    node that drops out is the one worth looking at, and it used to
    disappear at that exact moment; the record is held on the server so
    a page reload does not erase it.
  - The **actors panel** keeps up with a live system.  Cell states used
    to freeze at whatever they were when the actor started, because
    lifecycle events announce births, deaths and restarts and nothing
    else — an actor that later suspended went on claiming to be a
    healthy `running` for the rest of the session.  The tap now
    re-inspects on its sampling interval and sends the new
    `actor-changed` delta for the cells that moved.  A **stopped actor
    stays on screen for 30 seconds**, greyed out and red, before it is
    swept: the actor worth looking at is usually the one that just died,
    and removing its row on the spot meant you never saw it.
  - **The UI says when nothing is answering.**  Every panel keeps drawing
    the last thing it heard — the final reading before a node died is
    usually the one worth having — which meant a dead cluster looked
    exactly like a healthy one, with only an eight-pixel badge to say
    otherwise.  A dialog now interrupts and names it, counting how long
    nothing has answered; the panel dims so frozen figures do not read as
    live ones.  It closes itself the moment something answers, and can be
    dismissed to read the last figures anyway.
  - The panel reads as one thing rather than three.  Corners are square
    throughout — rounded boxes made a developer tool look like a landing
    page — the per-node columns line up with their headings, uptimes
    under a minute lose their decimal, and the actor tree no longer
    scrolls inside its own box: the page scrolls, so the bottom of the
    tree is reachable without hunting for the right scrollbar.
  - Two places disagreed about how many nodes a cluster has, so one that
    had lost a node showed three rows and "2 / 2 up".  The cluster panel
    and the overview now read the same retained membership, and the
    topology graph colours a node by what it is now rather than by the
    status it had when it left.  The chosen timespan survives a reload.
  - **The overview's charts have a timespan** — one minute to
    twenty-four hours, five by default — and the series is recorded on
    the server rather than accumulated in the browser.  A panel opened an
    hour into a run shows that hour instead of filling an empty graph,
    and a reload does not lose it.  Stored in tiers so a day is neither
    unsendable nor unreadable: one second for fifteen minutes, fifteen
    seconds for four hours, two minutes for a day, with the query
    answered from the finest tier that reaches back far enough.  Levels
    keep each interval's peak so a spike survives summarising; counters
    keep its last reading so the rate maths stays correct.
  - **The actors panel lists every node**, each under its own heading —
    which is how a singleton hosted on one node, or work piling up on
    one of several, becomes visible at all.  Paths repeat across a
    cluster (every node runs the same system name), so trees are kept
    apart by address.  Remote nodes report whole trees each round and the
    client diffs them, so an actor that dies on a peer gets the same
    thirty-second tombstone a local one does.
  - **The overview covers the whole cluster.**  Every clustered node with
    DevTools attached runs an agent that answers for itself; the node
    serving the UI polls them on its sampling tick and reports both the
    total and a **Per node** breakdown.  The totals are the sum of the
    breakdown rather than a second count, so the two cannot drift apart.
    Polling is fire-and-forget — a slow node delays its own row, not the
    dashboard — and a node that stops answering keeps its last reading,
    marked *not answering*, until an hour has passed.
  - The **overview** is three sections — *Common* (identity, uptime,
    runtime, cluster), *Numbers* and *Charts* — and no longer duplicates
    the nav rail as a grid of tool cards.  Alongside the actor figures it
    reads the framework's own instrumentation for **messages per second,
    processed messages, mailbox drops and handler p99**, and derives
    **stashed messages** and **suspended actors** from the tree walk it
    already does.  Trends are split across three charts so a level and a
    rate never share a y-axis.  To make those counters real, DevTools
    enables the metrics registry at attach if the application had not,
    and restores the noop on detach; a registry you enabled yourself is
    left alone.
  - **Tracing panel** — the route a message took, and where its time
    went.  The panel opens on a full-width list: one row per trace with
    `sender → actor → actor`, the message's name, its payload as JSON
    and the duration; opening a row shows the flame graph or waterfall
    for that trace.  Spans carry microsecond timings, self time and
    per-span attributes.  Recording runs from the moment DevTools
    attaches rather than on a button press, so the messages worth
    looking at — the ones that already went past — are there when the
    panel opens.  The last 100 are kept by default and a selector takes
    that to 10 000 (`tracing.buffer`, ceiling `withSpanBufferCapacity`).
    DevTools' own actors are excluded so the hub publishing spans cannot
    feed its own output back in.
    Attaching DevTools no longer costs you your tracer: if one is already
    installed it is wrapped in the new `TeeTracer` so an OTel exporter and
    the local panel both see every span, and detaching restores the
    original.  #217
  - **Explain-plan panel** — the last messages one actor handled, with
    type, sender, mailbox wait, handling time and outcome (clean,
    stashed, threw).  Switched on per actor from the browser rather than
    by a code change and a restart, and switched back off when you leave
    the panel or detach.  #218
  - **Time-travel panel** — read a persistence journal in the browser and
    reconstruct an event-sourced actor's state at any sequence number,
    with a field-level diff of what each event changed.  Strictly
    read-only.  A fold comes either from a running `PersistentActor`
    (borrowed automatically) or from `DevToolsOptions.replayFolds`; where
    neither exists the event log still works and the panel says why the
    state cannot be derived.  Ships as a panel only — no CLI.  #201
  - **Profiler panel** — an aggregated flame graph of where the system
    spends its time, grouped by actor path and message type, plus the
    heaviest handlers as a table.  Wallclock mode uses the framework's
    own per-message timings (the ones behind
    `actor_message_handler_seconds`) and exports speedscope JSON; CPU
    mode hands back a V8 `.cpuprofile` for Chrome DevTools where
    `node:inspector` exists, and says so plainly where it does not — via
    the new `profiler.capabilities` request, so the mode is greyed out
    with its reason before you press Start.  It used to fail at Start
    with the runtime's own error, because importing `node:inspector`
    *succeeds* on Bun (it even exports `Session`) and only constructing
    a session throws.  One session at a time, auto-stoppable, and the
    hook is removed when the session ends or DevTools detaches.  #226
    With this the DevTools suite (#445) has all five panels.
- **`ActorSystem.startedAtMs`** — wall-clock time the system was created,
  stamped first in the constructor.  `Date.now() - system.startedAtMs` is
  the system's uptime, and unlike a monitoring tool's own clock it does
  not restart when that tool attaches, detaches or reconnects.
- **`CoordinatedShutdown.removeTask(phase, name)`** — unregister a task,
  so a component that registers on acquiring a resource can register
  again after releasing it.  Without it, `bind()` → `unbind()` →
  `bind()` on the same address was impossible: the HTTP layer's task is
  named `http-unbind-<host>:<port>` and outlived the server it belonged
  to, so the second bind collided with a task for a server that no
  longer existed.  `unbind()` now removes it.
- **`Props.asInternal()`** — marks an actor as belonging to tooling
  rather than to the application, inherited by its children.  Whole-system
  instrumentation skips it, which is what keeps a debugger out of its own
  output: DevTools' hub publishes the spans it just recorded, so tracing
  it fed every batch back in as the payload of the next one.  Application
  actors should not be marked — hiding real work from a profiler is how a
  performance problem stays invisible.  A marked actor opens no span at
  all, root or child: its probes receive event-stream publishes *during*
  an application message, so excluding only roots left them showing up in
  the middle of that message's route.
- **`TracingExtension.captureMessagePayloads(enabled)` /
  `isCapturingMessagePayloads()`** — attach the message itself, as JSON,
  to each `actor.receive` span.  A separate switch from
  `recordRootSpans` because the costs differ: one decides whether to open
  a span, this one decides whether to `JSON.stringify` a user object
  while doing so.  Bounded in depth and length, cycle-safe, and never
  allowed to throw into the dispatch it describes.
- **`TracingExtension.recordRootSpans(enabled)` /
  `isRecordingRootSpans()`** — trace **every** message, not only the ones
  that already belong to a trace.  The framework is propagate-only by
  design: an actor opens a span when the message arrived with a trace
  context or one was active at the call site, so a plain `ref.tell(…)`
  from outside any span records nothing.  Correct for production, and
  the reason a tracing UI could show an empty screen on a busy system.
  Off by default, refuses without a tracer installed, and cleared by
  `disable()`.  Costs one boolean read per message when off.
- **`MetricsExtension.disable()`** — back to the noop registry, mirroring
  `TracingExtension.disable()`, so a tool that switched metrics on for its
  own use can leave the system as it found it.
- **`replayState()`** (`actor-ts` → `src/persistence/Replay.ts`) — the
  journal fold behind `PersistentActor` recovery, now callable on its own
  against a journal and snapshot store with no `ActorSystem` involved.
  A `toSequenceNr` bound replays to a point in the past, using the newest
  snapshot before it.  Snapshot-integrity failures throw the new
  `SnapshotIntegrityError` (an `Error` subclass, messages unchanged).
- **`ActorContext.enableExplainPlan()` / `disableExplainPlan()` /
  `explainPlan()`** — the same per-actor recorder from code, for when
  you already know which actor you care about.  Opt-in per actor: an
  actor with no plan costs one null check on the dispatch path, and
  envelope timestamping is switched on only for actors being recorded.
  A stashed message keeps its original timestamp on replay, so its
  mailbox wait spans the whole stash residency.
- **`TeeTracer`** — a `Tracer` that forwards to another and reports every
  completed span to an observer.  The tracing extension holds exactly one
  tracer, so watching spans previously meant replacing whatever was
  installed; teeing removes the either/or.
- **`RecordingTracer` can be bounded and records monotonic timings.**
  `maxRecorded` caps the in-memory buffer (oldest evicted; `0` keeps none
  while still calling `onSpanEnd`) — an unbounded recorder left enabled on
  a busy system grew without limit.  `RecordedSpan` additionally carries
  `startHighResolutionMs`/`endHighResolutionMs`, because wall-clock
  milliseconds cannot resolve actor message handling.
- **Actor lifecycle events on the `EventStream`** — `ActorStarted`,
  `ActorStopped` and `ActorRestarted`, sharing an `ActorLifecycleEvent`
  base so `subscribe(ref, ActorLifecycleEvent)` takes the whole family.
  Previously the stream carried dead letters, cluster and broker events
  but nothing about actors coming and going, so tracking the tree meant
  polling it.  #204
- **`EventStream` channels may be abstract classes.**  Matching is by
  `instanceof`, so an abstract base is a valid channel — and the most
  useful one, since it subscribes to a whole event family at once.
- **`PersistenceExtension.configure({ journal?, snapshotStore? })`** — a thin
  convenience over `setJournal` / `setSnapshotStore` for tests and simple,
  single-backend apps that wire persistence directly in code.  (The docs
  already documented this call; it is now real.)
- **`CassandraJournalOptions.withLightweightTransactions(boolean)`** (#475) —
  opt out of the LWT-serialized append path (see *Security*) and get the
  single-round-trip write back.  Default `true`.  Only safe when a single
  writer per persistence id is genuinely guaranteed; with it off, a losing
  concurrent append silently discards its event.
- **`CassandraJournalOptions.withSerialConsistency(number)`** (#475) — the
  consistency governing the LWT claim's Paxos phase, applied to the
  conditional statement only.  Unset, the driver uses cluster-wide `SERIAL`,
  which needs a quorum across *every* datacenter — so on a multi-DC keyspace
  each append would pay a cross-DC round-trip, undoing the local-DC write path
  `consistency: LOCAL_QUORUM` exists to provide.  Set `localSerial` (9) there.
- **`RetryOptions.sleep`** (#477) — override how `retry` awaits the delay
  between attempts.  Defaults to `setTimeout`; pass a `ManualScheduler`-backed
  sleep to run the backoff on virtual time, so a test can assert the schedule
  exactly and instantly instead of measuring real gaps.  Same escape hatch as
  `BackoffPolicy`'s `random`.

### Changed

- **BREAKING — `ClusterSingleton.start()` returns an `ActorRef`; `SingletonHandle`
  is gone** (#523).  Addressing a singleton took three concepts and a hop —
  `system.extension(ClusterSingletonId).start(cluster, options).proxy` — so
  every singleton grew a hand-written `getOrCreate(cluster)` wrapper whose only
  job was to hide that line.  Sharding has had `cluster.sharding` and returned
  a plain `ActorRef` all along; singleton was the outlier.

  Migration:

  | Before | After |
  | --- | --- |
  | `system.extension(ClusterSingletonId).start(cluster, options)` | `cluster.singleton.start(options)` |
  | `handle.proxy.tell(m)` | `singletonRef.tell(m)` |
  | `handle.stop()` | `cluster.singleton.stop(key)` |
  | `handle.manager` | `cluster.singleton.managerFor(key)` |
  | `.get<T>(name).forEach(h => h.proxy.tell(m))` | `cluster.singleton.ref<T>(name).tell(m)` |

  `withTypeName` / `withProps` are unchanged, so builder call sites do not move.
  One behaviour change to know about: `stop()` on the returned ref is now a
  warning no-op.  It used to mean "stop forwarding" and was reachable only
  through `SingletonHandle.stop()`; now that the proxy *is* the returned
  `ActorRef`, `ref.stop()` is the natural thing to write, and `ActorRef.stop()`
  means "PoisonPill the target" everywhere else — it would have killed whatever
  the leader was hosting.  Use `cluster.singleton.stop(key)`.
- **BREAKING — framework actors moved from `/user` to grouped `/system`
  paths** (#509).  `ActorSystem` has always built a `/system` guardian and
  then never used it: the field was assigned in the constructor and read
  nowhere, `spawn` hardwired the user guardian, and so every actor the
  framework spawns for itself — the DevTools hub, shard regions and
  coordinators, the singleton manager, the pub-sub mediator, the
  receptionist, DistributedData, reliable-delivery controllers,
  projections — sat flat under `/user` among the application's own actors.
  DevTools documented the empty `/system` branch as intended behaviour.
  They now live under `/system`, one group per subsystem, and drop the name
  prefix that only existed to keep a dozen unrelated actors from colliding
  as flat siblings:

  | Before | After |
  | --- | --- |
  | `/user/devtools-hub` | `/system/devtools/hub` |
  | `/user/devtools-actor-tree` | `/system/devtools/actor-tree` |
  | `/user/devtools-stats` | `/system/devtools/stats` |
  | `/user/devtools-stats-dead-letters` | `/system/devtools/stats-dead-letters` |
  | `/user/receptionist` | `/system/cluster/receptionist` |
  | `/user/pubsub-mediator` | `/system/cluster/pubsub/mediator` |
  | `/user/distributed-data` | `/system/cluster/crdt/data` |
  | `/user/sharding-<typeName>` | `/system/cluster/sharding/region-<typeName>` |
  | `/user/sharding-coordinator-<typeName>` | `/system/cluster/sharding/coordinator-<typeName>` |
  | `/user/singleton-manager-<typeName>` | `/system/cluster/singleton/manager-<typeName>` |
  | `/user/reliable-consumer-<n>` / `-producer-<n>` | `/system/delivery/consumer-<n>` / `producer-<n>` |
  | `/user/projection-<name>…` | `/system/persistence/projection/<name>…` |

  **Migration.**  These paths travel on the wire and are embedded in the
  ShardCoordinator's persisted DistributedData state, so a mixed-version
  cluster will not interoperate and a coordinator recovering pre-upgrade
  state will not match its regions: restart the cluster cold, or discard
  the persisted coordinator state.  Application code is unaffected unless
  it matched on a framework path by string — `/user` now contains only
  what the application spawned, which is the point.  There is no public
  API for spawning into `/system`; the seam is internal.
  Group levels are actors (empty supervisors holding the grouping and a
  supervision policy) and are created on first use, so a system that never
  starts clustering or DevTools keeps the same three-cell tree it had
  before.  Groups restart their children by default — the behaviour these
  actors had under `/user` — with DevTools the deliberate exception: a
  probe that failed on what it observed would fail again on the restart.
  DevTools' `internal` mark moved from its two spawn sites to the
  `/system/devtools` group, since `ActorCell` inherits the flag; no other
  group is marked, as that would silently strip tracing from cluster
  internals.
  Seven places used to build these paths as hand-written `/user/…`
  literals, three of which doubled as `Cluster._registerEnvelopeHandler`
  keys.  They now derive from one internal module, and each registration
  site asserts that the actor really landed where the helper says. That
  drift was worth a guard: it did not throw, it *mis-delivered* —
  `dispatchEnvelope` misses the per-path handler, falls back to resolving
  the path itself, and tells the raw envelope body, so a singleton manager
  would receive an unwrapped payload instead of a `singleton-deliver`.

- **BREAKING (examples) — `examples/cluster/counter-node.ts` discriminates on
  `kind`** (#494).  Its `Command` union tagged entities with `op: 'increment' |
  'get'`, the only place in the repo that used a third spelling for a
  discriminant.  Migration: send `{ id, kind: 'increment' }` instead of
  `{ id, op: 'increment' }`.  `examples/pubsub/event-bus-across-nodes.ts`
  likewise renames `DomainEvent.type` to `kind`.

- **Example frontends dispatch server frames with `match`** (#494) — all eight
  chat/voice browser apps (React, Next, SvelteKit, Angular) and the four
  no-build `static/{plain,lit}` pages switched on the WebSocket frame's `kind`
  instead of matching on it, and the four React/Next reducers tagged their
  action unions with `type:` rather than the project-wide `kind:`.  Both are
  fixed; `ts-pattern` joins the eight app manifests and is imported from
  esm.sh on the CDN pages.  `examples/chat/static/plain/index.html` becomes a
  `<script type="module">` so it can import at all — it has no inline event
  handlers, so nothing depended on the old global scope.  The committed
  `static/**` bundles are regenerated.

- **Docs no longer recommend `if`-chains over `match`** (#494) — the pattern
  matching page carried a "When to prefer plain `if`" section whose rule of
  thumb was *use `match` from 4+ variants*, and the FAQ, design-decisions and
  event-dispatcher pages each repeated some form of "a plain `if/else` ladder
  works fine".  That is the opposite of the convention the codebase actually
  follows, so roughly 150 doc samples had grown up around the advice.  The
  section is gone and the three echoes are rewritten: every dispatch on an
  incoming message, event or command uses `match` with each arm delegating to
  an `onXxx` handler; matches on internal state or that compute a value keep
  their bodies inline.  The README's event-sourcing snippet, which dispatched
  on `cmd.kind` with a ternary forty lines below the section teaching the
  opposite, is fixed to match.
  The samples themselves follow in a second pass: ~150 `if`-chains, one
  `switch` and several ternaries across 33 EN/DE page pairs now use `match`,
  with class-actor hooks delegating to `onXxx` handlers and inline
  object-literal unions replaced by named variant types.
- **One declaration form per job: `interface` for contracts and heritage,
  `type` for data** (#503, #508).  The codebase used to mix the two with no
  stated rule.  It now has one: a declaration is an `interface` when it
  prescribes function heads — any method, call or construct signature — or
  when it `extends` another shape; everything else is a `type`, including
  plain data shapes, unions, and mapped and conditional types.  A
  function-typed *property* (`onLost?: () => void`) is not a function head.
  Across `src/`, the test suites, examples, benchmarks, the DevTools UI and
  the documentation's code samples that comes to 423 interfaces and 1690 type
  aliases.  In practice: the contracts you implement — `Journal`,
  `SnapshotStore`, `Lease`, `Transport`, `Serializer`, `Cache`, `Tracer`,
  `Span`, `DowningProvider`, `AllocationStrategy` — are interfaces, as are
  the option shapes that extend a backend connection; the records they carry
  are aliases.
  Nothing in the published type surface changes shape, and no signature
  moved.  The one consequence for consumers is that a name declared as a
  `type` can no longer be extended by declaration merging
  (`declare module 'actor-ts' { interface X { … } }`) — write an intersection
  in your own code instead.  That was already true of nothing in this repo:
  there is not a single `declare module` or `declare global` in the tree.
  One shape declares a function head and stays a `type` on purpose:
  `NativeWorker` in the web-worker backend intersects the DOM `Worker` with
  deliberately narrower listener signatures, which an intersection accepts as
  overloads and `extends` rejects as incompatible.  It carries a comment
  saying so.  The rule itself is written down in AGENTS.md.

- **Messages are named by their `kind`, not `Object`.** Every tool that
  lists what an actor handled — the profiler's heaviest handlers, the
  explain plan, the tracing panel — took the message's `constructor.name`,
  which answers `Object` for a plain object literal.  Since the house
  convention is a `kind`-discriminated union of object literals, that was
  the answer for nearly every message.  A tagged literal now reads as its
  discriminant (`place-order`), a tagged class as `Class.kind`, and
  classes and primitives are unchanged.

- **BREAKING — abbreviations spelled out across all identifiers.**  Type,
  class, file, method, field, generic-type-parameter and local names now use
  full words — `Command`/`Message`/`Acknowledgment`/`NegativeAcknowledgment`/
  `Terminate`/`Increment`/`DirectMessage`/`Request`/`Response`/`Function`/
  `Context`/`Connection`/… (no more `Cmd`/`Msg`/`Ack`/`Nak`/`Nack`/`Term`/`Inc`/
  `Dm`/`Req`/`Res`/`Fn`/`Ctx`/`Conn`).  Public-API surface is affected: generic
  parameters (`PersistentActor<Command, Event, State>`),
  `Scheduler.scheduleOnceFunction`/`scheduleAtFixedRateFunction` (were `…Fn`),
  exported types (`HealthCheckFunction`, …), and config fields
  (`maxMessages`/`maxAcknowledgmentPending`/`autoAcknowledge`).  The tagged-union
  discriminant field is now always `kind` (never `type`) and its string values
  are spelled out (`kind: 'increment'`, not `'inc'`).
  *Migration:* rename usages accordingly; messages must use `kind` with the
  spelled-out literal.  Names mirroring external APIs (nats.js, prom-client,
  amqplib, DOM) and domain acronyms (PubSub, K8s, AMQP, MQTT, SQL) are unchanged.
- **BREAKING — runtime floors raised: Node ≥ 24, Bun ≥ 1.3.**  Node 20
  reached end-of-life in April 2026 (no more security fixes); Node 24 is
  the oldest active LTS line (supported to April 2028) and the first
  floor on which everything the framework relies on — WebSocket client,
  zstd, WebCrypto, fetch — is native.  The Bun floor moves from the
  two-year-old, never-CI-tested 1.1 claim to 1.3, which CI now actually
  exercises (the multi-runtime smoke matrix runs Bun on `latest` *and*
  pinned 1.3.0; integration Docker images are pinned to
  `oven/bun:1.3-debian`).  Deno stays ≥ 2.0.
  *Migration:* upgrade to Node ≥ 24 / Bun ≥ 1.3.
- **BREAKING — `WebsocketClientActor` always uses the native
  `WebSocket`.**  The dynamic `ws` fallback for
  Node < 22 is gone, and with it the `headers` client option
  (`withHeaders` builder + the `headers` HOCON key under
  `actor-ts.io.broker.websocket`) — only the `ws` path could send
  custom handshake headers, so on native runtimes the option was
  already silently ignored.  `ws` remains an optional peer dependency
  for server-side upgrades on the Express backend.
  *Migration:* pass credentials via query parameter or subprotocol,
  exactly as browser clients must.
- **BREAKING — `typescript` peerDependency is now
  `^5.6.0 || ^6.0.0 || ^7.0.0`** — it finally admits TypeScript 7 (the
  native compiler the repo itself builds with since 6.0.3 → 7.0.2) and
  raises the floor from the never-verified 5.0 to 5.6, the single
  minimum now stated everywhere (README badge, FAQ, peer range).
- `@types/node` is pinned to the support floor (24) instead of the
  newest major, so framework code can't accidentally use Node-26-only
  APIs; the publish workflow drops its `npm@11` upgrade step (Node 24
  bundles npm ≥ 11.5.1, the trusted-publishing minimum).

- **TypeScript 7 — the native compiler** (#361).  The `typescript`
  devDependency moved from 6.0.3 to **7.0.2**, Microsoft's ground-up native
  (Go) port of the compiler that replaces the JavaScript-based `tsc`.  The
  npm package now ships a platform-specific native binary
  (`@typescript/typescript-win32-x64` etc.).  For this repo the switch was
  drop-in: no source or `tsconfig` changes were needed, `bun run typecheck`
  is clean and the full test suite passes.  The payoff is speed — a full
  `tsc --noEmit` over the repo dropped from **~6.5 s (6.0.3) to ~1.0 s
  (7.0.2)** on the same machine.  TypeScript is a devDependency only, so
  nothing changes for consumers of the published package.
- **`@fastify/static` 9.3.0 → 10.1.0** (#362) — devDependency used by the
  Fastify HTTP backend examples/tests; no code changes required.
- **CI: `actions/setup-node` 6 → 7** (#363) in the docs, multi-runtime, and
  publish workflows.
- **`better-sqlite3` support widened to v13** (#376).  The optional
  `better-sqlite3` peer dependency now accepts `^12.9.0 || ^13.0.0` (was
  `^12.9.0`), and the dev/test toolchain tracks 13.0.1.  better-sqlite3 13
  migrated to Node-API, which replaces its `prebuild-install` native-binding
  dependency tree with `node-addon-api` and improves prebuilt-binary
  portability across Node versions.  The `BetterSqliteDriver` surface
  (`open`/`exec`/`prepare`/`run`/`get`/`all`/`transaction`/`close`) is
  unchanged, so no consumer migration is required.

### Removed

- **BREAKING — dead persistence options removed** (#381).  Three
  declared-but-never-implemented knobs are gone (pre-1.0 hard cut):
  `LiveQueryOptions.batchSize` and `LiveQueryOptions.clock` (no query
  implementation ever batched or read an injected clock); the object-storage
  plugin's `durableStatePluginId` option + `withDurableStatePluginId` builder
  method (the plugin only ever registered the snapshot store by id, never the
  durable-state store); and the HOCON key `actor-ts.persistence.recovery.mode`
  (defined in the reference config + documented, but read by no code).
  *Migration:* remove any use of these — they were no-ops.  (The Cassandra
  `consistency` option is **not** removed — it is now honoured; see Fixed.)
- **Docs toolchain: Astro 7 + Starlight 0.41** (#474).  The upgrade #473 had to
  defer: `@astrojs/starlight@0.41.4` peers `astro: "^7.0.2"`, so the coordinated
  bump (`astro` `^6.4.8` → `^7.1.3`, `@astrojs/starlight` `^0.39.3` → `^0.41.4`)
  is now viable.  Astro 7 also makes `@astrojs/markdown-satteri` the default
  Markdown pipeline and demotes the remark/rehype one to the optional peer
  `@astrojs/markdown-remark`, which deprecates `markdown.rehypePlugins`; the
  Mermaid SSR wiring in `docs/astro.config.mjs` therefore moves to
  `markdown.processor: unified({ rehypePlugins: [...] })` and `docs` takes an
  explicit `@astrojs/markdown-remark` dependency (pinned to `7.2.1`, Astro's
  exact peer).  Site-only — no runtime or public-API impact.

### Fixed

- **A role-restricted singleton is hosted by a node that carries the role**
  (#524).  `wantHosted()` required the node to be the cluster leader **and** to
  carry the configured role, so `withRole('worker')` on a cluster whose elected
  leader lacked `worker` left the singleton hosted **nowhere**: the leader's
  manager declined on the role, every other manager declined on not being the
  leader, and messages died at the leader with a `log.warn`.  Host election is
  now "the first up-member carrying the role", falling back to the leader when
  no role is set — one shared `singletonHost()` used by the manager *and* the
  proxy, because the manager drops anything addressed to it that it is not
  hosting, so any drift between the two is silent message loss.

  A role now also rides along on `SingletonKey.of<T>(typeName, role?)`, the way
  `ShardKey` carries its `extractEntityId`: it is not part of the identity
  (`equals` ignores it) and a `role` in `StartSingletonOptions` still wins, but
  a node that only calls `ref()` has no options object to read — it has the key
  and nothing else — so without this its proxy would resolve a different host
  than the managers.  Declaring it on the class makes both sides agree by
  construction.  The existing role test never caught any of this: its
  role-carrying node was also the lowest-addressed one, and so the leader
  anyway.
- **`ask()` across nodes gets its reply instead of timing out** (#517).  The
  one-shot reply ref `ask` synthesises was built as a *root* path
  (`new ActorPath(name, null, systemName)`), and `ActorPath` renders a root
  without its own name — so the ref came out as `actor-ts://<system>/`, the
  `askResp-…` name gone.  Locally that is invisible, because the ref is passed
  around as an object and never looked up by path.  Across the wire the path is
  the whole address: the reply went back addressed to the bare system root,
  `parsePathSegments` yielded `[]`, the receiving node's path guard rejected it,
  and the ask timed out having *already been answered*.  The docs recommend
  `ask` for exactly this case (`cluster/refs-across-nodes`), and none of the
  existing cross-node tests covered it — they all pass a spawned actor as
  `replyTo`, which has a real path.

  Two halves to the fix.  The ref now lives at `/temp/askResp-<id>`, which keeps
  the name in the rendering **and** makes the path unique per call — a detail
  that matters more than the name: with every ask rendering to the same string,
  two in flight at once would have shared one registration and the second would
  have evicted the first.  And because an ask ref is not an actor and so cannot
  be resolved through the actor tree, `Cluster` registers it as a per-path
  envelope handler — done at *encode* time, the point where the ref is known to
  be leaving the node, so a purely local ask stays off the map entirely, and
  torn down when the ask settles by reply or timeout, so the map does not grow
  by one entry per call.  `/temp` is documented in `fundamentals/actor-paths`
  as the fourth top-level path.
- **A stopped singleton can be started again** (#523).  The extension's
  registry was written on start and never emptied, so `stop()` left a dead
  entry behind — and because `start()` is get-or-create, every later start on
  that node short-circuited to it and returned a proxy that had already stopped
  forwarding.  Silent, total, and undebuggable, with no way back short of
  tearing down the `ActorSystem`.  The registry is now pruned from the
  manager's own `postStop`, so supervision and system shutdown are covered too,
  not just the explicit path.  Restarting in the same turn still cannot work —
  the actor name stays taken until termination settles — but it now says so
  instead of surfacing `Child name 'manager-x' is not unique under …`.
- **Required singleton and sharding options are enforced** (#523).
  `OptionsValidator`'s check helpers are no-ops on `undefined` by design, and
  required-ness was never asserted for these two, so
  `{ typeName: 'x' }` with no `props` (singleton) or no `entityProps` /
  `extractEntityId` (sharding) validated cleanly and failed much later — the
  singleton inside `Props.create`, the region deep in `settingsToConfig` or on
  its first message, neither naming the missing field.  A proxy region stays
  exempt: it routes but never hosts.  An empty `role` on a singleton is
  rejected too — it silently matched no node, so the singleton was hosted
  nowhere.
- **The DevTools UI freshness check compares a source fingerprint, not bytes**
  (#521).  The gate added for #484 failed on its first run and kept `build` red:
  it rebuilt the bundle and diffed the result, which presumes the emitted bytes
  are a function of the sources alone.  They are not.  `gzipSync` stamps the
  compiling platform's OS code into byte 9 of every member — `0x0a` on Windows,
  `0x03` on Linux — so *every* asset differs between a Windows dev box and an
  ubuntu runner no matter what changed; from Windows the gate could never pass.
  On top of that `bun-version: latest` moves `Bun.build`'s minifier under the
  check (1.3.1 → 1.3.14 changed two shared chunks, which cascaded into renaming
  all seven panel chunks), and the asset array inherited `result.outputs`' order
  unsorted, which the same upgrade reshuffled.  The generated header now carries
  a `source-hash` over what the bundle is built *from* — the UI sources, the
  build script, and `package.json`'s `dependencies`, since `ts-pattern` is
  bundled in — and `bun run check:ui` recomputes and compares it without
  building anything.  That catches the thing worth catching, a change under
  `devtools-ui/` with no `bun run build:ui`, on any OS and any Bun.  It
  deliberately does not catch bundler drift: a newer Bun emitting smaller output
  for unchanged sources is not staleness, and treating it as such is what made
  the previous gate fire on bundles that were perfectly current.  The step also
  moved ahead of `bun run build` — that script *is* `build:ui && tsc`, so any
  check after it inspects a file the job just regenerated.
- **A module mock in the worker tests no longer hands a fake backend to the
  rest of the suite** (#520).  `tests/unit/worker/WorkerCluster.test.ts`
  installed its in-memory `FakeWorkerBackend` with `mock.module`, which in Bun
  is process-global and permanent — `bun test` runs every file in one process,
  and nothing took the mock back.  Whenever the runner visited
  `tests/unit/worker/` before `tests/unit/runtime/`, the four
  `getWorkerBackend` tests asserted against the leaked fake and failed; the
  mock also replaced `resetWorkerBackendCache` with a no-op, so their own cache
  reset silently did nothing.  That is what had `tests` and `multi-runtime` red
  on `develop` since 2026-07-27 while the same suite stayed green on Windows,
  where the file order differs — the defect was latent since #315, not a
  regression.  `WorkerCluster` and `ParallelMultiNodeSpec` now take the backend
  as an option (below), so the test injects its fake and mocks nothing.  No
  first-party module is mocked anywhere in the suite any more, which is what
  makes the leak impossible rather than merely fixed.
- **A `PersistentFSM` state-timeout that fires during recovery is dropped
  instead of crashing the FSM** (#519).  `onReceive` intercepts the internal
  `__fsm_state_timeout__` self-tell *before* delegating to the base class, so
  that branch bypassed the `_recovering` guard every ordinary command goes
  through — and `PersistentActor`'s state is unassigned until replay succeeds,
  making the dereference in `fireTimeoutTransition` a `TypeError` rather than a
  stash.  Supervision turned that into a restart, so the symptom was an FSM
  restarting for no visible reason.  Dropping the fire is also right on its own
  terms: `onRecoveryComplete` arms a fresh timer for the recovered state, so a
  pre-restart fire has nothing left to say.  Found while fixing #516, whose fix
  closed the then-reachable path from outside; this closes it at the site.
- **The embedded DevTools UI bundle is byte-reproducible, and CI verifies it**
  (#484).  Two places promised a freshness check for
  `src/devtools/generated/uiAssets.ts` — the generated file's own header and
  `.gitattributes` — and neither was true.  No workflow compared the committed
  bundle against a rebuild, and `build.yml`'s path filters listed neither
  `devtools-ui/**` nor `scripts/**`, so a UI-only change did not even trigger
  the build job.  The module is committed deliberately, so a fresh clone can
  typecheck, test and smoke without running the UI build; that is exactly what
  made a stale one invisible, since it stays valid TypeScript either way.
  The gate presupposes a byte-reproducible rebuild, and that did not hold:
  Bun's `[hash]` in a chunk file name is not a pure function of the chunk's
  bytes, it also varies with the path the module resolved through.  Bundling
  inside a git worktree — whose `node_modules` sits several directories above
  the project root — emitted byte-identical chunks under different names than
  a plain checkout did, so the committed bundle read as stale for anyone whose
  layout differed from whoever last regenerated it.  Nothing caught it: same
  file size, same asset bodies, only the names moved.  Chunk names are now
  derived from the bytes the bundle actually ships — the same reasoning that
  already makes the ETags content-derived rather than mtime-derived — so the
  names no longer depend on the layout they were built in.  `build.yml` gained
  the missing path filters, a `--frozen-lockfile` install (the bundled
  dependencies have to be the ones the lockfile pins for the check to mean
  anything), and a freshness step.  That step first shipped as a
  rebuild-and-diff, which turned out to be unpassable for reasons beyond the
  chunk names; see #521 below for what replaced it.
- **`/user` is drained before `/system` starts stopping** (#509).
  `terminate()` enqueued one `terminate` on the root cell, and a cell stops
  every child at once — so both guardians came down concurrently, while
  `fundamentals/actor-system.mdx` had always promised "stop `/user`
  recursively … then stop `/system`".  Harmless while every actor lived
  under `/user`; not harmless once the framework's own actors moved to
  `/system`, because the application talks to the framework and not the
  other way round.  A user actor's `postStop` — unsubscribing from the
  pub-sub mediator, handing a shard back, writing a last event — needs that
  framework actor still alive, and racing the guardians turned those into
  dead letters non-deterministically: the failure mode that reproduces on a
  loaded CI box and not on the machine you debug on.  The root cell now
  stops its children in sequence, each fully drained before the next is
  asked; ordinary actors keep the concurrent fan-out, since siblings are
  peers and nothing about being a child implies an order.
- **`Props.withSupervisorStrategy()` actually supervises now** (#509).  It was a
  no-op: `ActorCell.onFailure` resolved the strategy as
  `this.actor?.supervisorStrategy() ?? defaultStrategy` and never read
  `props.config.supervisorStrategy`, so the setter built a new `Props` whose
  strategy field nothing consumed.  The API is not obscure — `fundamentals/props.mdx`
  documents it with its own section in both languages, and the routing and
  supervision pages use it in samples — so every caller following the docs got
  the guardian's default instead of the policy they asked for, silently.
  Resolution order is now the failing child's Props, then the parent actor's
  `supervisorStrategy()`, then `defaultStrategy`.
  The repo described the semantics two contradictory ways, so this also settles
  which one is real: the strategy on an actor's `Props` says how **that actor**
  is supervised (`props.mdx`), not how it supervises its own children (the note
  in `benchmarks/single-node/supervisor-restart.ts`, now corrected).  That is
  why the parent reads it — a child never gets to answer for its own failure —
  and it is the reading that adds something, since the parent-side one is
  already covered by `override supervisorStrategy()`.
  Two consequences of expressing a per-child override through parent-side
  machinery are deliberate, and now documented at the call site: an
  `all-for-one` strategy in a child's `Props` still widens to every sibling, and
  the restart budget in `registerRestart` stays per-parent, so siblings share one
  allowance.
- **A stopped or restarted actor's stash goes to dead letters instead of
  vanishing** (#518).  `finalizeTermination` drained the mailbox to dead letters,
  but the stash is a separate buffer on the cell and was never drained; `Restart`
  cleared it outright (`this._stashBuffer = []`).  That is the worst shape a lost
  message can take — a stashed message arrived *earlier* than everything still
  queued, so it is the one a sender is most likely blocked on, and "I told an
  actor and nothing happened, anywhere" cannot be diagnosed from the outside.
  Both paths now route the buffer through `DeadLetter`, the stop path draining
  the stash ahead of the mailbox so the dead-letter stream keeps arrival order.
  The stash still cannot survive a restart — the new instance has none of the
  state that made those messages un-handleable — but the loss is now visible.
  Found while fixing #516, where the stash is provably empty and this was
  therefore out of scope.
- **`ShardMapChanged` is actually published now** (#513).  The event was
  declared, exported, unit-tested for its shape, and consumed in two places —
  the DevTools shard panel (`ClusterTap`) and
  `examples/cluster/counter-node.ts`, which logs `shard map v<n>: n1=6, n2=5,
  …`.  Nothing ever constructed it.  `ShardCoordinator` mutated `shardHome` in
  four places and published nothing, so the panel stayed empty forever and the
  example's listener never fired; both looked wired up until you ran them.  The
  coordinator now broadcasts a `ShardMapUpdate` on every allocation change and
  each region turns it into a local `ShardMapChanged` — via the region, because
  the coordinator only runs on the leader and an event that fires on one node
  out of N is no use to a per-node panel.  Broadcasts are coalesced (allocation
  changes arrive one shard at a time, and a fresh cluster places every shard at
  once), so `version` counts broadcasts rather than individual assignments.
  `ShardMapChanged` also gained an optional fourth constructor argument
  `regions`, which lets `ClusterTap` drop the hard-coded `regions: []` it had
  been rendering; existing three-argument construction is unaffected.
- **A `RemoteActorRef` renders the path it actually points at, and no longer
  compares equal to every other remote ref** (#515).  The path was built as
  `new ActorPath(lastSegment, null, systemName)` — a *root*, and `ActorPath`
  renders a root as `actor-ts://<system>/` without its name, so the name was
  discarded on the spot.  Every remote ref therefore stringified to the same
  address-less value, and because `ActorRef.equals` compares `path.toString()`,
  any two remote refs compared equal regardless of node or path.  The real
  target only survived in `RemoteActorRef.toString()`, which is overridden.
  Two silent consequences went with it: `Receptionist.onRegister` /
  `onDeregister` and `DistributedPubSubMediator.onSubscribe` /
  `onUnsubscribe` / `onUnsubscribeAll` key their local maps on
  `ref.path.toString()`, so every remote registrant or subscriber collapsed
  onto the single key `actor-ts://<system>/` and a second one silently
  overwrote the first; and `ShardRegion`'s passivation and termination lookups,
  which match a candidate against entity refs by `equals`, could never match a
  remote candidate.  The path is now built segment by segment — the shape
  `ClusterSingletonProxy` already used — so it round-trips back to
  `targetPath`.  **Still open:** `ActorPath` carries a system name but no
  host/port, and every member of a cluster shares one system name, so `equals`
  distinguishes paths but not *nodes*; refs to the same path on two members
  remain equal.  `toString()` stays the node-qualified rendering.  Found while
  adding `ClusterSharding.shardRefFor()` (#151).  `parsePathSegments` moved
  from `cluster/RefCodec.ts` to `ActorPath.ts` (internal, not exported from the
  package): it is the inverse of `ActorPath`'s own rendering, and `RefCodec`
  constructs `RemoteActorRef`s, so importing it from there would have closed a
  module cycle.
- **A `PersistentActor` whose `onRecoveryFailure` does not rethrow now stops
  instead of black-holing every command** (#516).  The hook is public and
  overridable, and its default — rethrow, so `preStart` rejects and `ActorCell`
  routes an `ActorInitializationError` to supervision — was the only path anyone
  had tested.  An override that merely *records* the error let `preStart` resolve
  normally, so the cell counted the actor as started while `_recovering` was
  still `true` and `_state` had never been assigned: every command hit
  `onReceive`, was stashed, and vanished.  At command #1025 the hard-coded
  1024-entry stash overflowed, throwing `StashOverflowError` from inside the
  handler — a supervision restart 1024 messages away from the actual cause, whose
  recovery then failed and was swallowed again.  `onRecoveryFailure` is now
  documented as what it is: a *notification*, not a decision.  Rethrow (the
  default) and supervision decides; return, and the actor stops via
  `context.stopSelf()`.  Because the cell drains system messages ahead of every
  user message — with `onCreate` itself running inside that loop — nothing can
  reach `onReceive` without a state, and the stash is provably still empty, so
  commands already queued become dead letters instead of disappearing.
  `PersistentFSM` inherits the fix, which also closes its unguarded `this.state`
  read in `fireTimeoutTransition` — reachable when a state-timeout fire was
  already in the mailbox.  Recovery-failure semantics are now documented on
  `persistent-actor`, `persistent-fsm`, `migrating-adapter` and the FAQ's "Why
  isn't my actor receiving messages?" aside (EN + DE), which previously blamed
  slow recovery for exactly this symptom.
- **A throwing `onRecoveryComplete` is no longer misreported as a recovery
  failure** (#516).  It ran inside the same `try` as the replay, so a bug in the
  user's post-recovery hook was handed to `onRecoveryFailure` — blaming the
  journal for state that had recovered perfectly — and skipped the `unstashAll()`
  that follows it.  Post-recovery user code now runs outside the guard, so it
  reaches supervision as an ordinary actor failure, and the drain moved into a
  `finally`.  `recover()` is reduced to pure replay with no user callbacks.  Its
  old comment claimed commands were "already stashed by the ActorCell" during
  recovery; they are not — nothing can be handled before `preStart` resolves, so
  they wait in the mailbox and that drain is a no-op on every normal path.
- **`bun run lint:package` is reproducible, and `lint:knip` exits 0 again**
  (#507).  The three package-health scripts invoked their tools through `bunx`,
  which — contrary to the first guess — does honour the manifest range and
  resolved the pinned `knip@6.29.0` rather than `latest`; the real problem is
  what `bunx` does when the tool is *absent* from `node_modules`: it silently
  fetches it from the registry and runs anyway, so the check appeared to pass
  judgement on a tree that was never installed.  With `publint` and
  `@arethetypeswrong/cli` missing, knip could not map the `bunx publint` /
  `bunx attw` script invocations back to their manifest entries and reported both
  devDependencies as unused — exit 1 locally while CI, which runs `bun install`
  first, stayed green.  All three scripts now call the installed binary directly
  (`node_modules/.bin` is on `PATH` inside a script), so a missing install fails
  loudly instead of being papered over.  `lint:knip` additionally switches to
  knip's Bun-native `knip-bun` binary: with a *complete* install the Node one
  exhausts its heap on this repo's module graph (`Zone Allocation failed`,
  exit 134).  The `bun run build` prefix moves out of `lint:publint` /
  `lint:types-exports` into `lint:package`, so the build happens once, and
  `package-health.yml` now runs those scripts instead of repeating the
  invocations — the flags live in exactly one place, and a local
  `bun run lint:package` checks what CI checks.  No `ignoreDependencies` entries
  were added: once the binaries resolve, knip attributes them correctly, and an
  unnecessary ignore would hide a real finding later.  Also drops the three
  redundant `entry` patterns from `knip.jsonc` — knip derives `src/index.ts`,
  `src/testkit/index.ts` and `src/devtools/index.ts` from the `exports` map
  itself, which it had been reporting as configuration hints.
- **The whole benchmark suite starts again** (#506).  `bun run bench` was dead:
  ten suites imported the free `ask` helper from the barrel, and that export was
  removed when `ref.ask(…)` became the only ask form.  The removal's adoption
  sweep covered tests, examples and docs but not `benchmarks/`, so every affected
  file died at import with `SyntaxError: Export named 'ask' not found`.  Migrated
  to the method form — `ask<TRequest, TResponse>(ref, message, timeout)` becomes
  `ref.ask<TResponse>(message, timeout)`, the request generic dropping out because
  the ref already carries it.  Three unrelated benchmark type errors that a
  benchmarks-only compile surfaced are fixed in the same pass: a factory typed as
  the *abstract* `typeof PersistentActor<…>` (so it was not newable), a pair of
  mutually-recursive route type annotations, and a `declare const self` colliding
  with the DOM lib.  Also removes a dangling `ask` import from `tests/actor.test.ts`
  — unused, so Bun elided it and the suite stayed green.
- **`bun run bench` reports failures in its exit code** (#506).  The driver
  printed a red `[exit=N]` line for a failed suite and then exited **0**, which is
  how ten broken benchmarks stayed invisible.  It now exits non-zero, listing what
  failed; every suite still runs, so one break does not mask the rest.
- **Broker subscriptions survive a reconnect, and a dropped connection is torn
  down before the next one is built** (#504).  Two compounding defects in
  `BrokerActor` and its subclasses, both of which failed *silently* — the actor
  reported `BrokerConnected` and then received nothing.

  `handleConnectionLost` scheduled a reconnect without ever calling
  `disconnectImplementation`, so it ran **only** from `postStop` and every
  reconnect re-entered `connectImplementation` on top of the previous attempt's
  state.  For `NatsActor` that was fatal rather than merely leaky: its live-handle
  map still held the dead connection's subscriptions, and its
  `if (subs.has(subject)) return` guard therefore skipped re-subscribing — after
  one reconnect **not even the configured `subscriptions` were re-established**.
  `KafkaActor` overwrote its producer and consumer without disconnecting them
  (leaking both on every cycle, and on any connect that failed after
  `producer.connect()` succeeded), `JetStreamActor` abandoned its push
  subscription and pending acks, and `RedisStreamsActor` left the previous
  `XREADGROUP` loop running against the old client alongside the new one.
  `postStop` had the mirror-image bug: it gated on `_state !== 'disconnected'`,
  which is exactly the state a *dropped-but-open* connection sits in, so stopping
  a mid-reconnect actor skipped teardown entirely.  `disconnectImplementation` is
  now called before every re-connect attempt and whenever transport state is
  open at stop, and is documented as idempotent.

  Separately, only *configured* subscriptions were ever restored.  A subscription
  added at runtime (`{ kind: 'subscribe', … }` on `NatsActor` / `KafkaActor`) was
  recorded nowhere, so it vanished on the first drop; and one sent while the actor
  was disconnected was dropped on the floor outright.  `BrokerActor` now owns a
  **desired-subscription set** — `rememberSubscription` / `forgetSubscription`
  plus the `initialSubscriptions` / `applySubscription` / `revokeSubscription`
  hooks — which is connection-independent, seeded from the options exactly once
  (so a runtime `unsubscribe` is not resurrected by the next reconnect), and
  replayed by `applyDesiredSubscriptions()` on every connect.  A subscribe that
  arrives during an outage now lands on the next connect instead of being lost,
  re-subscribing a live subject swaps its target, and a subscription that cannot
  be established is logged as a warning instead of leaving the actor connected
  and deaf.  `MqttActor` already implemented this contract with its own richer
  registry (QoS, multiple targets, deathwatch) and is unchanged.  `NatsActor`
  additionally gains the `createNatsConnection()` test seam its two siblings
  already had — it previously had **no unit test at all**, which is how this went
  unnoticed — and its `onReceive` moves to a `ts-pattern` match over named
  variant types (part of #496).

- **A `TypedActor`'s `terminated` signal is actually delivered** (#448).
  `Signal` declared `{ kind: 'terminated'; ref }`, the docs tabulated it
  alongside `post-stop` and `pre-restart`, and `context.watch`'s own JSDoc
  promised *"you'll receive a Signal when it terminates"* — but that kind was
  **constructed nowhere in the codebase**, so `onSignal` was never called for
  it.  The `Terminated` the runtime enqueues went to the *receive* handler
  instead, typed as `T`, where a handler written against the documented
  protocol had no reason to look for it.  A watched actor's death was therefore
  invisible to every `receiveWithSignal` behavior.  It is now routed to
  `onSignal`, and — unlike `post-stop` and `pre-restart`, where the actor is
  going away regardless — the returned behavior is honoured, so answering
  `Behaviors.stopped` to a child's death stops the parent as the docs promise.
  Gated on a registered `onSignal`, so code that watched an actor and inspected
  the `Terminated` in its receive handler is unaffected.  The path had **no test
  coverage at all** (`receiveWithSignal` appeared in no test), which is how it
  stayed broken; it now has four.

- **A router prunes a routee that has stopped** (#449).  `Router` watched every
  routee it spawned and then ignored the notification, so a dead routee stayed
  in the pool and the strategy kept choosing it: under round-robin **1/N of all
  traffic** went silently to dead letters, and every `Broadcast` lost one
  message.  Nothing surfaced it — the router reported no error and the pool
  still looked the right size.

- **A router rejects a pool size that cannot work** (#455).  `size <= 0` (and a
  fractional or non-finite size) produced a router whose spawn loop never ran:
  an empty pool, every strategy returning nothing, and 100% of messages dropped
  to dead letters with no error anywhere.  All four factories now throw
  `OptionsError` at construction, where the stack still points at the call.
  *Behaviour change:* previously silent, now a throw.

- **`FailureDetector` thresholds: the documentation now matches the code, and a
  contradictory pair is rejected** (#452).  `downAfterMs` was documented as
  *"additional time after which an unreachable peer is declared down"*, and the
  validator's own comment said the two thresholds were therefore "not ordered
  against each other".  `decide` never worked that way: it compares both against
  the time since the last heartbeat and tests `down` **first**.  So with
  `downAfterMs <= unreachableAfterMs` the `unreachable` branch became dead code
  — a peer went straight from healthy to down, skipping the state whose whole
  purpose is to let a transient network blip recover — and nothing rejected the
  configuration.  The JSDoc now describes the absolute measurement (which is
  what the defaults, the docs' ~2.5× ratio guidance and `tombstoneMinRetentionMs
  = 6 × downAfterMs` all already assumed), and `FailureDetectorOptionsValidator`
  fails such a pair with both values in the message.  *Behaviour change:* a
  config that was silently degraded now throws `OptionsError` at construction.

- **A bounded mailbox now honours its bound while the actor is suspended**
  (#407).  The `drop-head` overflow policy called `dequeueUser`, which refuses
  while the mailbox is suspended — so the arm removed nothing, appended the
  incoming message anyway, and still counted a drop.  The queue therefore grew
  **past capacity without limit**, and `actor_mailbox_dropped_total` reported
  evictions that never happened.  Suspension is not an obscure state: it is the
  supervision window, entered whenever an actor throws and waits for its
  parent's decision while messages keep arriving — so the bound went missing at
  the moment it was most needed, and since v0.10.0 made the bounded mailbox the
  **default** (10 000 / `drop-head`), this was the default path.  Overflow now
  evicts through a suspension-independent `removeOldest`, and the counter and
  `onDrop` callback only fire when a message was really removed.

- **Stopping a `ProducerController` no longer leaves in-flight callers hanging
  forever** (#451).  `postStop` settled the *queued* sends — every waiting
  caller got `Error('producer stopped')` — but for in-flight sends it cancelled
  the resend timer and dropped the confirmation callback on the floor.  So a
  caller whose message had already gone out to the consumer and was awaiting an
  acknowledgment was never called back at all: not with success, not with
  failure. Since a confirmation callback exists precisely to guarantee an
  eventual answer, that is the one outcome it must never produce.  Both
  collections are now drained the same way.  Note the window makes this the
  *common* case rather than the rare one: with the default `windowSize` of 16,
  the first 16 unacknowledged sends are all in-flight, and only the 17th
  onwards would have been settled correctly.

- **The DevTools uptime counter stops when nothing answers.**  Every
  other figure on the overview stands still of its own accord once the
  samples stop, because it is a number somebody sent us — uptime was the
  exception, interpolated locally between samples and so still counting
  up minutes after the system it measures had died.  It now freezes at
  the last reading, and the first sample after a reconnect corrects it.
- **DevTools no longer stops a clustered example from starting.** Three
  nodes started from three terminals are three processes, each claiming
  port 9333, and the second and third died outright: *"voice backend
  failed to start: Is port 9333 in use?"*.  A debugger that cannot bind
  is not a reason for the program under debug to die.  The examples now
  take the first free port in the range — `9333`, `9334`, `9335` with no
  flags — and, if that fails too, log a warning and run without DevTools.
  Four separate faults were in the way, each hidden behind the last: the
  example gave up on the first conflict; a failed `attach()` left the
  extension half-attached so a retry hit *"task devtools-detach already
  registered"*; `unbind()` left its own shutdown task behind so the same
  port could never be re-bound; and DevTools' actors kept their names
  until an asynchronous termination settled, so re-attaching hit *"Child
  name 'devtools-hub' is not unique"*.  `attach()` now rolls back
  cleanly, and `attach` → `detach` → `attach` on one system works.

- **Relational journals: a contention-aborted append reports
  `JournalConcurrencyError`, not an opaque `JournalError`** (#479).  The
  optimistic-concurrency backstop assumed a losing writer always gets far
  enough to violate the events primary key.  Against a live MariaDB it does
  not: InnoDB aborts the loser with errno 1020 (`ER_CHECKREAD`, *"Record has
  changed since last read"*) **before** the key is checked, so the race fell
  through to the generic wrapper and callers could no longer tell a retryable
  race from a storage failure.  Found by running the #390 contract's
  "concurrent appends leave exactly one winner" scenario against the live
  MariaDB suite, where it was the only failure; the data was never at risk
  (exactly one event stored, head advanced once) — only the error type was
  wrong.  `SqlDialect` gains `isSerializationConflictError`, implemented per
  dialect (MariaDB 1020/1213/1205, Postgres `40001`/`40P01`, MSSQL 1205/1222,
  SQLite none — it serializes writers with a lock rather than picking a
  victim).  Crucially the bases translate only after re-reading and finding
  the head (or revision) actually moved: a lock-wait timeout against an
  unrelated long transaction stays the storage failure it is, instead of
  becoming a retry loop against a head that will never change.
  `RelationalDurableStateStore.upsert` had the identical hole and is fixed
  the same way.
- **The YugabyteDB certification suite actually runs now** (#401).  Its
  healthcheck probed `127.0.0.1:5433`, but `yugabyted` binds every service to
  the node's advertise address, so loopback never listens.  The container went
  `unhealthy` after a clean startup, compose refused to start the runner on the
  unmet `service_healthy` condition, and the whole thing read as a slow image
  rather than a suite that silently never executed.  It probes the container's
  own address now — and passes all 28 contract scenarios, which makes
  YugabyteDB's ✓ row in the docs true for the first time.  With that, every one
  of the eight database suites has run green against a real server: Postgres,
  MariaDB, libSQL, MSSQL, MongoDB, DynamoDB, CockroachDB, YugabyteDB.
- **Persistence: the InMemory reference stores now match the cross-backend
  contract** (#390).  `InMemoryJournal.append` ran the optimistic-concurrency
  check even for an empty event batch, so `append(pid, [], staleSeq)` threw
  where the SQLite, Cassandra, Postgres and MariaDB journals all return `[]`
  early — nothing is written, so there is nothing to conflict over.  And
  `InMemoryDurableStateStore.upsert` accepted a negative or fractional
  `expectedRevision`, reporting it as a `DurableStateConcurrencyError` (which
  invites an endless retry) instead of the `JournalError` the relational and
  object-storage stores raise for a bogus argument.  Both divergences surfaced
  while specifying the new parameterized persistence contract, which now runs
  one shared scenario set against every `Journal` / `SnapshotStore` /
  `DurableStateStore` implementation — and, via the live-database adapter,
  extends the Postgres and MariaDB Docker suites with the cases they lacked.
  That adapter also fixes those suites, which had been failing since the
  journal high-water mark landed: they reset each scenario with
  `delete(pid, MAX_SAFE_INTEGER)`, which now *sets* the mark to that value, so
  the following `append(pid, …, 0)` correctly reported a conflict.
- **Three wall-clock test assertions no longer flake the coverage gate**
  (#477).  `bun run test:coverage:gate` failed intermittently — not on the
  coverage floor (line coverage sits around 94 %) but because `bun test`
  exited non-zero.  The cause was not clock granularity but the **timer**:
  Bun's event loop decides a deadline is due on the platform's tick boundary,
  so a `setTimeout` whose delay sits just under a tick multiple fires a full
  quantum **early** — a 30 ms timer measured as low as 18.7 ms on
  Bun 1.3.1 / Windows 11 (15.625 ms quantum) and as high as 201 ms under load.
  `after`'s and `assertDoesNotCompleteWithin`'s `>= 25` bounds on a 30 ms
  delay had no margin against that and now assert a quantum below nominal via
  the new `tests/util/TimerTolerance.ts` (which records the measurements), plus
  a deterministic check that the factory is not invoked synchronously.  `retry`'s
  backoff test is off the wall clock entirely — it drives the new
  `RetryOptions.sleep` seam with `ManualScheduler`, asserting attempts at
  virtual 0/20/50 ms and thereby proving the third delay is capped at 30 ms
  rather than 40 ms, which the old `gap2 < 40` bound could not do reliably at
  any tolerance.  Test-only change beyond the `sleep` addition; no runtime
  behaviour changed.
- **Docs site builds from a fresh install again** (#473).  `docs/package.json`
  and `docs/bun.lock` had drifted apart across three dependency bumps — the
  lockfile's workspace header still recorded the pre-bump ranges, so
  `bun install --frozen-lockfile` failed outright ("lockfile had changes, but
  lockfile is frozen").  Worse, PR #472 raised `astro` to `^7.1.3` while
  `@astrojs/starlight@0.39.3` and its transitive `@astrojs/mdx@5.0.4` both
  declare `peerDependencies: { astro: "^6.0.0" }`; a clean install resolved
  astro 7 and `astro build` died on `Package subpath './jsx/rehype.js' is not
  defined by "exports"`.  The `astro` range is back at `^6.4.8` (the other
  bumps are peer-compatible and stay) and `docs/bun.lock` is regenerated, so
  package.json and lockfile agree.  (Astro 7 lands separately, together with the
  Starlight release that peer-supports it — see Changed → #474.)
  Both CI docs workflows now install with
  `--frozen-lockfile`, and `docs-checks` — which runs on every `docs/**` change
  — gained a lockfile-sync job, so this drift fails on the PR instead of
  silently at release time.

- **Dead-letter delivery no longer recurses into a stack overflow.**  An
  actor subscribed to the `DeadLetter` channel that stopped without
  unsubscribing made every subsequent dead letter bounce between the
  event stream and the dead-letter office until the stack blew.  A dead
  letter wrapping another dead letter is now dropped — that nesting is
  the loop signature, and there is nowhere further to send an
  undeliverable dead letter.

- **Persistence: uniform `JournalError` wrapping + consistent missing-dependency
  hints** (#383).  Driver errors from the read-side journal methods
  (`highestSeq`, `delete`, `persistenceIds`, and Cassandra's `read`) now surface
  as `JournalError` across all backends, matching what `append`/`read` already
  did — callers can catch one error type regardless of backend.  The
  Cassandra driver is now lazy-imported through the shared `lazyImportModule`
  helper (was a hand-rolled `try/catch` with a `bun add` hint), so its
  missing-dependency message matches Postgres/MariaDB.  Fixed the doubled verb
  in the Postgres/MariaDB hint ("…backends require **requires** the 'pg'
  package") by dropping the trailing word from the `context` string.
- **Persistence examples repaired** (#382).  `examples/persistence/scylla-ledger.ts`
  and `benchmarks/persistence/recovery.ts` overrode `snapshotPolicy` as a
  property (`override readonly snapshotPolicy = everyNEvents(...)`) while the
  base declares it as a method, which threw `snapshotPolicy is not a function`
  on the first persist — both now override the method.  `examples/persistence/
  cassandra-plugin-hello.ts` imported `FakeCassandraClient` from a stale
  pre-test-split path and used the removed free `ask(...)` function; it now
  imports from `tests/integration/in-process/persistence/` and calls
  `ref.ask(...)`.
- **Persistence (Cassandra): single-flight `start()`, a live `consistency`
  option, and an accurate batch comment** (#380).  `CassandraJournal.start()`
  and `CassandraSnapshotStore.start()` set `started` only at the very end, so
  two concurrent first calls both ran `connect()` + DDL; they now share a
  single in-flight start (a failed start clears the guard so a later call
  retries).  The `consistency` option (exposed as `withConsistency`) was
  declared but never sent — every read, write, and batch now passes the
  configured CQL consistency level.  The `append` comment that claimed a logged
  batch "only if same partition" (while the code always passed `logged: false`)
  is corrected to describe the actual unlogged-batch-per-partition behaviour and
  why it is safe under the single-writer contract.
- **Persistence: `highestSeq` no longer rewinds to 0 after a full delete**
  (#379).  When `delete(pid, toSeq)` removed every event for a persistenceId,
  the in-memory, SQLite, Postgres and MariaDB journals recomputed the highest
  sequence number as `MAX(sequence_nr)` over the now-empty stream and returned
  0 — so a recovered `PersistentActor` (snapshot at seq N, `deleteHistory(N)`,
  then `persist`) sent `expectedSeq = N` against an `actualSeq` of 0 and hit a
  spurious `JournalConcurrencyError`; worse, sequence numbers could be reused.
  Each backend now keeps a monotonic high-water mark — an in-memory map for
  `InMemoryJournal`, a small additive `<events>_meta(persistence_id,
  deleted_to)` table (auto-created, `IF NOT EXISTS`) for the SQL backends — so
  the counter never rewinds, matching Cassandra (which already tracked it in
  its metadata table) and Akka semantics.  A parameterized contract test
  covers full- and partial-delete-then-append across all four backends.
- **Persistence: closing one store no longer tears down a shared connection
  pool / backend** (#378).  The Postgres and MariaDB journal, snapshot-store,
  and durable-state-store `close()` methods used to call `pool.end()`
  unconditionally — so when a single pool was injected and shared across all
  three stores (the arrangement `registerPostgresPlugins` recommends), closing
  one store ended the pool out from under the others.  Each store now tracks an
  `ownsPool` flag and only ends a pool it built itself; an injected pool is left
  to the caller.  The object-storage plugin had the mirror-image bug — both the
  snapshot and durable-state stores closed the *same* shared backend — so the
  stores gained an `ownsBackend` option (default true for standalone use; the
  plugin sets it false) and `registerObjectStoragePlugins` now returns a
  `close()` handle that closes the shared backend exactly once.
- **Persistence: a misconfigured journal / snapshot-store plug-in now fails
  fast instead of silently falling back to in-memory** (#377).  When
  `actor-ts.persistence.journal.plugin` (or the snapshot-store key) names a
  plug-in id that has no registered factory — e.g. the config is set but the
  matching `registerXxxPlugins(...)` call was forgotten or ordered after the
  first `PersistentActor` spawn — `PersistenceExtension` used to hand back the
  in-memory implementation with no warning, so events were written to a
  volatile store and lost on restart.  It now throws
  `Unknown journal plugin '<id>': …` (and the snapshot-store equivalent).  The
  zero-config default is unchanged: with no plugin key set, the in-memory
  reference implementation is still used.
- **Public-API exports completed.**  Several documented/exported symbols
  were unreachable from the package root: the CRDT map types (`LWWMap`,
  `ORMap`, `GCounterMap`, `MVRegister`), the `LeaseMajority` downing
  strategy (+options), `eventDispatcher`, `CachedSnapshotStore` (+options),
  `reEncryptObjectStorage` / `InMemoryReEncryptProgressStore`, and the
  `MasterKeyRing` types.  They are now re-exported from `actor-ts`, and the
  TestKit multi-node helpers (`MultiNodeSpec`, `ParallelMultiNodeSpec`,
  `MockCluster`, `SnapshotMigrationTest`) are reachable via a new
  `actor-ts/testkit` subpath — the in-repo examples no longer need deep
  relative imports.
- Corrected stale JSDoc on public symbols surfaced by the docs audit
  (`CoordinatedShutdown` `recover` flag, `JsonLogger` `source` field,
  `DeathPactError`, `TestProbe.receiveN`/`fishForMessage` parameter names,
  HTTP backend references, `PersistentActor` reply example,
  `NatsActor`/`JetStreamActor` out-of-scope notes).

### Security

- **The cluster-singleton proxy buffer is bounded** (#526).
  `ClusterSingletonProxy` held every message sent before the cluster had a host,
  with no cap and no overflow policy.  That wait is normally a gossip round —
  which is why buffering is the right answer — but nothing bounds how long it
  can last: unreachable seeds, or a partition in which this node sees nobody,
  keep the cluster there for the length of the outage while the application
  keeps sending.  Unbounded, that is a memory leak that ends the process.
  A new `bufferSize` (`StartSingletonOptions.withBufferSize`, default `1_000`)
  drops the newest message to dead letters past the cap, with a latched
  warning and a `droppedCount` for metrics — dropping the *newest* because the
  buffer exists to preserve send order and evicting from the front would hand
  the singleton a torn prefix of it.  Every other buffered path in the
  framework (mailboxes, WebSocket frames) was already bounded; this one was
  the gap.
- **`ClusterSingletonManagerOptions` is validated** (#526).  The one options
  family in the cluster layer with real constraints and no validator.  The new
  `ClusterSingletonManagerOptionsValidator` asserts the required `cluster` /
  `typeName` / `singletonProps` and checks `typeName` / `role` non-empty and
  `acquireRetryIntervalMs` positive, running once in the manager's
  constructor.  Narrow by construction — the extension is normally the only
  thing that builds these, and it validates `StartSingletonOptions` first — so
  this closes the door for a caller constructing the manager directly, who
  previously got a `Cannot read properties of undefined` from inside
  `preStart` instead of an `OptionsError`.
- **A rejected CAS no longer wedges an object-storage durable-state entry**
  (#117).  When the backend refused a `put` on a stale `If-Match`, the store
  threw the concurrency error but **kept the rejected etag cached** — and that
  cache is what the next `If-Match` is built from.  So every retry re-sent the
  etag the backend had just rejected and failed identically, and worse, the
  up-front revision check answered from the same stale cache, reporting a
  revision that was no longer the truth.  The entry stayed stuck until
  something happened to call `load` or `delete`.  The etag is now dropped on
  rejection, which routes the retry into the refresh-and-recover path that
  already existed for a cache wiped by a restart.

- **The re-encryption sweep validates keys it gets from `list()`** (#123).  Keys
  come from the bucket, not from the framework, and the sweep derives its HKDF
  salt from the key — then **rewrites the body**.  A key that yielded no usable
  persistence id (empty, or one carrying control characters) therefore did not
  merely fail to decrypt: it would re-encrypt data under a salt the owning store
  never reproduces, leaving it permanently undecryptable.  Such keys are now
  skipped before being fetched and reported in the new
  `ReEncryptResult.skippedMalformedKey` — a non-zero count is worth
  investigating, because nothing the framework writes produces one.  The
  key-shape rules are the shared `makeKeyValidator` ones, so the sweep cannot
  drift from the storage backends.

- **`safeStringify` for error paths** (#146).  `ClusterClient.handleReply` built
  its rejection message with a bare `JSON.stringify` on a body received from the
  cluster.  Worth stating precisely, because the issue title overstates it:
  wire bodies arrive as parsed JSON and so **cannot** be circular, and
  `JSON.stringify` throws rather than hangs.  The real defects were that
  `handleReply` was not wrapped, so any throw escaped into the socket decoder
  loop and abandoned **every remaining frame in the same batch** — leaving those
  asks to time out — and that the guarantee rested on the frame codec staying
  JSON-only.  A new `src/util/SafeStringify.ts` renders cycles, `BigInt`,
  functions, symbols and throwing getters without ever throwing, and caps its
  output so a large body cannot become a large message; the reply handler is now
  wrapped so one bad frame cannot take its batch with it.

- **A TCP socket's nested framing caps are validated** (#372).
  `TcpSocketOptionsValidator` checked `host` and `port` but never looked inside
  `framing`, where both inbound size limits live — and those are DoS caps: a
  frame past the cap drops the connection instead of buffering without bound.
  The failure mode is worse than a merely wrong number.  Both are applied as
  `length > cap`, and *every* comparison against `NaN` is `false`, so a
  non-numeric value read from HOCON did not clamp anything — it **removed the
  cap** and restored the unbounded buffering the limit exists to prevent.  Zero
  or negative failed the other way, dropping every connection immediately.
  `framing.maxLineLen` and `framing.maxFrameLen` must now be positive integers;
  unset still falls through to the defaults (1 MiB / 16 MiB).  The rule is
  spelled out with `fail` because the typed check helpers only reach top-level
  fields.

- **`ask` reply refs get unpredictable names** (#119).  The one-shot reply ref
  was named from a module-global `++askCounter`, which is predictable — anything
  able to address a ref by path could aim a forged reply at an in-flight ask —
  *and* shared across every `ActorSystem` in the process, so the Nth ask in two
  independent systems drew the same name.  Over a long run the counter also
  wrapped into collisions with names still in flight.  Names are now
  `askResp-` plus 12 hex characters from `crypto.randomUUID`, the same primitive
  `ClusterClient` moved to for its ask ids (#120).

- **Numeric gossip and heartbeat fields are checked for plausibility**
  (#113, #115).  Two peer-supplied numbers were used without a look:
  - **`removedAt` on a tombstone** (#113) decides whether the entry ages out, and
    the comparison failed **open**: at `Infinity` or `NaN`,
    `Date.now() - removedAt` is `-Infinity` or `NaN`, neither of which is
    `>= ttl`, so the tombstone looked fresh on *every* merge and never expired.
    A far-future value did the same through a negative age.  Since a tombstone
    suppresses its address, one forged frame kept a node from ever rejoining —
    the same shape as the `version` DoS fixed earlier, whose guard sat directly
    above this code.  `removedAt` now gets that same finite-and-not-far-future
    check.
  - **`seq` and `ts` on a heartbeat** (#115) were unvalidated, and `seq` was
    echoed straight back in the acknowledgment.  Nothing consumes either field
    today (`onHeartbeatAcknowledgment` is a no-op, `ts` is unread), so this is a
    boundary guard rather than a live exploit — recorded plainly because the
    honest reason to fix it is that a `NaN` reaching future RTT or clock-skew
    tracking would be silent nonsense.  An implausible frame is now dropped;
    that is safe because `handleWire` has already recorded liveness from the
    socket-level address, so refusing the frame cannot make a live peer look
    unreachable.

- **Actor names are validated, closing a path-forging and a log-injection hole**
  (#126, #134).  `ActorPath` accepted any string, and a path is rendered by
  joining segments with `/` and taken apart again by splitting on it
  (`RefCodec.parsePathSegments`) — so `spawn(props, 'a/b')` did not merely look
  wrong, it changed the path *structure*, producing something indistinguishable
  from a child `b` of an actor `a`.  That collides with, or impersonates, a
  different actor, and it crosses the cluster wire, where the remote side
  re-splits the string.  `.` and `..` carried the same risk through traversal
  meaning.  Separately, a name containing a newline let a caller forge log lines,
  since paths are written to logs and trace spans.
  A name is now rejected if it contains `/`, `\` or a control character, if it is
  `.` or `..`, or if it is empty below a parent — empty stays legal for a root,
  which `deadLetters`, `nobody` and the test probe rely on.  Everything else
  still works, including spaces, interior dots and non-ASCII
  (`'Order.Placed'`, `'entity#3'`, `'日本語'`).
  *Behaviour change:* previously silent corruption, now a throw at spawn time.
  The docs used to tell readers to *"validate segments yourself"*; that guidance
  is replaced by the rule the framework now enforces.

- **The default 500 response no longer echoes the thrown message** (#356).  All
  three backends put `message: err.message` in the body of an unhandled error,
  and a thrown `Error`'s text routinely carries filesystem paths, SQL fragments,
  connection strings or driver internals — none of which is a client's business.
  `defaultErrorResponse` in `Route.ts` was always correct and says so in its
  JSDoc (*"deliberately does NOT echo the thrown message"*); the backends simply
  did not route through it, so the WebSocket-reject and `fallback()` paths were
  safe while every ordinary route was not.  The generic 500 is now
  `{ error: 'Internal Server Error' }` on Fastify, Express and Hono alike.
  An `HttpError`'s own message is still returned — it is authored by the
  application *for* the client — and `withErrorHandler` remains the way to
  surface or log the detail. There was no test either way; there are now three
  per backend.

- **HOCON config parsing can no longer reach the object prototype** (#406).
  A key path is expanded segment by segment onto a plain object, and
  `object[key] = value` invokes the inherited `__proto__` *setter* rather than
  creating an own property — so `__proto__.polluted = true` in any config
  source descended into `Object.prototype` and polluted **every object in the
  process**, while the parsed config still came back as `{}`.  That silence is
  what made it dangerous: nothing in the result hinted at what had happened.
  Three further vectors went with it — a single-segment `"__proto__" { … }`
  replaced the config object's own prototype, `${__proto__}` spliced the
  prototype object into a resolved value, and `deepMerge` carried an *own*
  `__proto__` property (which `JSON.parse` produces and `Object.entries`
  reports) through into the merged result, `{ ...base }` included.
  `__proto__`, `constructor` and `prototype` are now refused as config keys and
  as substitution paths, with a source position like any other parse error, and
  the exported `deepMerge` / `stripUndefined` / substitution walk filter them as
  defence in depth for objects that arrive from plain JavaScript rather than
  from HOCON.  The guard is exact-match, so `_proto_`, `constructorName` and
  `prototypes` keep working.  Note the earlier `__proto__` fix (#9) hardened the
  **JSON serializer** — the config parser was a separate, unguarded path.
  Verified by 11 unit tests plus a cross-runtime smoke case, since how a plain
  assignment meets the prototype setter is engine behaviour rather than library
  behaviour.

- **Cassandra journal: concurrent appends no longer silently lose events**
  (#475).  `CassandraJournal.append` did a plain read-modify-write — read the
  head from `metadata`, compare it to `expectedSeq`, then `INSERT` the events.
  A CQL `INSERT` is an *upsert*, so two writers that both read head `N` both
  passed the check and both wrote `sequence_nr = N+1`: the second overwrote the
  first, and **both callers were told their event was persisted**.  Six racing
  appends produced six successes, one surviving event, and no
  `JournalConcurrencyError`.  The relational backends never had this — their
  events primary key rejects the loser and the duplicate-key error is
  translated back into `JournalConcurrencyError` — so Cassandra was the only
  backend where a system-of-record write could vanish without a trace.
  Appends now claim their sequence range with a **lightweight transaction** on
  the `metadata` row (`IF NOT EXISTS` for a fresh stream, `IF max_sequence_nr =
  ?` thereafter) *before* any event is written, so exactly one writer wins and
  every loser gets a `JournalConcurrencyError` carrying the real head.
  *Behaviour change:* an append now costs one Paxos round-trip — roughly 3–4×
  the latency of a plain quorum write, per `append` rather than per event.
  Cross-pid throughput is unaffected (each claim contends only on its own
  `metadata` partition).  Claiming before writing also inverts the crash
  window: a failed event batch triggers a compensating release of the claim,
  but a process death between the committed claim and the events leaves a gap
  (head ahead of stored events) instead of the previous orphan-events case.
  Both are documented in `docs/.../persistence/journals/cassandra.mdx`.
  `withLightweightTransactions(false)` restores the old single-round-trip
  path — and the old race with it.
- **Persistence: event tags are validated at the journal boundary** (#136).
  Tags (from `PersistentActor.tagsFor`, often derived from user input) are
  always bound as query parameters, so SQL/CQL injection was never reachable —
  but they were otherwise unchecked.  A shared `assertValidTags` now runs in
  every journal's `append` and rejects a comma (which would split into extra
  tags out of SQLite's CSV `tags` column and corrupt a peer event's tag list),
  control characters / newlines (log-injection family), and enforces per-tag
  length (255) and per-event count (64) caps against index/row-size blow-ups.
  Also, `CassandraSnapshotStore` now validates its keyspace + table
  identifiers through `assertSafeIdentifier` (the journal already did), closing
  the last raw-interpolation gap in the Cassandra backend.

### Documentation

- **`Cluster.leader()` and `KeepOldest` say what they actually do** (#525).
  Both were documented — in JSDoc, in `cluster/overview`, in
  `cluster/downing-strategies` — as picking the **oldest** member.  Neither
  does: `upMembers()` sorts by address and both take `[0]`, so the winner is
  the **lowest-addressed** member.  Address order and join order are unrelated,
  so a node that joined a minute ago outranks one that has been up for a week
  whenever its address sorts lower.

  The semantics stay — the one property leadership needs is that every node
  names the same one, and address order delivers that without a monotonic join
  sequence on the wire — and the descriptions are corrected instead, with the
  rule stated once, canonically, under *The leader* in `cluster/overview`
  (EN + DE).  `KeepOldest` is the sharper end of this: a split-brain resolver
  is chosen *for* its tiebreak, and that page actively recommended relying on
  "a long-running 'stable' node (a coordinator pod) that's almost always the
  oldest" — which address ordering does not deliver.  It now says to pin the
  address of the node that should survive.  A test pins the contract: a
  later-joining, lower-addressed node takes leadership immediately, which the
  existing leader test could not catch (its lowest-addressed node was also the
  seed, so the two orderings agreed).
- **Persistence doc snippets reconciled with the real API** (EN + DE, #384).
  `projections.mdx` / `persistence-query.mdx` / `push-based-query.mdx` used
  `new SqliteQuery({ path })` (the constructor takes a `SqliteJournal`
  instance) and a nonexistent `SqliteOffsetStore`; they now construct a
  `SqliteJournal` and use `InMemoryOffsetStore` / `DurableStateOffsetStore`.
  `operations/upgrades/rolling-migration.md` used the renamed
  `MigrationChain.start(...).next(...)` (now `MigrationChain.for(...).add(...)`).
  The new `PersistenceExtension.configure` method makes the previously-documented
  `.configure(...)` call real; the docs-audit pass instead migrated the journal /
  snapshot-store pages to the builder-first `ActorSystemOptions.withPersistence(...)`
  at system creation (both are valid ways to wire persistence).  A new
  `docs/scripts/check-api-drift.mjs` guard (`npm run check:api-drift` in
  `docs/`), wired into a `docs-checks` CI workflow that runs on every docs
  change, fails on any reappearance of a removed/renamed API name (#385).
- **Large docs↔source audit pass** (EN + DE) — corrected default values
  (gossip interval 500 → 1000 ms, bounded-mailbox default), reworded stale
  caution boxes, rewrote drifted pages (conflict-resolver, key-rotation,
  single-writer-lease, push-based-query) to the real APIs, and added a
  dedicated NATS JetStream guide page.

## [0.11.0] — 2026-07-15

### Changed — Naming conventions: no abbreviations, unified vocabulary

Repo-wide naming sweep for consistency.  Pre-1.0, so these are hard
renames with no deprecation shims.  All are mechanical — same behavior,
new names.

- **BREAKING — WebSocket → `Websocket` (single-cap), no `Ws` abbreviation.**
  Every identifier and file/dir uses the `Websocket` spelling:
  `WebSocketServerActor`/`WebSocketClientActor` → `WebsocketServerActor`/
  `WebsocketClientActor`; the `Ws*` supporting types (`WsConnection`,
  `WsCodec`, `WsFrame`, `WsServerMessage`, …) → `Websocket*`; `wsSend()` →
  `websocketSend()`; `DEFAULT_WS_MAX_FRAME_BYTES` →
  `DEFAULT_WEBSOCKET_MAX_FRAME_BYTES`; the module moved
  `src/http/ws/` → `src/http/websocket/`.  The `websocket()` routing
  directive, the global `WebSocket`, the `ws` package's `WebSocketServer`,
  and the `Sec-WebSocket-Protocol` header are unchanged.
  *Migration:* replace `Ws`/`WebSocket` identifier prefixes with
  `Websocket`; `wsSend` → `websocketSend`.
- **BREAKING — abbreviations spelled out** in type/member names: `*Cmd` →
  `*Command`, `*Msg` → `*Message`, `*Ack` → `*Acknowledgment`, `ByPid*` →
  `ByPersistenceId*`, `*Impl` → `*Implementation`, `*Ctor` → `*Constructor`.
  Wire/discriminator string literals are unchanged.
  *Migration:* e.g. `MqttCmd` → `MqttCommand`, `EnvelopeMsg` →
  `EnvelopeMessage`, `SubscribeAck` → `SubscribeAcknowledgment`.
- **BREAKING — testkit assertions spelled out too:** `TestProbe.expectMsg()`
  → `expectMessage()`, `TestProbe.expectMsgType()` → `expectMessageType()` —
  the last `Msg` holdouts, now consistent with `expectNoMessage()`.
  *Migration:* rename the calls; signatures and behavior are unchanged.
- **BREAKING — one config vocabulary: `Options`, never `Settings`.**
  Remaining `*Settings` types → `*OptionsType` (`CircuitBreakerSettings`,
  `TlsTransportSettings`, `Bounded/PriorityMailboxSettings`,
  `ManagementRoutesSettings`, `ConsumerControllerSettings`,
  `KeepMajoritySettings`, the testkit specs); `BrokerSettings.ts` folded
  into `BrokerOptions.ts` (`BrokerSettingsError` → `BrokerOptionsError`);
  the `BrokerActor` glue `readSettingsFromConfig`/`requiredSettings`/
  `builtInDefaults`/`settings` → `readOptionsFromConfig`/`requiredOptions`/
  `builtInDefaultOptions`/`options`; `default{FailureDetector,PhiAccrual}Settings`
  → `default*Options`.  New dedicated `ConsumerControllerOptions` +
  `KeepMajorityOptions` files with builders.
- **BREAKING — Command vs Signal unified on `kind`.**  MQTT and WebSocket
  internal mailbox signals are now `kind`-tagged plain objects (dispatched
  by `kind`, like the typed-actor `Signal`), not `instanceof`-dispatched
  classes; the bad-payload hook is `onInvalidMessage` everywhere (MQTT's
  `onDecodeError` is gone); `WebSocketAcceptSignal` → `WebsocketAcceptCommand`
  and `WebsocketClientSend` is a command, both lifted out of the `*Signal`
  unions.
  *Migration:* override `onInvalidMessage` instead of `onDecodeError`;
  construct outbound sends via `websocketSend(msg)` (unchanged).
### Added — Options validation

- **`OptionsValidator` + `OptionsError`** (#274) — a declarative-but-code
  validator layer for the `XOptions` pattern.  Each options file with
  constrained fields exports an `XOptionsValidator` (`extends
  OptionsValidator<XOptionsType>`, brokers via `BrokerOptionsValidator`) whose
  `rules(s)` uses typo-checked, no-op-on-`undefined` helpers (`port`,
  `positiveNumber`, `positiveInt`, `nonNegativeInt`, `oneOf`, `nonEmptyString`,
  `url`, …) plus `fail(field, reason, value)` for cross-field rules.  Validation
  runs **once at consume time on the merged settings**, so builder, plain-object,
  and HOCON inputs are all checked and cross-field rules see the final values —
  broker actors via the `optionsValidator()` hook (in `preStart`, after the
  required-field check), non-broker consumers via one
  `new XOptionsValidator().validate(settings)` call in their constructor.
- **Validators shipped for**: every broker (MQTT, Kafka, AMQP, Redis Streams,
  NATS, JetStream, SSE, TCP, UDP, gRPC client) and the WebSocket client; the
  cluster core (`Cluster`, `ClusterBootstrap`, `FailureDetector`, `PhiAccrual`,
  `ClusterClient`, `ClusterClientReceptionist`, `StaticQuorum`, `KeepReferee`,
  `LeaseMajority`, `ClusterRouter`), sharding (`Sharding`, `StartSharding`,
  `ShardedDaemonProcess`) and singleton (`StartSingleton`); discovery
  (`AutoDiscovery`, `ConfigSeedProvider`, `DnsSeedProvider`,
  `KubernetesApiSeedProvider`, `Receptionist`) and gossip intervals
  (`DistributedPubSub`, `DistributedData`); leases (`Lease`, `KubernetesLease`);
  caches (`RedisCache`, `MemcachedCache`, `CachedSnapshotStore`); the
  `CassandraJournal` and S3 / filesystem object-storage backends; the
  Express/Hono HTTP backends; `WorkerCluster`; delivery `ProducerController`;
  and `TestProbe`.  Options whose fields carry no real constraint
  (all-boolean/string/callback, or degrade-gracefully knobs like snapshot
  `keepN` where `<= 0` means "keep all") intentionally get no validator.

### Changed — Options validation

- **BREAKING** (#274) — invalid **option values** now throw `OptionsError` at
  construction / actor start instead of a bare `Error` (or, previously, going
  unchecked on the builder/plain-object path).  Notably MQTT `protocolVersion`
  outside `{4, 5}` now throws `OptionsError` on **all** input paths (previously
  only the HOCON path threw, as a bare `Error`).  *Migration:* catch
  `OptionsError` (exported from the package root) where you previously matched
  the ad-hoc `Error` message.  Missing **required** broker settings still throw
  `BrokerOptionsError`; malformed HOCON still throws `ConfigError`.
- **BREAKING — `InMemoryCache` joins the `XOptions` family.** It now takes an
  `InMemoryCacheOptions` builder (or plain object) with `withMaxEntries` /
  `withCleanupMs`, validates via `InMemoryCacheOptionsValidator` (out-of-range
  values throw `OptionsError` instead of a bare `Error`, and `cleanupMs` — a
  negative / `NaN` sweep interval — is now checked too), and reads its defaults
  from HOCON `actor-ts.cache.in-memory.{maxEntries, cleanupMs}` via the
  `CacheExtension` (previously the bounds were unreachable through the
  extension).  The internal `InMemoryCacheSettings` interface is **removed** —
  use `InMemoryCacheOptionsType` (both `InMemoryCacheOptions` and the type are
  now exported from the package root).  *Migration:* a plain
  `{ maxEntries, cleanupMs }` object still works unchanged; only the type name
  changed.
- **WebSocket route / policy options are now validated.** The resolved
  per-connection policy (`maxFrameBytes`, `maxBufferedBytes`, `maxConnections`,
  and the `onOversizeFrame` / `onInvalidMessage` / `onBackpressure` enums) is
  checked on every path — route options, HOCON `actor-ts.http.websocket`, and
  defaults — via `WebsocketPolicyOptionsValidator`, and `allowedOrigins` via
  `WebsocketRouteOptionsValidator`.  Bad values throw `OptionsError` (the enum
  guard previously threw a bare `Error`, and only on the HOCON path; the
  numeric knobs — e.g. `maxConnections: 0`, which silently admitted nobody —
  were unchecked).  The reference config now ships an `actor-ts.http.websocket`
  section documenting the defaults.
- **The object-storage decompression cap is now a store option.** The 512 MiB
  decompression-bomb guard (#3) was pinned to its default because the stores
  called `decodeBody` without a cap.  `withMaxDecompressedBytes` is now on
  `ObjectStorageSnapshotStoreOptions`, `ObjectStorageDurableStateStoreOptions`,
  and `ObjectStoragePluginOptions` (validated at construction — a non-positive
  / non-integer cap throws `OptionsError`, `Infinity` opts out), and both
  stores forward it into `decodeBody`.  Raise it to restore a legitimately
  large snapshot / state blob, or lower it for a tighter bound.
- **HTTP middleware + directives now validate their options.** Added
  `OptionsValidator`s for `TimeoutOptions` (`ms`), `HstsOptions` (`maxAge` plus
  the preload cross-field), `CorsOptions` (`maxAge` plus credentials-vs-`*`),
  `CsrfOptions` (present-secret length, cookie `sameSite` / `maxAgeSeconds`),
  and `StaticFilesOptions` (`maxFileSize`, `dotfiles` / `symlinks` enums); the
  ad-hoc bare-`Error` validity checks in the consumers now throw `OptionsError`
  (required-field guards stay as-is).  `rateLimit` and `idempotent` also gained
  the real `RateLimitOptions` / `IdempotencyOptions` fluent builders they were
  already documented to have, each with a validator (`windowMs`/`max`,
  `ttlMs`/`missingHeader`); the plain-object call form is unchanged.
- **`CircuitBreaker` and `BoundedMailbox` now validate their options too** —
  the last exported options types with real numeric constraints join the
  validator family.  `CircuitBreakerOptionsValidator` checks `maxFailures`
  (integer >= 1), `resetTimeoutMs` (finite >= 0), and the previously-unchecked
  `callTimeoutMs` (> 0 — omit it to disable the per-call timeout; `0`, which
  previously meant "no timeout" silently, now throws), and requires
  `maxFailures`/`resetTimeoutMs` at runtime (a builder without them previously
  produced a breaker that silently never opened).
  `BoundedMailboxOptionsValidator` checks `capacity` (integer >= 1, and now
  required — previously a missing `capacity` made the "bounded" mailbox
  silently unbounded) and the previously-unchecked `overflow` enum.  The old
  ad-hoc bare-`Error` guards now throw `OptionsError`.

### Added — HTTP hardening

- **Scoped error handling + fallback routes** (#352) — `handleErrors(handler,
  child)` catches exceptions from a subtree (akka-http `ExceptionHandler`
  style; sees the original error, returns a response or `null` to decline);
  `fallback(handler)` answers any unmatched request via each backend's
  not-found hook; `ServerBuilder.withErrorHandler(...)` is the server-wide
  last resort.  Precedence, uniform across Fastify/Express/Hono: innermost
  `handleErrors` → `withErrorHandler` → framework default.
- **HTML response utilities** (#352) — `escapeHtml`, an auto-escaping `html`
  tagged template with a `SafeHtml` brand, `rawHtml` escape hatch, and
  `completeHtml` (`text/html` + `nosniff`).
- **Security-middleware suite** (#353) — `cors` (a route directive that the
  compiler expands into per-pattern preflight `OPTIONS` routes),
  `strictTransportSecurity` / `hsts`, `contentSecurityPolicy`,
  `csrfProtection` + `requireSameOrigin`, `securityHeaders`, `requestId`,
  `BasicAuth`, and `requestTimeout` — each with an `XOptions` builder.  Plus
  public `parseCookies` / `serializeCookie` helpers.
- **Static file serving** (#354) — `getFromFile`, `getFromDirectory`, and
  `getFromBrowseableDirectory`: MIME detection, index resolution, conditional
  requests (weak ETag + `Last-Modified` → 304), single `Range` (206/416),
  HEAD, trailing-slash redirects, and XSS-safe directory listings.
- **MIME-type registry** (#354) — `contentTypeFor(pathOrExt, overrides?)` and
  `DEFAULT_MIME_TYPES`.
- **Streaming response bodies** (#354) — `HttpResponse.body` now accepts a web
  `ReadableStream<Uint8Array>`, written natively by all three backends.

### Changed — HTTP hardening

- **`Middleware` `next()` accepts an optional request override** (#353) —
  `next(req?)` lets a middleware enrich what the handler sees (request-id,
  CSRF token).  Backward compatible.
- **HonoBackend now answers `HEAD` on `GET` routes** (#354), matching
  Fastify/Express; a route pattern ending in `/*` exposes the remainder as
  `req.params['*']` on every backend.
- **BREAKING:** the `Route` / `CompiledEndpoint` unions gain `fallback` and
  `cors` variants — an exhaustive `match` over `Route` must handle them
  (#352, #353).
- **BREAKING:** `ServerBuilder` gains a required `withErrorHandler` method —
  structural third-party implementers must add it (#352).
- **BREAKING:** `HttpError`'s constructor gains an optional 4th `headers`
  parameter (after `extra`); `BearerTokenAuth` 401s now expose the challenge
  on `err.headers['www-authenticate']`, no longer `err.extra.wwwAuthenticate`
  (#352).

### Security

- **CORS, CSRF, and security-header middleware** (#353) — origin allowlisting
  with correct preflight handling, an HMAC-signed double-submit CSRF token
  (plus an Origin/Referer check), and HSTS / CSP / COOP / CORP / nosniff /
  frame-options; secret comparisons are constant-time.
- **`WWW-Authenticate` reaches the wire** (#353) — `BearerTokenAuth` (and the
  new `BasicAuth`) 401s emit a real challenge header instead of burying it in
  the body.
- **Hardened path-traversal defence for static files** (#354) — the URL
  remainder is fully decoded before validation, every segment is rejected if
  it is `..`, empty, NUL, a backslash, or a `:` (drive/ADS) segment, absolute
  forms are refused, the joined path is confined to the root, symlink escapes
  are refused, and dotfiles are denied — every rejection a uniform 404.

- **WS-1 (HIGH) — WebSocket upgrade crash hardened**.
  A malformed percent-escape in the upgrade path (e.g. `GET /room/%ZZ` against a
  `websocket('/room/:id', …)` route) made `decodeURIComponent` throw inside the
  Express backend's fire-and-forget upgrade handler, surfacing as an *unhandled
  rejection* — process-fatal under Node's default and reachable **pre-auth** by
  an unauthenticated client.  `matchWebsocketPattern` now treats a malformed escape as
  a non-match (→ 404), and the Express upgrade handler attaches its socket
  error-guard before any async work and wraps the handler in a last-resort
  `.catch` that closes the socket.  Fastify/Hono were not affected.
- **WS-2 (HIGH) — Cross-Site WebSocket Hijacking (CSWSH) defence**.  No upgrade handler validated the `Origin` header, so a
  malicious web page could open an authenticated WebSocket riding a victim
  browser's ambient cookie/IP auth.  New **`allowedOrigins`** option on
  `websocket()` routes (`.withAllowedOrigins([...])` on the builder): an upgrade
  whose `Origin` is present but not listed is rejected with 403 before the
  handshake on all three backends; a missing `Origin` (non-browser client) is
  allowed.  Bearer-token auth was already resistant (browsers can't set
  `Authorization` on a WS handshake).
- **HTTP-1 (MEDIUM-HIGH) — Hono body-size cap enforced before buffering**.  The Hono backend read the whole request body via
  `arrayBuffer()` and only then compared it against `maxBodyBytes`, so the cap
  was cosmetic — the real ceiling was the runtime's native default (128 MiB on
  Bun, effectively unbounded on Node via `@hono/node-server`).  It now rejects
  an oversized `Content-Length` with 413 *before* buffering; the post-buffer
  check remains a backstop for chunked bodies that omit Content-Length.
  Express (streaming cap) and Fastify (framework default) were unaffected.
- **HTTP-2 (MEDIUM-HIGH) — `InMemoryCache` is now bounded (LRU)**.  The default in-process cache was an unbounded `Map`
  with lazy expiry only, so a flood of distinct attacker-chosen keys
  (`Idempotency-Key`; rate-limit keys — idempotency additionally stores the
  full response body for 24 h) grew it without limit → RAM exhaustion.  It now
  accepts `{ maxEntries?, cleanupMs? }` (defaults `10_000` / `60_000`): a new
  key beyond the cap evicts the least-recently-used entry, and a background
  sweep reclaims expired entries.  *Behaviour change:* the default
  is now bounded — pass `maxEntries: Infinity` for the previous unbounded
  behaviour (documented OOM risk).  Options / validation / HOCON plumbing for
  these fields landed as the `InMemoryCacheOptions` follow-up (see *Changed —
  Options validation*).
- **WS-6 (LOW) — CRLF stripped from raw upgrade-reject headers**.  `writeRawHttpResponse` (the Express pre-handshake
  reject path) wrote app-supplied header names/values verbatim onto the raw
  socket, so an `authorize` guard echoing attacker-influenced data into a
  header could split the response.  CR/LF are now stripped from header names
  and values.
- **#9 (hardening) — JSON deserialization ignores the `__proto__` setter**
 .  `JsonSerializer` and the cluster ref decoder
  now define a decoded `"__proto__"` key as an own data property instead of
  assigning through the prototype setter, so a hostile payload can't change
  the decoded object's prototype.
- **BRK-1 / BRK-2 (MEDIUM) — inbound buffer caps for TCP `lines` + SSE**.  A hostile / MITM'd upstream could stream bytes with no
  frame delimiter, growing the inbound buffer without bound.  The TCP `lines`
  framer now rejects an un-terminated remainder that already exceeds
  `maxLineLen` (matching the existing terminated-line check), and the SSE
  client caps its pending event buffer at 1 MiB — both drop the connection
  instead of buffering forever.  (`length-prefixed` TCP framing was already
  bounded.)
- **#6 (LOW) — consistent SQL/CQL identifier validation**.  Postgres/MariaDB already validated table identifiers,
  but SQLite (journal + snapshot store) and Cassandra (keyspace + table names,
  interpolated into CQL) did not.  A shared `assertSafeIdentifier`
  (`/^[A-Za-z_][A-Za-z0-9_]*$/`) is now applied across all four, so a
  config-sourced identifier can't inject SQL/CQL.  Data values were, and
  remain, bound parameters.
- **HTTP-3 (docs) — rate-limit examples key on the socket peer, not
  `x-forwarded-for`**.  The shipped `rateLimit`
  examples taught keying on the client-settable `x-forwarded-for` header, which
  an attacker rotates per request to bypass the limit (and which collapses all
  header-less clients into one shared bucket).  The JSDoc and the bilingual
  docs now use `req.remoteAddress` and state the trusted-proxy caveat.  No
  behaviour change — `key` was always caller-supplied.
- **#3 (MEDIUM) — decompression-bomb cap on stored bodies**.  Reading a snapshot / durable-state / object body
  decompressed it with no output bound, so a tampered or hostile compressed
  blob (a few KB expanding to many GB) could OOM the process on recovery.
  `decodeBody` now caps the decompressed size at **512 MiB** by default
  (`DecodeOptions.maxOutputBytes`; `Infinity` opts out): gzip enforces it at
  allocation time via zlib's `maxOutputLength`, and every path asserts the
  decoded size as a portable backstop.
- **HTTP-4 (MEDIUM) — idempotency responses can be scoped per caller**.  The idempotency cache keyed only on the
  `Idempotency-Key` header plus a method/path/body fingerprint, so two callers
  reusing the same key for the same request shape shared one cached response —
  a cross-user disclosure when the response is identity-specific (e.g. carries
  `Set-Cookie` or the first caller's data).  New opt-in `identity: (req) =>
  string` folds the authenticated principal into the cache key so responses are
  partitioned per caller.  (Same-key-different-body poisoning was already
  rejected with 422.)
- **WS-4 (MEDIUM) — WebSocket backpressure works on the Hono backend**.  The Hono socket adapter didn't implement
  `bufferedAmount`, so the connection actor's `maxBufferedBytes` /
  `onBackpressure` guard was a no-op on Hono — a slow / idle-reading client
  could grow the outbound send buffer without bound (OOM).  The adapter now
  surfaces the send-buffer depth from the native socket (Bun
  `getBufferedAmount()`, Node/Deno numeric `.bufferedAmount`).
- **WS-3 (MEDIUM) — cap the WebSocket transport frame size (Express + Fastify)**
 .  The `ws`-backed backends left the transport at the
  `ws` default `maxPayload` (100 MiB), so an oversized frame was buffered in
  full before the app-level `maxFrameBytes` (1 MiB default) rejected it —
  allocation-amplification DoS.  Both now pass `maxPayload:
  DEFAULT_WEBSOCKET_MAX_FRAME_BYTES` (1 MiB), so an oversized frame is rejected at the
  protocol level.  *Caveat:* on these backends a route that raises
  `maxFrameBytes` above the default is currently still capped at the default by
  the transport; a per-route / configurable transport cap and the Hono
  runner-level cap are tracked follow-ups.
- **WS-5 (MEDIUM, partial) — per-route WebSocket connection admission cap**
 .  New opt-in `maxConnections` on `websocket()`
  routes (`.withMaxConnections(n)`, or `actor-ts.http.websocket.maxConnections`
  in HOCON): a new upgrade beyond the cap is closed with 1013 in the shared
  wiring layer before an actor is wired for it, and the live count decrements
  when a connection closes.  Default: unlimited (behaviour unchanged).  The
  other WS-5 sub-parts — a handshake/idle timeout and hub-mailbox bounding —
  remain tracked follow-ups.

### Documentation

- Moved the Server-WebSocket page from the IO section into the HTTP section
  (#351).
- Reconciled stale API-reference pages with the shipped code (#360): rewrote the
  persistence adapter & migration pages and the OTel **tracing** adapter page to
  the function-based APIs, rewrote the management & health-check and cache &
  durable-data pages to their real APIs, and removed the page for the
  never-shipped OTel *metrics* adapter.
- Repointed stale `*Settings` type names in prose to the `*OptionsType`
  vocabulary (#349).
- Fixed broken code samples that declared a `const` inside a call's object
  literal (#359).

## [0.10.0] — 2026-07-08

### Added — Typed WebSocket & MQTT

- **Typed WebSocket routing** (#1) — a `websocket(path, actorRef)` directive
  in the HTTP routing DSL binds a `WebSocketServerActor<TOut, TIn>`.  The
  hub receives codec-decoded messages (JSON by default; `rawCodec()` for
  binary), replies to the sending connection with `this.reply(...)` or
  fans out with `this.broadcast(...)`, and gets `onClientConnected` /
  `onClientDisconnected` / `onInvalidMessage` hooks.  The framework spawns
  an internal session actor per connection and solves the first-frame
  race by construction (listeners attach synchronously at upgrade; the
  mailbox is the buffer).  Works on all three HTTP backends — Fastify
  (`@fastify/websocket`), Express (`ws` upgrade handling), and Hono
  (per-runtime: Bun/Node/Deno).  `withMiddleware(...)` runs at upgrade
  time, so `BearerTokenAuth` / `IpAllowlist` gate the handshake.
- **`WebSocketClientActor<TOut, TIn>`** (#1) — the typed client half, built
  on `BrokerActor`: reconnect-with-backoff, outbound buffering across
  reconnects, circuit breaker, and HOCON settings.  Other actors push a
  typed send with `ref.tell(wsSend(msg))`.
- **`actor-ts.http.websocket` HOCON block** — server-side WebSocket
  defaults (`maxFrameBytes`, `onOversizeFrame`, `onInvalidMessage`,
  `maxBufferedBytes`, `onBackpressure`); route options override HOCON,
  which overrides built-in defaults.
- **Subclass-first, typed `MqttActor<T, TSelf>`** (#345) — the MQTT
  counterpart to `WebSocketClientActor`.  Extend it, declare
  subscriptions in the constructor with `this.subscribe(topic, { qos })`,
  handle inbound traffic in `onMessage(msg)`, and publish with
  `this.publish(topic, payload)`.  Lifecycle events (inbound / connected /
  disconnected) run on the actor thread via the mailbox.  Hooks:
  `onMessage`, `onConnected`, `onDisconnected`, `onDecodeError`,
  `onSelfMessage`.  Still externally controllable via
  `ref.tell({ kind: 'publish' | 'subscribe' | 'unsubscribe', … })`.
- **`MqttOptions` fluent builder** (#345) — `MqttOptions.create()
  .withBrokerUrl(…).withClientId(…).withQos(…)…`; feeds the same
  three-layer settings merge (constructor > HOCON
  `actor-ts.io.broker.mqtt` > built-in defaults).  (As of #346/#348 this is
  the primary way to construct; a plain `MqttOptionsType` object works too —
  see the options note under *Changed*.)
- **Typed MQTT payloads** (#345) — inbound `MqttMessage<T>` carries a
  lazily-decoding `MqttPayload<T>` (`.bytes` / `.text()` / `.entity<U=T>()`,
  successes cached).  A pluggable `MqttCodec<T>` seam (default
  `mqttJsonCodec()`) decodes `entity()` and encodes non-string publishes;
  `publish(topic, { … })` encodes an entity, `publish(topic, string |
  Uint8Array)` sends raw bytes.  Decode failures surface via
  `onDecodeError`.  `MqttClientLike` / `MqttModuleLike` are exported as
  test seams for the `mqttModule()` override.

### Changed — Options overhaul & MQTT

- **Fluent options, framework-wide** (#346, #348) — every configurable
  constructor and factory takes a fluent options builder **or** a plain
  settings object, interchangeably: `new MqttActor(MqttOptions.create()
  .withClientId('x'))` behaves identically to `new MqttActor({ clientId:
  'x' })`.  A builder *is* its settings — `OptionsBuilder` stores each field
  as an own property, so a builder instance reads and spreads exactly like a
  plain settings object (no separate resolve step; consumers just read the
  argument).  Each configurable type exposes **three names from one
  `XOptions.ts` file**: `XOptionsType` (the plain object), `XOptionsBuilder`
  (the fluent builder, `XOptions.create().withField(…)`), and `XOptions` — the
  **union** of the two that every consumer signature accepts (`options:
  XOptions`), plus a value alias so `XOptions.create()` keeps working.  There
  is no separate "Settings" concept (the former `XSettings` interface is now
  `XOptionsType`, co-located in `XOptions.ts`).  HOCON resolution is
  unchanged — the builder / plain object only supplies the
  highest-precedence explicit layer, and unset fields still fall through
  to config then defaults.  Naming lockstep with no divergence: builder
  method `withX` ⇔ settings field `x` ⇔ HOCON leaf `x`.  Affected
  (non-exhaustive): `ActorSystem.create(name, ActorSystemOptions
  .create()…)`; `TestKit.create` / `new TestProbe` (`TestKitOptions` /
  `TestProbeOptions`); every broker actor (`MqttOptions`, `KafkaOptions`,
  `AmqpOptions`, `NatsOptions`, `JetStreamOptions`, `RedisStreamsOptions`,
  `SseOptions`, `TcpSocketOptions`, `UdpSocketOptions`, `GrpcClientOptions`,
  `GrpcServerOptions`); HTTP/WS (`WebSocketClientOptions`,
  `WebSocketRouteOptions`, `ExpressBackendOptions`, `HonoBackendOptions`);
  cache (`RedisCacheOptions`, `MemcachedCacheOptions`); persistence
  journals / snapshot stores / durable-state stores / object-storage
  backends / projections / plugin registrations; cluster / sharding /
  singleton / client / pub-sub / router / downing / failure detectors;
  leases, seed providers + discovery, observability adapters
  (`OtelAdapterOptions`, `PromClientAdapterOptions`), `WorkerClusterOptions`,
  `DistributedDataOptions`, and `ProducerControllerOptions`.  Migration:
  `new X({ a, b })` still works, or use `new X(XOptions.create()
  .withA(a).withB(b))`; the positional "context" args that were never
  settings (a system name, a `Cluster`, a sharding entity + type name)
  stay positional.  **BREAKING** (pre-1.0 hard cut): the builder class
  `XOptions` is renamed `XOptionsBuilder` and the settings interface
  `XSettings` is renamed `XOptionsType`; `XOptions` is now the accepted-input
  union.  Everyday call sites — `XOptions.create()…` and plain objects — are
  unaffected; only code that referenced the old `XSettings` type name or the
  builder *class* by name needs updating.
- **BREAKING: renamed settings fields + HOCON keys** (#348) — to keep the
  builder-method ⇔ settings-field ⇔ HOCON-leaf names in lockstep, six
  fields were renamed: MQTT `defaultQos` → `qos` (`withQos`) and
  `keepAliveSec` → `keepAlive` (`withKeepAlive`); JetStream `ackTimeoutMs`
  → `ackTimeout`; ClusterClient `log` → `logger`; DistributedData
  `gossipIntervalMs` → `gossipInterval`; ProducerController
  `resendTimeoutMs` → `resendTimeout`.  Update any plain settings objects
  and HOCON keys using the old names.
- **BREAKING: `MqttActor` is now abstract** (#345) — you subclass it and
  override `onMessage` instead of spawning it directly and driving it only
  with `tell`.  Migration: `class MyClient extends MqttActor<T> { … }` and
  spawn the subclass.  A pure external-router setup needs a trivial
  subclass with an empty `onMessage`.
- **BREAKING: `MqttMessage.payload` is a `MqttPayload<T>` wrapper**, no
  longer a raw `Uint8Array` (#345).  Migration: `msg.payload` →
  `msg.payload.bytes`; `new TextDecoder().decode(msg.payload)` →
  `msg.payload.text()`; JSON reads → `msg.payload.entity()`.
- **BREAKING: `MqttOptionsType.subscriptions` and the `MqttSubscription`
  type are removed** (#345) — they were never HOCON-expressible (targets
  are actor refs).  Migration: move `subscriptions: [{ topic, target }]`
  into the subclass constructor as `this.subscribe(topic, { target })`, or
  send `ref.tell({ kind: 'subscribe', topic, target })`.
- **BREAKING: `subscribe`/`unsubscribe` command `target` semantics**
  (#345) — a `subscribe` command with no `target` now delivers to the
  actor's own `onMessage` (previously `target` was required).  An
  `unsubscribe` command with no `target` now removes only the *foreign*
  targets and leaves the actor's own subscription intact (previously it
  dropped the whole topic).

### Fixed — MQTT

- **MQTT runtime subscriptions are re-applied after a reconnect** (#345) —
  previously only the (now-removed) `settings.subscriptions` were
  re-subscribed on reconnect, so subscriptions added at runtime silently
  stopped receiving after a drop.  The unified registry is now re-applied
  on every (re)connect.
- **MQTT `subscribe` while disconnected reaches the broker on connect**
  (#345) — previously it updated only the local routing map and never
  issued the broker SUBSCRIBE.
- **MQTT terminated fan-out targets are cleaned up** (#345) — subscriber
  refs are deathwatched; when one stops it is pruned from the registry and
  a broker UNSUBSCRIBE fires once the pattern has no consumers left.

### Removed — legacy frame-level WebSocket API

- **BREAKING: the legacy frame-level WebSocket API** — `WebSocketActor`
  (client), `ServerWebSocketActor` (server bridge), and the
  `serverWebSocketActorOf` / `bunWebSocketHandlers` adapters are gone.
  They worked at the raw text/binary frame level and needed ~150 lines of
  backend-specific boilerplate to stand up a server.  Replace a
  `WebSocketActor` with `WebSocketClientActor`, and a hand-rolled server
  plugin with a `websocket(path, ref)` route + `WebSocketServerActor`.
  The client HOCON key `actor-ts.io.broker.websocket` is unchanged.

### Security

- **WebSocket DoS hardening carried into the new stack** (#1) — inbound
  frames are size-capped (`maxFrameBytes`, default 1 MiB) *before* the
  codec decodes them; oversize frames close 1009 (or drop) and
  undecodable frames close 1003 (or drop / hook) per policy.  Slow-consumer
  backpressure closes/drops past `maxBufferedBytes`.

- **DurableState revision tampering** (#116) — `ObjectStorageDurableStateStore.load()`
  previously trusted the `revision` value inside the body JSON, so an
  attacker with write access to the underlying bucket could roll back
  state past CAS checks.  Two-track integrity fix: encrypted bodies use
  AES-GCM with `revision` as AAD (already wired); unencrypted bodies
  gain an opt-in HMAC-SHA256 over `{ revision, etag }` with per-pid
  HKDF-derived subkeys.  Set `integrity: { mode: 'hmac-sha256', integrityKey }`
  on the store + `requireIntegrity: true` to refuse legacy un-tagged
  bodies on the read path.
- **ClusterClient ask-ID predictability** (#120) — `nextAskId()` used
  `Date.now() + counter`, predictable enough that a MitM on the
  TCP socket could pre-compute likely IDs and inject forged
  `cluster-client-reply` frames.  Switched to `crypto.randomUUID()`
  (122 bits of entropy per call).
- **Master-key rotation sweep race** (#109) — `reEncryptObjectStorage()`
  had no durable progress token, so a crash forced the resumed run
  to re-list and re-GET every object from scratch (a 24-hour sweep =
  a 24-hour wasted re-walk).  Worse: if the operator dropped a
  retired key from the keyring too soon, the sweep would only
  notice mid-corpus, leaving the bucket half-rewritten.  Added two
  opt-in options: `progress: ReEncryptProgressStore` for durable
  resume tokens (file/Redis/object-storage-backed) and
  `verifyKeyringCompleteness: boolean` (default `true`) for a
  pre-sweep sample that refuses to start when a body's key version
  is absent from `active`/`retired`.
- **LeaseMajority split-brain** (#142) — a slow `lease.acquire()`
  that the local defence-in-depth timeout had given up on could
  later resolve `true` and write `decision=surviveSet`, letting
  both sides of an equal partition claim victory.  Three layered
  fixes: (1) monotonic `acquireEpoch` so a late result with a
  stale epoch is dropped; (2) fire-and-forget `lease.release()`
  on abandon to undo any wire-side success after the local
  give-up, with fail-safe-on-rejection (refuse to claim majority
  on the same view); (3) optional fencing tokens — `Lease.acquireWithToken?():
  Promise<{ token: string } | null>` with `KubernetesLease`
  returning `<resourceVersion>/<leaseTransitions>` and
  `InMemoryLease` a monotonic per-name version stamp.

### Added — Persistence, HTTP & observability

- **PostgreSQL persistence backend** (#323) — `PostgresJournal`,
  `PostgresSnapshotStore`, and `PostgresDurableStateStore` (the first
  SQL-backed durable-state store) on top of the `pg` driver, registered
  via `registerPostgresPlugins(ext, …)` which selects the journal +
  snapshot store by config plugin ID and returns the durable-state-store
  handle (the object-storage-plugin pattern — `PersistenceExtension` has
  no durable-state registry).  Optimistic concurrency (per-pid
  `SELECT MAX(seq)` inside a transaction plus a primary-key
  unique-violation `23505` backstop; revision CAS via
  `ON CONFLICT`/`UPDATE … WHERE revision`), an indexed tags join table,
  and auto-created schema (`autoCreateTables`, default on).  `pg` is an
  optional peer-dependency, lazy-imported; the backend defines its own
  minimal client shapes so the framework stays dependency-free.  Ships
  with an in-process fake-pool unit suite and a live `postgres:latest`
  Docker suite wired into the integration-brokers CI matrix.
- **MariaDB persistence backend** (#324) — sibling of #323 for
  MariaDB / MySQL via the official `mariadb` connector: `MariaDbJournal`,
  `MariaDbSnapshotStore`, `MariaDbDurableStateStore`, and
  `registerMariaDbPlugins`.  A separate implementation with the MariaDB
  dialect (`?` placeholders, `INSERT IGNORE` for the tag dedup,
  `ON DUPLICATE KEY UPDATE` snapshot upsert, a derived-table-wrapped
  `keepN` prune, `ER_DUP_ENTRY`/1062 concurrency backstop, and
  `LONGTEXT`/`VARCHAR(255)`/`BIGINT` columns).  Optional `mariadb`
  peer-dep; in-process fake-pool suite + live `mariadb:latest` Docker
  suite in CI.
- **Configurable compression level** (#322) — `CompressionConfig` gains
  an optional `level` (gzip 0–9, zstd 1–22) threaded through the codec to
  the object-storage snapshot + durable-state stores.  Out-of-range values
  are clamped; the level is encoder-only and is NOT written to the wire
  (the ATS1 manifest records only the algorithm), so changing it needs no
  migration — old bodies keep decoding, new bodies use the new level, and
  the two mix freely in one bucket.
- **Real-network multi-node integration tests** (#313) — new
  `tests/integration/` subtree with a Docker-compose setup that
  brings up 5 cluster-node containers + 1 controller container
  on a shared bridge network and runs partition / heal /
  membership-convergence scenarios over a real TCP stack.  All
  fault injection happens inside each container's network
  namespace via `iptables` + `tc netem`, so no host privileged
  mode is required — just `NET_ADMIN` on each cluster-node
  container.  Two npm scripts ship: `bun run test:integration`
  (build + up + auto-exit on the controller's status) and
  `bun run test:integration:teardown`.  The same command works
  locally on Docker Desktop and in
  `.github/workflows/integration.yml`; the workflow is
  triggered by pushes to `main`, manual dispatch, and a nightly
  schedule.  Fifteen scenarios covering the cluster's load-bearing
  primitives:
  - **01** — membership convergence (smoke test)
  - **02** — 2:3 split-brain with partition + heal verification
  - **03** — Receptionist gossip-convergence over a shared
    `ServiceKey` across all 5 nodes, with partition + heal
  - **04** — DistributedData `LWWRegister` quorum reads/writes
    during a 50ms `tc-netem` egress latency storm — proves
    `majority`-consistency operations survive a real network
    slowdown
  - **05** — Cluster Singleton failover after the host node
    `cluster.leave()`s; new leader's manager spawns the
    singleton, proxies from every remaining node converge
  - **06** — Cluster Sharding rebalance: 30 entities warmed up,
    victim node leaves, 8 ex-victim entities relocate to
    surviving regions via the coordinator's HandOff path
  - **07** — Concurrent `GCounter` increments from all 5 nodes
    converge to the exact expected total (proves CRDT merge +
    `ddata-gossip` wire path under write pressure)
  - **08** — Receptionist `Subscribe` continuous-listing
    notifications fire on register / deregister, observable
    from every cluster node within gossip-propagation latency
  - **09** — External `ClusterClient` (NOT a cluster member)
    makes 100 sequential asks against `/user/echo`; exercises
    the #120 `randomUUID` ask-id path end-to-end
  - **10** — Management HTTP auth end-to-end: 401 without
    token, 200 with valid token, 404 with valid token + fake
    address, /health stays anonymous (probe contract)
  - **11** — `PersistentActor` event-sourcing + snapshot +
    replay: 5 increments → snapshot at seq=3 → kill → respawn
    triggers `recover()` → snapshot-load + replay restores
    state.  Two-kill cycle verifies determinism.
  - **12** — `DistributedPubSub` topic fan-out: 15 events
    published from two different nodes, all 5 subscribers
    receive both bursts in order
  - **13** — `CoordinatedShutdown` pipeline progresses through
    early (`BeforeServiceUnbind`) + late
    (`BeforeActorSystemTerminate`) phases on a victim node;
    markers POST'd to a peer observer verify both fired in
    chronological order
  - **14** — Bounded mailbox + `actor_mailbox_dropped_total`
    metric: bombard a slow actor with 15 000 messages, verify
    ~5 000 drops are counted in the Prometheus output with
    correct `{class, path, reason}` labels
  - **15** — `DnsSeedProvider` against docker's embedded DNS:
    resolves every peer hostname, validates IPv4 shape and
    `<systemName>@<host>:<port>` stamping
- **Backend `remoteAddress` wiring** (#312 follow-up) — the
  Fastify, Express, and Hono backends now populate
  `HttpRequest.remoteAddress` from the socket peer
  (`req.ip` / `req.socket.remoteAddress` on Fastify+Express;
  best-effort across `c.req.raw` / `c.env.requestIP` on Hono).
  `IpAllowlist` works end-to-end on real socket peers — the
  pre-existing `getClientIp` override is no longer required for
  default deployments behind direct connections.
- **HTTP route middleware framework** (#312) — new
  `withMiddleware(mw, route)` builder + `Middleware` type
  `(req, next) => Promise<HttpResponse> | HttpResponse`.  Middlewares
  compose outside-in; nested wraps run in declaration order.  The
  HTTP cache primitives (`rateLimit`, `idempotent`, `cached`) are
  unchanged, but new orthogonal concerns (auth, allowlists, custom
  logging, request tracing) can hang off the same hook.
- **`BearerTokenAuth({ tokens })`** (#312) — built-in middleware
  that 401s every request lacking a `Authorization: Bearer <token>`
  header from the configured (rotatable) shared-secret list.
  Constant-time comparison so an attacker probing tokens can't
  distinguish "first character wrong" from "last character wrong"
  by timing.  Rejection includes `WWW-Authenticate: Bearer realm=...`.
- **`IpAllowlist({ allow })`** (#312) — built-in middleware for
  CIDR-based network-level isolation.  Parses IPv4 + IPv6 CIDRs
  (including IPv4-mapped IPv6 like `::ffff:10.0.0.1` so a dual-
  stack socket peer matches an IPv4 CIDR).  Fail-secure: no
  resolvable client IP means 403.  Trust-source is explicit:
  default reads `req.remoteAddress` (the socket peer); operators
  behind a trusted proxy must opt-in to header trust via the
  `getClientIp` extractor.
- **`HttpRequest.remoteAddress?: string`** (#312) — optional new
  field on the request shape.  Backends should populate from the
  underlying socket where available.  Consumers that need to
  trust `x-forwarded-for` must do so explicitly (see
  `IpAllowlist`'s `getClientIp`).
- **`managementRoutes`** gains `auth`, `ipAllowlist`, and
  `authProtectHealth` settings (#312).  By default the auth
  middleware wraps the privileged subtree (`/cluster/*`,
  `/metrics`) but leaves `/health` and `/ready` anonymous —
  standard Kubernetes liveness/readiness probes can't easily
  attach an Authorization header.  Set `authProtectHealth: true`
  when the deployment can present credentials on probes.  The
  IP-allowlist wraps EVERYTHING (network-level isolation
  precedes any application policy).
- **`JsonLogger`** (#311) — structured-logging logger that emits one
  `\n`-delimited JSON object per record to `process.stdout` (or an
  injected `JsonLogSink`).  Every record carries `ts` (ISO-8601),
  `level`, optional `source`, `msg`, the merged static + dynamic
  MDC, and positional `...args` under an `args` array.  Errors
  serialise as `{ name, message, stack }`; circular refs,
  `BigInt`, and functions are sanitised so a log call never throws.
  Drop-in for log-aggregation pipelines (Loki, ELK, Datadog,
  CloudWatch, etc.) via the standard stdout-pipe path.
- **`otelLogger({ api })`** (#311) — bridge to
  `@opentelemetry/api-logs` for OTLP-Logs pipelines.  Optional peer
  dep (structural-typed on the OTel surface, like `otelTracer`).
  Maps severity to OTel's standard severity-number range, attaches
  the actor's path on `source`, merges static + dynamic MDC into
  `attributes`, and the SDK auto-links the active span's
  `traceId`/`spanId` when tracing is enabled in the same process.

### Changed — Bounded mailbox default

- **Bounded mailbox is now the default** (#310) — every actor spawned
  without an explicit `Props.withMailbox(...)` gets a
  `BoundedMailbox` with `capacity = 10_000` and `overflow = 'drop-head'`.
  The pre-#310 unbounded shape was a classic Akka-anti-pattern in
  disguise: a runaway producer could absorb the JVM, ahem, the V8
  heap, until OOM.  10 000 is high enough that a well-tuned actor
  never hits it on a normal traffic spike; if it does, the actor's
  throughput is mismatched and the bound makes that operationally
  visible.  Drops are emitted as the `actor_mailbox_dropped_total`
  Counter (labels `class`, `path`, `reason`).  Opt back into unbounded
  per-actor via `Props.withMailbox(() => new Mailbox())`; keep the
  bounded shape but change the capacity via `Props.withMailboxCapacity(n)`.

### Fixed — Compression

- **zstd compression on runtimes without native zstd** (#321) — the
  compression codec wired the `fzstd` peer-dependency as a compressor, but
  `fzstd` is decompression-only (it has no `compress`), so
  `compression: { algorithm: 'zstd' }` threw `fzstd.compress is not a
  function` on any runtime without native zstd (i.e. not Bun and not
  Node ≥22.15) — and the eager peer-dep probe passed anyway.  zstd
  resolution is now split by direction: compress is native-only with a
  clear "needs Bun / Node ≥22.15" error, decompress keeps the `fzstd`
  fallback so a non-native runtime can still READ zstd bodies written
  elsewhere, and `probeCompressionAvailability('zstd')` now checks the
  compress path so the misconfig surfaces at plugin-init, not on first
  persist.
- **Object-storage compression docs were inaccurate** — the docs
  described `gzip` / `brotli` / `deflate` with a `level` field and
  `Content-Encoding`-header-driven decode, none of which matched the
  implementation.  Corrected across EN + DE to the real `none` / `gzip` /
  `zstd` set, the ATS1-manifest-driven decode, the now-real `level`
  option, and the per-direction zstd runtime support.

## [0.9.1] — 2026-05-15

Docs-only patch release covering the first round of post-v0.9.0
publish feedback.

### Fixed

- README logo no longer 404s on the npmjs.com package page —
  switched from relative `./docs/public/logo.png` to an absolute
  `raw.githubusercontent.com/pathosDev/actor-ts/main/...` URL.
  Relative paths inside raw `<img>` tags aren't rewritten by
  npm's README renderer, only Markdown image syntax is.
- README license badge link similarly switched to an absolute
  `github.com/.../LICENSE` URL.
- README "## License" section text — said "MIT" left over from
  the original metadata-only declaration; corrected to
  "Apache 2.0" matching the v0.9.0 relicense.
- Sub-package READMEs (`benchmarks/`, `examples/chat/`,
  `examples/voice/`) referenced a non-existent `assets/logo.svg`
  path (the `assets/` folder never existed in this layout).
  Switched to the same absolute
  `raw.githubusercontent.com/pathosDev/actor-ts/main/docs/public/logo.svg`
  URL the root README now uses — consistent across every README
  and robust under any rendering target (GitHub, npm, mirrored
  forks).

## [0.9.0] — 2026-05-14

The "public-launch readiness" release.  Six workstreams accumulated
since v0.8.0 (142 commits total): the docs site goes live at
`actor-ts.dev` with 199+ pages and full German translation; a wave
of API shortcuts collapses the clustered-actor setup from 15–30
lines to a single `Cluster.bootstrap({ name })`; eight latent
security weaknesses get patched; a code-quality sprint closes 17
audit-catalog issues; the chat sample grows DMs / typing /
read-receipts / production-grade auth.

### Added — Quality-of-life API shortcuts

- `Cluster.bootstrap({ name })` — one-call setup that builds the
  `ActorSystem`, joins the cluster, starts the Receptionist, and
  wires `SIGTERM` / `SIGINT` shutdown.  Discovery defaults to an
  env-driven chain (`CLUSTER_SEEDS` → Kubernetes API → DNS) via
  the new `autoDiscovery()` builder so the same code runs
  single-node in dev and joins an existing cluster in production
  without a config change.
- `cluster.sharding` getter on `Cluster` — replaces the
  `ClusterSharding.get(system, cluster)` ceremony.  The static
  form still works for callers that need to reference the class
  from outside a `Cluster` handle.
- `ClusterSharding.start('cart', CartActor, { extractEntityId })`
  — class-shorthand overload that wraps the entity in
  `Props.create(() => new CartActor())` internally.  Factory form
  also accepted (`() => new CartActor(deps)`); full-form
  `start({ typeName, entityProps, ... })` stays valid.
- `ref.ask<TRes>(msg, timeoutMs?)` — method form of the ask
  pattern.  Auto-injects `replyTo: ref` on the message so
  recipients can read either `this.sender` or `msg.replyTo`
  without callers supplying it.  `OmitReplyTo<TMsg>` distributes
  across unions so the call site never has to satisfy the
  `replyTo` field.
- `system.spawnTyped(behavior, name)` +
  `system.spawnTypedAnonymous(behavior)` — method form symmetric
  to `spawn` / `spawnAnonymous`.  Same pair on `ActorContext` for
  typed-child creation from untyped parents.
- `system.http(port, { host?, backend? })` — Fastify-default HTTP
  shortcut.  Returns the same `ServerBuilder` as the explicit
  `system.extension(HttpExtensionId).newServerAt(...)` chain.
- `ActorSystem.create('app', { persistence: { journal,
  snapshotStore } })` — wire real persistence backends at creation
  time.  Either slot is independent; the in-memory default stays
  in place for the omitted slot.

### Removed — replaced by method forms

- Free function `ask(ref, msg, timeoutMs?)` — use
  `ref.ask<TRes>(msg, timeoutMs?)`.  Pre-1.0, no compat shim.
- Free functions `spawnTyped(system, behavior, name?)` and
  `spawnTypedChild(ctx, behavior, name?)` — use
  `system.spawnTyped(...)` / `ctx.spawnTyped(...)` (with
  anonymous variants).  Internal `Ask.ts` and
  `internal/PromiseActorRef.ts` modules deleted; ask impl
  inlined into `ActorRef.ts`.

### Security

Eight latent weaknesses patched.  All defenses are at the
deserialisation / boundary layer with regression tests pinning
both the attack vector and the legitimate path.

- **Wire-frame size cap** — `cluster/protocol` rejects frames
  claiming gigabyte+ lengths before allocation; defeats a
  4-GiB-claim memory-exhaustion DoS.  Configurable; `Infinity`
  cap remains the escape hatch.
- **Path-traversal block in `FilesystemObjectStorageBackend`** —
  keys containing `..` or absolute-path patterns rejected at the
  boundary instead of being resolved through to disk.
- **Memcached protocol injection** — `MemcachedCache` keys
  validated against the 250-byte / printable-ASCII rule before
  being placed on the wire; defeats injection via attacker-
  controlled keys.
- **Gossip-version cap against permanent-down exploit** —
  versions more than 24 h above the local wall-clock are
  rejected on the spot; previously a malicious peer could send
  `version: MAX_SAFE_INTEGER` to pin a healed node as `down`
  forever.
- **Snapshot-seq validation on recovery** — `PersistentActor`
  rejects snapshots whose `seqNr` is non-monotonic with the
  journal; defeats tampered-snapshot replay.
- **WebSocket inbound frame size cap** — `WebSocketActor`
  rejects oversized inbound frames before assembly; defeats
  memory-exhaustion DoS via fragmented frames.
- **Duplicate-identity hello rejection** — `cluster/transport`
  refuses a second hello frame claiming an already-connected
  identity; defeats peer-hijack where an attacker rebinds to a
  victim's `from` address.  Legitimate reconnect (after clean
  close) unaffected.
- **Idempotency-key cache binding** — `http/cache/idempotency`
  ties each cached response to the request fingerprint (method
  + path + body hash) so a poisoned key can't replay one
  response across different requests.

### Documentation

- **Public website at [actor-ts.dev](https://actor-ts.dev)** —
  Astro Starlight site under `docs/`, 199+ pages across the
  12-Part IA, full Quickstart + fundamentals + per-subsystem
  deep-dives + migration guides + API reference (TypeDoc).
- **Full German translation** — every page mirrored under
  `/de/`.  Seven additional UI locales (fr, es, ja, ko, pt-BR,
  ru, zh-CN) staged with sidebar labels translated; full content
  translations tracked as #300–#306.
- **Mermaid diagrams throughout** — replaces ASCII art across
  all subsystem pages (cluster, sharding, distributed-data,
  persistence, observability, operations, testing, IO, delivery).
- **Landing-page polish** — animated particle-network hero,
  prose-driven "What is actor-ts" cards, See-it-in-action status
  grid, custom-domain redirect, mobile-responsive splash.
- **Issue templates** — `.github/ISSUE_TEMPLATE/` gains
  `security_report.yml`; bug template gets a security-flag
  checkbox.
- `decodeCrdt` (`src/crdt/DistributedData.ts`) annotated as the
  codebase's reference shape for discriminator-union dispatch,
  with explicit notes on what makes the existing
  `const _exhaustive: never = json` pattern safe and when to
  prefer it vs `match().exhaustive()` (#231).

### Code-quality hygiene sprint

A focused refactor pass — no behavioural changes, no public-API
breaks, no new features.  Goal: more compile-time safety, fewer
duplicated literals, easier-to-write tests.  17 issues closed
(15 implemented + 2 auto-corrections from the audit catalog).

**Pattern-match exhaustiveness pass** — 9 discriminator-union
dispatch sites converted from if/else-or-switch to
`match(...).exhaustive()` so the TypeScript compiler refuses to
compile when a new variant is added to one of the unions without
a matching arm at the dispatch site.  Touches:
`BrokerActor.enqueueOutbound` state (#230),
`JetStreamActor` / `MqttActor` / `KafkaActor` cmd dispatch (#232,
#233, #234), `BackoffSupervisor` reset-policy + termination-trigger
(#240), `HoconParser` value-shape walk (#241), `Compression` codec
selection (#243), `BodyCodec` encode-compression (#244),
`PersistentActor` (#239 — see below).

**Foundational DRY helpers** (`src/util/`):
- `Constants.ts` — centralised duplicated defaults (gossip
  interval, ask timeout, tombstone TTL, seed-retry, etc.).  6
  named exports replace ~10 inline-literal sites across
  `Cluster`, `Receptionist`, `DistributedPubSubMediator`,
  `ClusterClient`, `ClusterClientReceptionist`, `DistributedData`
  (#257).
- `LazyImport.ts` — uniform peer-dep import + helpful "missing
  package" error.  Replaces ~7 lines × 6 broker actors of
  hand-rolled try/catch + bespoke install messages (#252).
- `WrapError.ts` — typed-error wrap helper with double-wrap
  prevention.  Migrated 8 sites across cache + object-storage
  (#254).

**Foundational typed names**:
- `src/config/ConfigKeys.ts` — typed const-tree for every
  `actor-ts.*` HOCON path.  Migrated 16 call sites across all
  brokers + ActorSystem + CacheExtension (#265).
- `src/persistence/storage/KeyValidator.ts` — declarative
  rule-based factory replacing the hand-rolled `assertSafeKey`
  (filesystem) and `assertSafeMemcachedKey`.  Adding a new
  storage backend with similar key rules becomes a 6-line
  `as const` rule set (#251).

### Chat sample feature sweep

Five "Chat sample: …" follow-up issues resolved across five
commits.  Four shipped as features, one closed-not-implement, one
sub-feature spun off as its own focused issue.

- **User-created rooms at runtime** (#98) — new
  `ChatRoomDirectoryActor` wraps a cluster-wide `DistributedData`
  ORSet of room names.  `DEFAULT_ROOMS` becomes the idempotent seed
  list; the actor fans out `RoomsChanged` / `RoomAdded` /
  `RoomRemoved` events to per-session subscribers.  Protocol gains
  `create-room` (client → server) plus `room-added` / `room-removed`
  (server → client).  Six frontends grow a "+ new room" input.
- **Private direct messages** (#100) — DMs ride on existing
  protocol frames as virtual `@<username>` "rooms".  Server
  distinguishes by the leading `@` and routes through a sharded
  `DmChannelActor` keyed on the canonical pair-id
  (`canonicalPairId('alice', 'bob') === 'alice|bob'` regardless of
  ordering).  Each user subscribes once at login to their inbox
  topic `chat.dm.user.<self>` — single subscription covers every
  DM conversation.  Six frontends: click any user in the Online
  panel to open a DM.
- **Typing indicators** (#103 slice 1) — `{ type: 'typing', room }`
  fan-outs via the room's existing PubSub topic as an ephemeral
  `TypingBroadcast`; server filters self-echoes; clients debounce
  outbound at 1/2 s and auto-clear stale indicators after 3 s.
- **Read receipts** (#103 slice 2) — per-room
  `read-up-to.<room>` `DistributedData` LWWMap mapping username →
  highest acked message timestamp.  New `ReadReceiptsActor` enforces
  a monotonic guard at the boundary (LWW's wall-clock tiebreak
  doesn't know read pointers can't go backwards).  Frontends render
  ✓ / ✓✓ on own messages.
- **Emoji passthrough** (#103 slice 1, doc-only) — server is
  text-agnostic; any frontend can wire an `emoji-mart` /
  `<emoji-picker-element>` / native picker on top without server
  changes.  Documented in the chat README; no code shipped.
- **Production-realistic auth** (#99, Option A) — passwords stored
  as `<salt>:<hash>` scrypt records (`crypto.scryptSync`,
  N=16384/r=8/p=1, constant-time verify via
  `crypto.timingSafeEqual`).  Session tokens become HMAC-SHA256-
  signed JWT-style strings; `lookupToken` self-validates without a
  DD read.  DD-LWWMap shrinks to a revocation-only set
  (`chat.session-revocations`).  Server secret comes from
  `CHAT_TOKEN_SECRET` env (warned-and-fallback otherwise).
- **#104 (mobile frontends)** — closed-not-implement.  Six web
  frontends already cover the "protocol works anywhere" story;
  adding React Native + Flutter is two more app-frameworks to
  maintain for marginal sample-value gain.  Rationale in the issue
  closing comment.
- **#292 (file uploads)** — spun off as its own focused issue
  because object-storage wiring is qualitatively different from
  the other UI-polish items.  Not blocking the rest of the sweep.

Chat-sample smoke-test grows from passes 1–2 to **passes 1–7**,
covering: login + send + history (1–2), user-created rooms (3),
direct messages (4), typing indicators (5), read receipts including
a monotonic-guard probe (6), and auth hardening — wrong password,
valid resume, revoked-token resume rejection, tampered-token resume
rejection (7).

### Added — Persistence

- `eventDispatcher<S, E>()` (#239) — typed builder for
  `PersistentActor.onEvent` that the compiler refuses to finish
  until every variant of the event union has a handler.  Missing
  variants surface as a clear "EventDispatcherIncomplete<missing>"
  type error at the build site.  Documented as the preferred shape
  for new persistent actors; existing handwritten `onEvent`
  impls continue to work unchanged.

### Added — Testing infrastructure

- `tests/util/AsyncAssertions.ts` — `assertCompletesWithin(promise,
  ms, label)` + `assertDoesNotCompleteWithin` for diagnostic-quality
  timeout failures (the label appears in the error message;
  default Bun timeouts give no clue which step was slow) (#288).
- `tests/util/TestActorSystem.ts` — `createTestActorSystem(options?)`
  consolidates the per-file `makeSystem` boilerplate.  Demo
  migration in `BrokerActor.test.ts`; other test files can opt-in
  over time (#283, scope-adjusted).
- `tests/unit/cache/_Contract.ts` — `runCacheContractTests(spec)`,
  a backend-agnostic suite covering set/get/delete/incr/setIfAbsent/
  TTL semantics.  InMemoryCache wired as first consumer; Redis +
  Memcached can opt-in once their mock-client factories are
  available (#287, scope-adjusted).

### Issue hygiene

- Closed as duplicate: #267 → #253, #266 → #255, #167 → #164.
- Closed as not-applicable: #245 — `BrokerEvents.ts` has no
  in-file dispatch; events flow through `EventStream`'s
  per-subscriber `instanceof` machinery, which by design isn't a
  closed-union dispatch.

## [0.8.0] — 2026-05-11

The "production-vertical big" release — one priority:high cornerstone
plus four mid-sized operator-facing items.  Wire-format additive: new
optional message types and HTTP routes; no existing callers break.

### Added — DistributedData quorum writes / reads (#81)

- `DistributedDataHandle.updateAsync(key, factory, fn, { consistency })`
  and `.getAsync(key, { consistency })` — promise-returning variants
  with a `WriteConsistency` / `ReadConsistency` target.
- Consistency levels: `'local'` (legacy fire-and-forget), `'majority'`
  (⌊N/2⌋+1), `'all'` (every up-member), `{ from: K }` (clamped to
  `[1, N]`).  Self always counts as the first ack; single-node
  clusters resolve instantly.
- Reads merge incoming responses into the local replica before
  resolving, so a `ReadMajority` effectively pulls the freshest
  state without waiting for gossip.
- Timeouts reject writes (the local apply still stands, gossip
  continues) and resolve reads with the best-available merge —
  reads stay best-effort even on partial failure.
- New wire messages `ddata-write-request|ack` /
  `ddata-read-request|response`.  Registered via the extension's
  synchronous `start()` so the inbound side routes before the user
  can issue the first quorum write.

### Added — operations tooling

- `reEncryptObjectStorage(backend, opts)` (#70) — re-encrypt every
  body under a prefix to the active master key from a `MasterKeyRing`.
  Idempotent fast-path on bodies already at the active version;
  `If-Match` CAS internally so a concurrent writer isn't overwritten
  silently.  Closes the missing step in v0.7's
  `docs/operations/rolling-migration.md` Phase-3 — the doc now shows
  the real call instead of a TBD marker.
- `migrateBetweenJournals(source, target, opts?)` /
  `migrateBetweenSnapshotStores(source, target, { pids })` (#87) —
  copy-with-optional-transform helpers for backend swaps and
  schema-piggyback migrations.  Per-pid resume from `target.highest
  Seq + 1`; optional `MigrationProgressStore` for cross-process
  resumability.  `skipExistingPids` for fan-out across worker pools.

### Added — outside-in cluster connectivity (#86)

- `ClusterClient({ contactPoints })` — lightweight handle for
  processes that aren't cluster members (REST frontends, batch jobs,
  operator scripts).  Opens one persistent TCP connection to a
  contact-point, performs the standard hello handshake with a
  synthetic client address, and exchanges `cluster-client-envelope`
  / `cluster-client-reply` frames.
- `send(targetPath, message)` for fire-and-forget,
  `ask(targetPath, message, timeoutMs?)` for request/reply,
  `close()` for teardown.
- Contact-point failover: tries them in round-robin; the first
  successful dial wins.  Ask rejections come back as deterministic
  Error rejections (path-not-found, timeout, cluster-side ask
  failure).
- `ClusterClientReceptionist` extension — cluster-side endpoint.
  Resolves the target path through the local ActorSystem and
  forwards as tell (no askId) or `ask` (with askId) plus a reply
  frame.  Start once per cluster node that should accept client
  traffic.
- Out of scope for v1: ActorRef payloads (no `encodeRefs` round-trip
  on this path), push-style subscriptions, cluster-aware routing on
  the receptionist side.

### Added — extended cluster-management HTTP endpoints (#56)

- `GET /cluster/shards?type=<typeName>` — shard-to-region map for one
  sharded type, read from the coordinator state stored in
  DistributedData.  Returns 404 if DD isn't started or the type
  hasn't recorded state yet.
- `POST /cluster/down` body `{ address }` — operator-initiated
  force-down of a remote peer.  Backed by a new public
  `cluster.down(addr)` method that emits MemberDown + MemberRemoved
  and tombstones the address.  Opt-in via `enableDownEndpoint`;
  production deployments should still gate this behind an auth
  proxy.
- `GET /metrics` — Prometheus text format from the system's
  MetricsRegistry.  Opt-in via `enableMetricsEndpoint` because most
  deployments scrape metrics from a separate port.

### Added — public Cluster API

- `Cluster.down(addr: NodeAddress | string): boolean` — operator
  force-down of a remote peer.  Symmetric to `Cluster.leave()` but
  for someone else's address.  Returns `true` if the member was
  found and downed, `false` if the address was unknown or already
  terminal.  Refuses to down `selfAddress` — that's `leave()`'s
  job (#56).

## [0.7.0] — 2026-05-11

### Added — operator-facing documentation under `docs/`

- `docs/operations/rolling-migration.md` (#91) — the canonical
  four-phase rolling-deploy walkthrough on top of `writeVersion` +
  `MasterKeyRing` + `wrapLegacy` + `SchemaRegistry`.  Code-first →
  observation → writer flip → optional cleanup, with the parallel
  master-key-rotation story.  ASCII diagram up top for the elevator
  pitch; symbol-reference table at the bottom mapping every
  mentioned API to its export path.
- `docs/persistence/migration-recipes.md` (#93) — decision-tree
  guide for picking among the five overlapping migration tools
  (`defaultsAdapter` / `migratingAdapter` / `SchemaRegistry` /
  `validatedEventAdapter` / `wrapEventAsEnvelope` + bulk
  migrators).  ASCII flowchart routes "what's the change?" to
  exactly one recipe; each recipe has a worked example and a
  "when NOT to use this" note.  Pitfalls section covers the four
  common questions (mixing adapters, downgrades, snapshots,
  manifest renames).
- `ClusterEvents.MemberRemoved` JSDoc + README clarification (#79)
  spelling out the two paths a removal can take — definitive
  (tombstoned with `removedAt`, pruneable after `tombstoneTtlMs`)
  vs FD-driven (deleted outright so a healed partition recovers).
  Public APIs already filter; only direct iteration of the raw
  membership view needs the explicit status check.
  `MemberStatus`'s `'removed'` enum entry gains a paragraph-length
  docstring with cross-refs to #75 and the event JSDoc.

### Added — broker-actor extensions

- MQTT 5.0 user properties + reason codes (#13) — opt in via
  `protocolVersion: 5` on `MqttActorSettings` (default 4 keeps
  every existing config unchanged).  Inbound `MqttMessage`
  carries optional `userProperties: Record<string, string |
  string[]>` (multi-valued per the MQTT 5.0 spec) and
  `reasonCode?: number`; outbound `MqttPublish` accepts a
  `userProperties` map that the actor attaches to the PUBLISH
  packet's v5 properties block.  On v3.1.1 those fields are
  silently dropped — the wire format has no slot for them.  New
  pure helper `buildPublishProperties(p, protocolVersion)` is
  exported for users testing the v5 path without a broker.
- JetStream pull-consumer mode (#62) — opt in via `consumer.mode:
  'pull'`.  Push remains the default.  In pull mode the actor
  doesn't run an auto-iterating subscription; instead the
  application sends `{ kind: 'fetch'; batch; expiresMs? }` cmds
  to drive batch deliveries.  Per-message ack/nak/term handshake
  is unchanged.  Batch semantics fan out all messages to `target`
  up front, then `Promise.all`-await the per-message acks —
  matches the natural pull-consumer pattern (target processes
  the batch as it likes, acks come back independently).
  `JetStreamClientLike` gains `consumers.get(stream, durable):
  Promise<PullConsumerLike>` for the structural-typing contract.

### Added — cache: bulk operations across all three backends

- `Cache.mget<V>(keys: ReadonlyArray<string>): Promise<Map<string,
  V>>` and `Cache.mset<V>(entries: ReadonlyMap<string, V>,
  ttlMs?: number): Promise<void>` (#14).  Hits land in the result
  Map keyed by request keys; misses (no entry / expired /
  malformed payload / transient backend failure) are simply
  absent — `Map.get(k)` returns `V | undefined` with the same
  "missing key" semantics as the single-key `get`.  Backend
  specifics:
    - **InMemoryCache** — iterates the underlying Map; lazy
      expiry applies to `mget` just like `get`.
    - **RedisCache** — `mget` emits a single `MGET`; `mset`
      without TTL emits a single `MSET`, with TTL falls back to
      pipelined `SET ... PX` (Redis MSET has no per-key TTL).
      `RedisClientLike` gains `mget` and `mset` to satisfy the
      structural-typing contract.
    - **MemcachedCache** — no native bulk ops on the wire;
      falls back to `Promise.all` of single-key calls.

### Added — replicated event sourcing: optional Lease

- `ReplicatedEventSourcedActor.lease()` protected hook (#89).
  Default returns `null` (multi-master, unchanged).  When it
  returns a `Lease`, the actor enforces single-writer mode for
  its `persistenceId`: only the lease holder may `persist`,
  non-holders are observers that throw on `persist` (use the
  `isLeaseHolder` getter to gate side-effect logic before
  calling).  Companion `onLeaseLost(reason)` hook fires when a
  TTL expiry / fence / backend failure flips the actor to
  observer mode.  Same Lease-based pattern v0.6.0's
  ClusterSingleton (#38) and ShardCoordinator (#60) ship —
  different scope (per-pid among replicas instead of
  cluster-wide), same machinery.  Use cases: non-replayable
  side effects (card charges, webhooks) and heartbeat actors
  where N replicas would multiply the rate.

### Changed — `Cache` interface (additive)

- The `Cache` interface gains two REQUIRED methods (`mget` and
  `mset`).  Existing user-side implementations of `Cache` must
  add them — the three shipped backends (`InMemoryCache`,
  `RedisCache`, `MemcachedCache`) are updated.  Pre-1.0
  framework, so this counts as additive evolution rather than
  a tracked breaking change — but worth flagging.

### Removed — `CONTRIBUTING.md`

- `CONTRIBUTING.md` (v0.6.0's #92) is removed.  The doc was
  written under the assumption external contributors would land
  PRs; the actual project posture is single-maintainer and PRs
  aren't accepted.  Internal conventions stay in `CLAUDE.md` /
  the plan-doc / commit-message style.
- Replaced with four issue templates under `.github/ISSUE_TEMPLATE/`:
  `bug_report.yml` (pre-labelled `bug` + `priority: medium`,
  prompts for repro / version / runtime / peer-deps / logs),
  `feature_request.yml` (pre-labelled `enhancement` +
  `priority: low`, use-case + API sketch + acceptance criteria),
  `documentation.yml` (pre-labelled `documentation` +
  `priority: low`, location + kind), and `config.yml`
  (disables blank issues, links to README / ROADMAP / CHANGELOG).
  Closes the original #77 (multi-issue close-syntax — the
  convention itself stays in commit-message style, not docs).

## [0.6.0] — 2026-05-08

### Added — sample apps (chat, voice, six frontends each)

- `examples/chat/` — clustered chat app on a 3-node TCP cluster:
  sharded persistent rooms (`ChatRoomActor` + SQLite journal),
  `OnlineUsersActor` via DistributedData + DistributedPubSub,
  cluster-singleton HTTP front door (auto-failover ~5–10 s), six
  frontends (Plain, Lit, Svelte, React, Next.js, Angular) sharing
  one `protocol.ts` over the wire (#94, #95, #96, #97).
- `examples/voice/` — distributed voice server: 1:1 PTT, group, and
  Teams-style rooms; `MediaRecorder` + `MediaSource` per-sender
  audio relay over WebSocket binary frames; same six-frontend
  matrix.  Plain HTML frontend gates `getUserMedia` on
  `isSecureContext` so Safari quirks surface upfront.
- Chat sample now uses snapshots — `ChatRoomActor.snapshotPolicy`
  via `everyNEvents(100)` + `SqliteSnapshotStore` (#102), and
  optional TLS / WSS via `--tls-cert` / `--tls-key`
  (Fastify `https` option threaded through `FastifyBackend`),
  with frontends auto-switching to `wss:` based on
  `location.protocol` (#101).

### Added — observability bridges to industry-standard SDKs

- `promClientRegistry({ client, registry, namePrefix? })` in
  `src/metrics/PromClientAdapter.ts` — bridges the framework's
  `MetricsRegistry` to a user-owned `prom-client` registry so app
  + framework metrics share one `/metrics` endpoint.  Structural
  typing on `PromClientLike` keeps `prom-client` an optional peer
  dep with no hard `import` (#64).
- `otelTracer({ api, tracer?, tracerName?, tracerVersion? })` in
  `src/tracing/OtelAdapter.ts` — bridges the framework's `Tracer`
  to `@opentelemetry/api`.  W3C `traceparent` cross-actor /
  cross-cluster propagation; `SpanKind` / `SpanStatusCode` mapping
  via lookup tables; same structural-typing approach so the OTel
  SDK stays optional (#63).
- README documents both adapters with end-to-end snippets in a new
  "Observability — Prometheus + OpenTelemetry" section.  See also
  `examples/management/prom-client-shared.ts` and
  `otel-jaeger.ts`.

### Added — persistence query: multi-tag filter

- `eventsByTag` accepts a `TagFilter` object combining three
  operators (#90):
    - `all: [...]` — intersect (every listed tag must appear).
    - `any: [...]` — union (at least one listed tag must appear).
    - `not: [...]` — exclusion (no listed tag may appear).
  A bare string stays a back-compat shorthand for `{ all: [tag] }`.
- `InMemoryQuery` does the whole match in JS.  `SqliteQuery` pushes
  the filter into SQL — `JOIN events_tags` for `all`, `IN (?,?,…)`
  with `DISTINCT` for `any`, JS-refines `not`.  Prepared statements
  cached per arity.
- `CassandraQuery` follows the same three strategies once the new
  optional `events_by_tag` side table is populated (`useTagIndex:
  true` on `CassandraJournal`).  DDL + dual-write per `(event, tag)`
  pair, exposed via `tagIndexDdl` (#44).

### Added — cluster lifecycle: TTL tombstones + LRU sharding

- Cluster-member tombstone pruning (#75) — `Member.removedAt`
  travels in gossip; new `tombstoneTtlMs` (24 h),
  `tombstonePruneIntervalMs` (5 min), `tombstoneMinRetentionMs`
  (`6 × downAfterMs`) settings; `mergeMember` rejects expired
  tombstones from gossip so a slow peer can't resurrect addresses
  already pruned cluster-wide.
- ClusterSharding `maxEntities` cap with LRU passivation (#82) —
  when the local region is at capacity, the entity with the oldest
  `lastActivity` is passivated to make room.  Default `0` (no
  cap, current behaviour); already-passivating entities don't
  count toward the cap.
- Cassandra-backed `RememberEntitiesStore` (#84) — state-based
  schema (`(type_name, shard_id, entity_id) → started_at`),
  partition-by-type for atomic whole-partition `clear`.  Both
  `JournalRememberEntitiesStore` and `CassandraRememberEntitiesStore`
  now exported from `cluster/index.ts`.

### Added — framework primitives: FSM, supervision, throttle

- `PersistentFSM.stateTimeout` (#65) — declare a per-state
  `_timeout: { afterMs, event, next, guard? }` to auto-fire a
  transition when no command moves the FSM out within the window.
  Routes the timeout fire through the actor mailbox via a magic
  self-tell so it serialises cleanly with concurrent commands;
  recovery re-arms the timer relative to wall-clock at recovery
  completion.
- `PersistentFSM` multi-event transitions (#66) — `event` in the
  transitions table accepts `Event[]` (or a function returning one)
  alongside the single-Event form.  Multiple events persist
  atomically via `persistAll`; final-state vs `next` check fires
  against the post-replay state.
- `BackoffSupervisor.triggerOn: 'failure' | 'stop' | 'any'` (#68)
  — split crash-only vs clean-stop respawn (mirrors Akka's
  `Backoff.onFailure` / `Backoff.onStop`).  Default `'any'` keeps
  the v1 behaviour.
- `BackoffSupervisor.forwardDuringGrace: false` (#67) — opt-in
  strict gate: messages arriving in the post-respawn grace window
  stash until the child confirms it survived `drainGraceMs`.  Fixes
  the dead-letter cascade described in the issue at the cost of
  `drainGraceMs` of latency on the first message after each
  respawn.
- `context.throttle({ qps, burst, onExcess: 'pause' | 'drop' })`
  per-actor token-bucket rate limiter (#83).  New `TokenBucket`
  utility class (`src/util/TokenBucket.ts`) — pure, clock-injected,
  refill-on-read.  System messages bypass the gate so lifecycle
  stays responsive under tight throttles.
- `EventStream.subscribe(actor, channel, predicate)` overload
  (#85) — predicate-filtered subscriptions, evaluated before
  delivery; throwing predicates are treated as no-match and the
  bus stays alive for other subscribers.

### Added — broker actors: long-running handler heartbeat

- `KafkaActor` `heartbeat` command + `withAutoHeartbeat` helper
  (#78) — long manual-commit handlers can periodically tell
  `{ kind: 'heartbeat', topic, partition, offset }` to bump
  kafkajs's session-deadline mid-processing.  The convenience
  helper wraps a body in a `setInterval` that fires the cmd at
  ~1/3 of session-timeout.

### Added — DX: CONTRIBUTING.md

- New `CONTRIBUTING.md` covers the workflow this project actually
  uses: setup, test layout (unit / multi-node / smoke /
  cross-runtime), commit conventions, the multi-issue close-syntax
  gotcha (`Closes #N. Closes #M.` — separate keywords required),
  Co-Authored-By trailer convention, pre-1.0 release stance, code
  style (#92, #77).

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

### Fixed

- `DistributedPubSubMediator` — gossip frame trimmed to topic
  names only (#80).  The `entries` field used to be `Record<string,
  string[]>` carrying every local subscriber's actor path per
  topic, but `handleGossip` discarded the path lists; bytes are
  now proportional to topic count, not subscriber count.  Audit
  tests pin the boundedness contract: 100 sub/unsub cycles on
  the same topic leave both `topics` and the gossip frame at
  zero entries.
- `FilesystemObjectStorageBackend` is multi-process safe (#19) —
  drops the in-memory etag map (disk is canonical via
  deterministic FNV-1a content hash) and serialises CAS via
  per-key `<key>.lock` files created with `fs.writeFile(...,
  { flag: 'wx' })`.  Body writes are atomic via temp + rename;
  Windows quirks (`EPERM` / `EBUSY` during NTFS deletion-pending
  states) recognised as benign retry signals; stale locks
  (>30 s default) reclaimed automatically.  Includes a Bun-spawn-
  based multi-process test as the integration check.
- `DistributedPubSubMediator` — eager broadcast on subscribe /
  unsubscribe.  The previous "one random peer per gossip tick"
  scheme had a probabilistic gap (~3 % per 5-tick window) where
  a publish-immediately-after-subscribe could miss the new
  subscriber.  Eager-broadcast on state mutation closes the gap
  deterministically; periodic gossip stays as steady-state
  anti-entropy.  Eliminated CI flake on
  `tests/multi-node/pubsub-cross-node.test.ts` and
  `tests/multi-node/parallel-pubsub.test.ts`.
- `tests/multi-node/cluster-router.test.ts` — replaced the tight
  5 s `waitFor(() => total === 21)` predicate with a "3 readings
  stable" stability check + 15 s timeout, covering CI variance
  when other multi-node test files run in parallel (#76).
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
