/**
 * Single source of truth for the framework's HOCON config-key paths.
 *
 * Every key the framework ever reads from `Config.get(...)` /
 * `Config.hasPath(...)` should be reachable from this const-tree.
 * Two motivations:
 *
 *   1. **Typo-safety**: a string literal like
 *      `'actor-ts.io.broker.mqqt'` (oops — three Q's) is a silent
 *      runtime null at a config-lookup site.  `ConfigKeys.io.broker.mqtt`
 *      is a typed reference — IDE autocomplete + TypeScript catch
 *      typos before they ship.
 *
 *   2. **Discoverability**: a new contributor can scan this file to
 *      see every key the framework recognises, without grepping the
 *      whole codebase.
 *
 * Convention: every leaf is the full dotted path as a string-literal
 * type.  Group structure mirrors the dotted hierarchy.
 *
 * Migration policy: existing string literals are migrated in-place
 * one site at a time.  The tree's runtime values are the SAME strings
 * the codebase already uses — no behavioural change, just better
 * compile-time safety.
 */

export const ConfigKeys = {
  /** ActorSystem identity and lifecycle — `actor-ts.system.*`. */
  system: {
    name: 'actor-ts.system.name',
    shutdownDrainTimeout: 'actor-ts.system.shutdown-drain-timeout',
  },

  /** Logger root — `actor-ts.logger.*`. */
  logger: {
    level: 'actor-ts.logger.level',
    closeTimeout: 'actor-ts.logger.close-timeout',
    /**
     * One block root per sink.  Each is read as a *block* by the matching
     * `readXSinkOptionsFromConfig`, so the leaves under it (`enabled`,
     * `min-level`, …) need no entry of their own — the same shape the
     * cache and persistence plugin roots use.
     */
    sinks: {
      console: 'actor-ts.logger.sinks.console',
      file: 'actor-ts.logger.sinks.file',
      gelf: 'actor-ts.logger.sinks.gelf',
      loki: 'actor-ts.logger.sinks.loki',
      otlp: 'actor-ts.logger.sinks.otlp',
      parseable: 'actor-ts.logger.sinks.parseable',
      seq: 'actor-ts.logger.sinks.seq',
      splunk: 'actor-ts.logger.sinks.splunk',
      syslog: 'actor-ts.logger.sinks.syslog',
    },
  },

  /** Per-actor message-loop tuning — `actor-ts.actor.*`. */
  actor: {
    throughput: 'actor-ts.actor.throughput',
  },

  /**
   * Dead-letter queue — `actor-ts.dead-letters.*`.  Read once, in the
   * `ActorSystem` constructor, before any actor exists: a queue installed
   * later would have missed whatever died in between.
   *
   * A top-level block rather than a leaf under `actor-ts.diagnostics.*`
   * because capture is not a diagnostic switch — `persistent` makes it a
   * durability guarantee with a journal behind it.  Anything that suppresses
   * or samples the dead-letter *stream* (#1179) belongs under `diagnostics`
   * and must gate downstream of this capture, or the queue's completeness
   * claim is silently false.
   *
   * **This namespace is settled, and here is the reasoning it was missing.**
   * It shipped under #433 while #1179 and #867 were both open, which left it
   * looking like a decision taken rather than made.  Re-examined against what
   * those two issues actually propose, they are not rival homes for these
   * keys and they are not even each other's:
   *
   * - #1179 wants a per-recipient token bucket over the *publish* path, and
   *   sketches it under `actor-ts.diagnostics.*`.
   * - #867 wanted dead-letter *logging* toggles, and sketched them at the
   *   root — `log-dead-letters`, `log-dead-letters-during-shutdown`,
   *   `log-dead-letters-suspend-duration` — beside `actor-ts.debug.*`.  That
   *   sketch is superseded: #1000 shipped those three under `diagnostics`
   *   below, because `Reference.ts` has fourteen root blocks and no
   *   root-level leaf at all, and because the switch that turns a
   *   default-on log line off cannot ship after the log line does.
   *
   * Neither asks for the retention keys to move, and there is no single
   * alternative block they could move into.  The line that matters is the
   * **reader**: everything here is read by `DeadLetterQueue` and decides what
   * is *retained*; everything those two want is read on the publish side by
   * `DeadLetterRef` and decides how loudly a letter is *announced*.  Merging
   * them would give one block two readers in two subsystems, and would make a
   * suppression knob look like it gates capture — which the code deliberately
   * prevents by capturing before publishing.  Splitting by reader also keeps
   * the safety property checkable in one place instead of by convention.
   *
   * If it is ever renamed anyway, the cost is 21 files and not four: this
   * file, `Reference.ts`, `DeadLetterQueueOptions.ts`, `ActorSystem.ts`, five
   * EN docs pages with their five DE twins, and seven test files.  Only the
   * two `reference-conf.mdx` pages announce themselves, being byte-pinned by
   * `tests/unit/config/ReferenceConfDocs.test.ts`.
   */
  deadLetters: {
    store: 'actor-ts.dead-letters.store',
    maxEntries: 'actor-ts.dead-letters.max-entries',
    retention: 'actor-ts.dead-letters.retention',
    maxReplays: 'actor-ts.dead-letters.max-replays',
    persistenceId: 'actor-ts.dead-letters.persistence-id',
  },

  /**
   * What the runtime says about itself — `actor-ts.diagnostics.*`.
   *
   * Read once, in the `ActorSystem` constructor, and handed to
   * `DeadLetterRef` — the announce side of a dead letter, as against the
   * capture side that `deadLetters` above configures.  That split is the
   * settled namespace argument recorded there: retention is read by
   * `DeadLetterQueue`, loudness by `DeadLetterRef`, and merging them would
   * make a suppression knob look like it gates capture.
   *
   * Full dotted leaves rather than a block root on purpose.  A root would
   * satisfy `NoDeadConfigKeys` for every leaf beneath it — its
   * `coveringAccessor` falls back to the nearest root — so a leaf nothing
   * reads would ship with the flagship config guard green.  Named
   * individually, each one has to be referenced by the reader before the
   * guard passes.
   *
   * #867 extends this group with `log-config-on-start` and the two
   * `debug.*` switches; #1179's per-recipient suppression lands here too.
   */
  diagnostics: {
    logDeadLetters: 'actor-ts.diagnostics.log-dead-letters',
    logDeadLettersDuringShutdown: 'actor-ts.diagnostics.log-dead-letters-during-shutdown',
    logDeadLettersSuspendDuration: 'actor-ts.diagnostics.log-dead-letters-suspend-duration',
  },

  /** Dispatcher root — `actor-ts.dispatcher.*`. */
  dispatcher: {
    default: 'actor-ts.dispatcher.default',
    throughput: 'actor-ts.dispatcher.throughput',
  },

  /** Cache plugin-ids — `actor-ts.cache.*`. */
  cache: {
    /**
     * The block every named cache hangs under.  `CacheExtension` composes two
     * per-name paths from it that cannot be static leaves because the name is
     * the caller's: `<root>.<name>.plugin` selects the backend and
     * `<root>.<name>.in-memory` overrides that instance's settings.
     */
    root: 'actor-ts.cache',
    inMemory: 'actor-ts.cache.in-memory',
    redis: 'actor-ts.cache.redis',
    memcached: 'actor-ts.cache.memcached',
  },

  /** IO broker config roots — `actor-ts.io.broker.*`. */
  io: {
    broker: {
      amqp: 'actor-ts.io.broker.amqp',
      /**
       * The IMAP-in / SMTP-out mail bridge (#1133).  One root for both
       * halves: they are two sides of one connection lifecycle, and a
       * bridge configured with only one of them is the normal case rather
       * than a degenerate one.
       */
      emailBridge: 'actor-ts.io.broker.email-bridge',
      grpc: {
        client: 'actor-ts.io.broker.grpc.client',
        server: 'actor-ts.io.broker.grpc.server',
      },
      jetstream: 'actor-ts.io.broker.jetstream',
      /**
       * JetStream's KV and Object-Store views (#74) are separate actors on
       * separate roots, not sub-blocks of `jetstream`: they configure a
       * *bucket*, not a stream + consumer, and nesting them would put keys
       * like `history` under a block whose reader never looks at them.
       */
      jetstreamKeyValue: 'actor-ts.io.broker.jetstream-key-value',
      jetstreamObjectStore: 'actor-ts.io.broker.jetstream-object-store',
      kafka: 'actor-ts.io.broker.kafka',
      mqtt: 'actor-ts.io.broker.mqtt',
      nats: 'actor-ts.io.broker.nats',
      redisStreams: 'actor-ts.io.broker.redis-streams',
      sse: 'actor-ts.io.broker.sse',
      tcp: 'actor-ts.io.broker.tcp',
      /**
       * The TCP *listener* (`TcpServerActor`), on its own root rather than a
       * sub-block of `tcp`: it configures a bind address and an admission
       * cap, not a remote endpoint, so the two blocks share only `framing`.
       */
      tcpServer: 'actor-ts.io.broker.tcp-server',
      udp: 'actor-ts.io.broker.udp',
      websocket: 'actor-ts.io.broker.websocket',
    },
  },

  /** HTTP subsystem config roots — `actor-ts.http.*`. */
  http: {
    /** Which shipped backend `newServerAt(...).bind()` uses when none is set in code. */
    backend: 'actor-ts.http.backend',
    /** How long `unbind()` lets in-flight requests drain before forcing. */
    shutdownGracePeriod: 'actor-ts.http.shutdown-grace-period',
    /** Server-side WebSocket defaults for `websocket()` routes. */
    websocket: 'actor-ts.http.websocket',
    /** Outbound `HttpClient` defaults — the shared client and `newClient(...)`. */
    client: 'actor-ts.http.client',
  },

  /** Persistence plugin selection + config — `actor-ts.persistence.*`. */
  persistence: {
    journal: {
      plugin: 'actor-ts.persistence.journal.plugin',
      inMemory: 'actor-ts.persistence.journal.in-memory',
      cassandra: 'actor-ts.persistence.journal.cassandra',
    },
    snapshotStore: {
      plugin: 'actor-ts.persistence.snapshot-store.plugin',
      inMemory: 'actor-ts.persistence.snapshot-store.in-memory',
      cassandra: 'actor-ts.persistence.snapshot-store.cassandra',
      objectStorage: 'actor-ts.persistence.snapshot-store.object-storage',
    },
    durableState: {
      objectStorage: 'actor-ts.persistence.durable-state.object-storage',
    },
  },

  /**
   * Cluster membership defaults — `actor-ts.cluster.*`.  Read once by
   * `Cluster.join`, which layers them under the explicit `ClusterOptions`.
   *
   * `cluster.leader-election` is absent because it no longer exists: the
   * leader is always the lowest-addressed up-member, and a one-value
   * selector was documenting a choice the framework does not offer.
   */
  cluster: {
    gossipInterval: 'actor-ts.cluster.gossip-interval',
    seedRetryInterval: 'actor-ts.cluster.seed-retry-interval',
    /** Auto-promotion `joining` → `weakly-up`; `0` keeps it opt-in (#841). */
    weaklyUpAfter: 'actor-ts.cluster.weakly-up-after',
    /**
     * The two membership caps (#138).  They bound what unauthenticated gossip
     * can make the local member map hold — `maxFrameBytes` bounds one frame,
     * these bound what a sequence of well-formed frames accumulates.  `0`
     * disables either.
     */
    maxMembers: 'actor-ts.cluster.max-members',
    maxTombstones: 'actor-ts.cluster.max-tombstones',
    /**
     * Tombstone housekeeping — `actor-ts.cluster.tombstone.*` (#841).  Grouped
     * in HOCON because an operator tunes the three together; the matching
     * `ClusterOptions` fields stay flat (`tombstoneTtlMs`, …), the same
     * translation `remote.tcp.host` → `host` already makes.
     */
    tombstone: {
      timeToLive: 'actor-ts.cluster.tombstone.time-to-live',
      pruneInterval: 'actor-ts.cluster.tombstone.prune-interval',
      minRetention: 'actor-ts.cluster.tombstone.min-retention',
    },
    failureDetector: {
      heartbeatInterval: 'actor-ts.cluster.failure-detector.heartbeat-interval',
      unreachableAfter: 'actor-ts.cluster.failure-detector.unreachable-after',
      downAfter: 'actor-ts.cluster.failure-detector.down-after',
    },

    /**
     * Stable-observation bootstrap and readiness —
     * `actor-ts.cluster.bootstrap.*` (#148, #1355).  The observation timings
     * are read once per `bootstrapCluster` call with `stableObservation`
     * enabled, layered under the explicit tuning; the readiness pair
     * (`await-ready`, `minimum-members`) is read by every `bootstrapCluster`
     * call and by `Cluster.awaitReady` / `isReady`.
     *
     * The election's *outcome* (`ClusterOptions.selfElection`) is
     * deliberately not configurable here: it differs per node by
     * construction, and one shared value would either stop every node from
     * starting or have all of them self-elect at once.  `await-ready` ships
     * comment-only in `reference.conf` for a related reason — a leaf that is
     * always present could not express "unset", and unset is what selects
     * the grace-aware computed default (#1086).
     */
    bootstrap: {
      stableMargin: 'actor-ts.cluster.bootstrap.stable-margin',
      pollInterval: 'actor-ts.cluster.bootstrap.poll-interval',
      maxWait: 'actor-ts.cluster.bootstrap.max-wait',
      requiredContactPoints: 'actor-ts.cluster.bootstrap.required-contact-points',
      selfElectionGrace: 'actor-ts.cluster.bootstrap.self-election-grace',
      awaitReady: 'actor-ts.cluster.bootstrap.await-ready',
      minimumMembers: 'actor-ts.cluster.bootstrap.minimum-members',
    },

    /**
     * DistributedPubSub mediator tuning — `actor-ts.cluster.pub-sub.*`.
     * Read once per `DistributedPubSub.start`, which layers them under the
     * explicit options.  The three caps bound what one mediator can be made
     * to hold; they are config rather than constants because the right value
     * depends on the deployment's subscriber-to-node ratio (#139, #857).
     */
    pubSub: {
      gossipInterval: 'actor-ts.cluster.pub-sub.gossip-interval',
      maxSubscribersPerTopic: 'actor-ts.cluster.pub-sub.max-subscribers-per-topic',
      maxTopics: 'actor-ts.cluster.pub-sub.max-topics',
      maxRemoteNodesPerTopic: 'actor-ts.cluster.pub-sub.max-remote-nodes-per-topic',
      sendToDeadLettersWhenNoSubscribers:
        'actor-ts.cluster.pub-sub.send-to-dead-letters-when-no-subscribers',
    },

    /**
     * Receptionist tuning — `actor-ts.cluster.receptionist.*`.  Read once per
     * `ReceptionistExtension.start`, which layers them under the explicit
     * options (#137, #857).
     */
    receptionist: {
      gossipInterval: 'actor-ts.cluster.receptionist.gossip-interval',
      maxSubscribersPerKey: 'actor-ts.cluster.receptionist.max-subscribers-per-key',
      maxSubscriptionsTotal: 'actor-ts.cluster.receptionist.max-subscriptions-total',
    },
  },

  /**
   * DistributedData tuning — `actor-ts.distributed-data.*`.  Read once per
   * `DistributedData.start`, which layers them under the explicit options
   * (#140, #856).
   *
   * Top-level rather than under `cluster.*` (where `pub-sub` and
   * `receptionist` sit) because the module is: `DistributedData` ships from
   * `src/crdt/`, and its options type carries no `cluster` field — the
   * cluster is a positional argument to `start`, not a tunable.
   *
   * The two caps bound what one replica can be made to hold *and* how long
   * it holds it.  Each unsettled request keeps a promise, a timer and a
   * target set alive until its deadline, so the cap is what turns a timeout
   * storm into immediate rejections naming the knob.  It is not a guard
   * against the mailbox underneath — see
   * `DEFAULT_MAX_PENDING_QUORUM_REQUESTS` for why that framing was dropped
   * (#1078, #1148).
   *
   * `max-gossip-bytes` bounds the third thing: what one *outbound* frame may
   * carry.  It reads as a size (`1M`), and it is clamped down to
   * `remote.max-frame-bytes` at consume time — a budget above the wire cap is
   * the configuration that reintroduces #691, so it is not expressible (#691).
   */
  distributedData: {
    gossipInterval: 'actor-ts.distributed-data.gossip-interval',
    maxPendingQuorumRequests: 'actor-ts.distributed-data.max-pending-quorum-requests',
    maxQuorumTimeout: 'actor-ts.distributed-data.max-quorum-timeout',
    maxGossipBytes: 'actor-ts.distributed-data.max-gossip-bytes',
  },

  /**
   * Cluster addresses and wire limits — `actor-ts.remote.*`.
   *
   * `tcp.host` and `tcp.advertised-host` are two different things and only one
   * of them may be a wildcard: the first is the interface this node binds, the
   * second is the address it puts in every gossip frame for peers to dial back
   * (#944).  `advertised-host` deliberately ships no leaf in `reference.conf`,
   * so an unset one keeps meaning "derive it from `tcp.host`" instead of being
   * permanently present and empty.
   *
   * `tcp.port` and `tcp.advertised-port` are the same split one axis over
   * (#845): the first is the port bound, the second the port peers dial, and
   * the second likewise ships no leaf so that "the same as `tcp.port`" stays
   * expressible.  It is the published-container-port case — a process
   * listening on 2552 that the outside world reaches on the port
   * `docker run -p 3000:2552` published — and nothing else needs it.
   *
   * `remote.tls.enabled` is read but **not honoured**: the transport
   * `Cluster` builds for itself is always plaintext, so the flag decides
   * nothing except whether the node warns about that at startup (#591).
   * Encrypting the wire is its own issue (#941); until it lands, a key that
   * says `true` and a socket that is not encrypted is exactly the gap the
   * warning exists to close.
   */
  remote: {
    tcp: {
      host: 'actor-ts.remote.tcp.host',
      advertisedHost: 'actor-ts.remote.tcp.advertised-host',
      port: 'actor-ts.remote.tcp.port',
      advertisedPort: 'actor-ts.remote.tcp.advertised-port',
    },
    tls: {
      enabled: 'actor-ts.remote.tls.enabled',
    },
    maxFrameBytes: 'actor-ts.remote.max-frame-bytes',
  },

  /**
   * Cluster-sharding defaults — `actor-ts.sharding.*`.  Read once per
   * started type by `ClusterSharding.start`, which layers them under the
   * explicit options; the first five reach the region, the last two the
   * per-type coordinator.
   *
   * `shardPassivationIdle` has no leaf in `reference.conf` on purpose — it
   * must stay absent for "unset means: follow `passivationIdle`" to be
   * expressible, since a shipped value would make `hasPath` true forever.
   */
  sharding: {
    numberOfShards: 'actor-ts.sharding.number-of-shards',
    rememberEntities: 'actor-ts.sharding.remember-entities',
    passivationIdle: 'actor-ts.sharding.passivation-idle',
    shardPassivationIdle: 'actor-ts.sharding.shard-passivation-idle',
    maxEntities: 'actor-ts.sharding.max-entities',
    rebalanceInterval: 'actor-ts.sharding.rebalance-interval',
    handOffTimeout: 'actor-ts.sharding.hand-off-timeout',
  },

  /**
   * `WorkerCluster.spawn` defaults — `actor-ts.worker-cluster.*`.
   *
   * The block is named after the options type it feeds rather than after
   * "worker", both because that is what it configures and because
   * {@link ConfigKeys.worker} below is already taken by the IPC sentinels,
   * which are not config paths at all.
   */
  workerCluster: {
    workers: 'actor-ts.worker-cluster.workers',
    restartPolicy: 'actor-ts.worker-cluster.restart-policy',
  },

  /** CoordinatedShutdown pipeline defaults — `actor-ts.coordinated-shutdown.*`. */
  coordinatedShutdown: {
    defaultPhaseTimeout: 'actor-ts.coordinated-shutdown.default-phase-timeout',
    terminateActorSystem: 'actor-ts.coordinated-shutdown.terminate-actor-system',
    exitProcess: 'actor-ts.coordinated-shutdown.exit-process',
    autoRegisterTasks: 'actor-ts.coordinated-shutdown.auto-register-tasks',
  },

  /**
   * Worker IPC sentinels — used by the multi-runtime test harness and
   * the worker-mesh code.  Unlike the config paths above, these are
   * message-`kind` strings, so they intentionally drop the `actor-ts.`
   * prefix — wire-format discriminators don't need a framework
   * namespace.
   */
  worker: {
    hello:     'worker-hello',
    init:      'worker-init',
    ready:     'worker-ready',
    transport: 'worker-transport',
  },
} as const;
