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
   * The global mailbox bound — `actor-ts.mailbox.default.*` (#862).
   *
   * Read once, in the `ActorSystem` constructor, and layered *under* the
   * per-spawn `ActorOptions` in `ActorCell`: explicit options win, this block
   * is the fallback, and the built-in answer is still "unbounded".  It is the
   * only knob in the file that can introduce message loss in an actor whose
   * spawn site says nothing about a mailbox, which is why the reference
   * comment spends more lines on the scope than on the values.
   *
   * Full dotted leaves rather than a `mailbox` block root, for the reason
   * spelled out under `diagnostics` below: `NoDeadConfigKeys.coveringAccessor`
   * falls back to the nearest root, so a root entry would satisfy the guard
   * for a leaf nothing reads.
   */
  mailbox: {
    default: {
      capacity: 'actor-ts.mailbox.default.capacity',
      overflow: 'actor-ts.mailbox.default.overflow',
    },
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
    /**
     * The global in-memory block's *settings*, as against `inMemory` above,
     * which is its plugin **id** — the factory-map key, re-exported as
     * `IN_MEMORY_CACHE_PLUGIN_ID` and pinned by its literal value in the cache
     * suite.  The two carry the same string and stay two entries because one
     * is an identifier and the other is a config path: growing `inMemory` into
     * an object to hold these would break every use of the id.
     *
     * Declared leaf by leaf for the reason `diagnostics` gives — a root alone
     * satisfies `NoDeadConfigKeys` for everything beneath it.  The identical
     * leaves under `actor-ts.cache.<name>.in-memory` cannot be listed (the
     * name is the application's); `CacheExtension` composes those from the
     * same three suffixes.
     */
    inMemoryOptions: {
      root: 'actor-ts.cache.in-memory',
      maxEntries: 'actor-ts.cache.in-memory.max-entries',
      cleanupInterval: 'actor-ts.cache.in-memory.cleanup-interval',
      timeToLive: 'actor-ts.cache.in-memory.time-to-live',
      timeToIdle: 'actor-ts.cache.in-memory.time-to-idle',
      /** Comment-only in `reference.conf` — unset means one undivided map. */
      prefixQuotas: 'actor-ts.cache.in-memory.prefix-quotas',
    },
    /**
     * The global Redis block's *settings*, standing to `redis` above exactly as
     * `inMemoryOptions` stands to `inMemory`: one is the plugin **id** the
     * factory map is keyed by (and `REDIS_CACHE_PLUGIN_ID` re-exports), the
     * other is a config path.  Same string, two entries, for the same reason.
     *
     * Leaf by leaf rather than a root alone, because `NoDeadConfigKeys`'
     * `coveringAccessor` resolves anything under `actor-ts.cache` to the
     * `root` entry — so a root-only shape would pass the guard for a block
     * nothing reads.  The identical leaves under `actor-ts.cache.<name>.redis`
     * cannot be listed (the name is the application's);
     * {@link redisCacheKeysUnder} composes those from the same suffixes.
     *
     * `host` and `port` are **comment-only** in `reference.conf`: `url` is
     * mutually exclusive with them, and a published `host` would be set for
     * every deployment and refuse every `url`.  They are read all the same,
     * which is what this entry records.
     */
    redisOptions: {
      root: 'actor-ts.cache.redis',
      url: 'actor-ts.cache.redis.url',
      host: 'actor-ts.cache.redis.host',
      port: 'actor-ts.cache.redis.port',
      db: 'actor-ts.cache.redis.db',
      keyPrefix: 'actor-ts.cache.redis.key-prefix',
      password: 'actor-ts.cache.redis.password',
    },
    /** The global Memcached block's settings — see {@link redisOptions}. */
    memcachedOptions: {
      root: 'actor-ts.cache.memcached',
      servers: 'actor-ts.cache.memcached.servers',
      username: 'actor-ts.cache.memcached.username',
      password: 'actor-ts.cache.memcached.password',
      keyPrefix: 'actor-ts.cache.memcached.key-prefix',
    },
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
    /**
     * Per-route CORS defaults for the `cors(options, routes)` directive (#878).
     *
     * Full dotted leaves beside the `root`, for the reason `websocket` below
     * spells out — and here it matters more than anywhere else in this group:
     * four of the six leaves are **comment-only** in `reference.conf`, so they
     * have no leaf for `NoDeadConfigKeys` to walk at all, and the two that do
     * ship values would have been covered by the root whether or not
     * `resolveCorsPolicy` had ever been written.
     *
     * `origins` is settable here but the `'*'` wildcard is not: a value
     * containing it is refused with a `ConfigError` naming this key, because
     * `withAnyOrigin()` is documented as the explicit opt-in and #128 was about
     * CORS defaults being too permissive.  The predicate form has no path here
     * either — a function cannot live in HOCON.
     */
    cors: {
      root: 'actor-ts.http.cors',
      origins: 'actor-ts.http.cors.origins',
      methods: 'actor-ts.http.cors.methods',
      allowedHeaders: 'actor-ts.http.cors.allowed-headers',
      exposedHeaders: 'actor-ts.http.cors.exposed-headers',
      credentials: 'actor-ts.http.cors.credentials',
      maxAge: 'actor-ts.http.cors.max-age',
    },
    /**
     * Server-side WebSocket defaults for `websocket()` routes.
     *
     * Full dotted leaves under a `root`, not a bare block root, for the reason
     * `diagnostics` above spells out: `NoDeadConfigKeys`' `coveringAccessor`
     * falls back to the nearest root, so a root alone would pass the guard for
     * every leaf beneath it whether or not the reader had been updated.  That
     * is not hypothetical here — #1405 renamed all nine of these leaves, and
     * with only the root declared the rename could have shipped in
     * `reference.conf` with every leaf inert and the suite green.
     */
    websocket: {
      root: 'actor-ts.http.websocket',
      maxFrameBytes: 'actor-ts.http.websocket.max-frame-bytes',
      onOversizeFrame: 'actor-ts.http.websocket.on-oversize-frame',
      onInvalidMessage: 'actor-ts.http.websocket.on-invalid-message',
      maxBufferedBytes: 'actor-ts.http.websocket.max-buffered-bytes',
      onBackpressure: 'actor-ts.http.websocket.on-backpressure',
      /** Comment-only in `reference.conf` — unset means unlimited. */
      maxConnections: 'actor-ts.http.websocket.max-connections',
      maxPreAttachFrames: 'actor-ts.http.websocket.max-pre-attach-frames',
      maxPreAttachBytes: 'actor-ts.http.websocket.max-pre-attach-bytes',
      acceptTimeout: 'actor-ts.http.websocket.accept-timeout',
    },
    /** Outbound `HttpClient` defaults — the shared client and `newClient(...)`. */
    client: {
      root: 'actor-ts.http.client',
      maxResponseBytes: 'actor-ts.http.client.max-response-bytes',
      defaultTimeout: 'actor-ts.http.client.default-timeout',
      redirect: 'actor-ts.http.client.redirect',
      maxRedirects: 'actor-ts.http.client.max-redirects',
    },
  },

  /** Persistence plugin selection + config — `actor-ts.persistence.*`. */
  persistence: {
    journal: {
      plugin: 'actor-ts.persistence.journal.plugin',
      inMemory: 'actor-ts.persistence.journal.in-memory',
      cassandra: 'actor-ts.persistence.journal.cassandra',
      /**
       * The SQLite journal's block — `root` is also `SQLITE_JOURNAL_PLUGIN_ID`,
       * per the framework rule that a plugin id *is* the config section holding
       * that plugin's settings (#872).
       *
       * Full dotted leaves beside the `root`, and here that is not a formality:
       * `NoDeadConfigKeys`' `coveringAccessor` falls back to the nearest root,
       * and the root literal is *also* hard-coded as the plugin id in
       * `SqlitePlugin.ts` — so a root-only entry would be satisfied by a string
       * that is not a config read at all, and every leaf beneath it could ship
       * inert with the guard green.
       */
      sqlite: {
        root: 'actor-ts.persistence.journal.sqlite',
        path: 'actor-ts.persistence.journal.sqlite.path',
        eventsTable: 'actor-ts.persistence.journal.sqlite.events-table',
        wal: 'actor-ts.persistence.journal.sqlite.wal',
        busyTimeout: 'actor-ts.persistence.journal.sqlite.busy-timeout',
      },
    },
    snapshotStore: {
      plugin: 'actor-ts.persistence.snapshot-store.plugin',
      inMemory: 'actor-ts.persistence.snapshot-store.in-memory',
      cassandra: 'actor-ts.persistence.snapshot-store.cassandra',
      /** The SQLite snapshot store's block — see {@link journal}'s `sqlite`. */
      sqlite: {
        root: 'actor-ts.persistence.snapshot-store.sqlite',
        path: 'actor-ts.persistence.snapshot-store.sqlite.path',
        snapshotsTable: 'actor-ts.persistence.snapshot-store.sqlite.snapshots-table',
        keepN: 'actor-ts.persistence.snapshot-store.sqlite.keep-n',
        busyTimeout: 'actor-ts.persistence.snapshot-store.sqlite.busy-timeout',
      },
      /**
       * The object-storage plugin's block — the framework's rule that a plugin
       * id *is* its config section, so `root` is also
       * `OBJECT_STORAGE_SNAPSHOT_PLUGIN_ID` (#873).  It configures both stores
       * `registerObjectStoragePlugins` returns, because the two share one
       * backend; `durableState.objectStorage` below stays a bare plugin id and
       * gets no leaves of its own.
       *
       * Full dotted leaves beside the `root`, for the reason `http.websocket`
       * spells out: `NoDeadConfigKeys`' `coveringAccessor` falls back to the
       * nearest root, so a root alone passes the guard for every leaf beneath
       * it whether or not the reader reads it — and here the root literal is
       * *also* hard-coded as the plugin id in `ObjectStoragePlugin.ts`, so a
       * root-only entry would have been satisfied by a string that is not a
       * config read at all.
       *
       * No leaf carries key material, and that is structural rather than a
       * convention: `s3.credentials`, the client-side master key and the
       * integrity key have no path here at all, so a config file cannot
       * express them.
       */
      objectStorage: {
        root: 'actor-ts.persistence.snapshot-store.object-storage',
        backend: 'actor-ts.persistence.snapshot-store.object-storage.backend',
        prefix: 'actor-ts.persistence.snapshot-store.object-storage.prefix',
        keepN: 'actor-ts.persistence.snapshot-store.object-storage.keep-n',
        maxDecompressedBytes: 'actor-ts.persistence.snapshot-store.object-storage.max-decompressed-bytes',
        compressionAlgorithm: 'actor-ts.persistence.snapshot-store.object-storage.compression.algorithm',
        /** Comment-only in `reference.conf` — absence selects the encoder's per-algorithm default. */
        compressionLevel: 'actor-ts.persistence.snapshot-store.object-storage.compression.level',
        encryptionMode: 'actor-ts.persistence.snapshot-store.object-storage.encryption.mode',
        encryptionKmsKeyId: 'actor-ts.persistence.snapshot-store.object-storage.encryption.kms-key-id',
        s3Bucket: 'actor-ts.persistence.snapshot-store.object-storage.s3.bucket',
        s3Region: 'actor-ts.persistence.snapshot-store.object-storage.s3.region',
        s3Endpoint: 'actor-ts.persistence.snapshot-store.object-storage.s3.endpoint',
        s3ForcePathStyle: 'actor-ts.persistence.snapshot-store.object-storage.s3.force-path-style',
        filesystemDir: 'actor-ts.persistence.snapshot-store.object-storage.filesystem.dir',
        filesystemLockTimeout: 'actor-ts.persistence.snapshot-store.object-storage.filesystem.lock-timeout',
        filesystemStaleLock: 'actor-ts.persistence.snapshot-store.object-storage.filesystem.stale-lock',
      },
    },
    /**
     * The third plug-in axis (#872).  It shipped as a namespace of ids nothing
     * could select: `PersistenceExtension` carried only a journal and a
     * snapshot-store registry, so `durable-state.object-storage` named a
     * plugin that had to be threaded through application code by hand.
     * `plugin` is the selector `PersistenceExtension.durableStateStore`
     * resolves through, and `DurableStateActor` falls back to it when its
     * options name no store.
     */
    durableState: {
      plugin: 'actor-ts.persistence.durable-state.plugin',
      inMemory: 'actor-ts.persistence.durable-state.in-memory',
      objectStorage: 'actor-ts.persistence.durable-state.object-storage',
      /** The SQLite durable-state store's block — see {@link journal}'s `sqlite`. */
      sqlite: {
        root: 'actor-ts.persistence.durable-state.sqlite',
        path: 'actor-ts.persistence.durable-state.sqlite.path',
        table: 'actor-ts.persistence.durable-state.sqlite.table',
        autoCreateTables: 'actor-ts.persistence.durable-state.sqlite.auto-create-tables',
        busyTimeout: 'actor-ts.persistence.durable-state.sqlite.busy-timeout',
      },
    },
  },

  /**
   * The management HTTP surface — `actor-ts.management.*`.  Two readers, one
   * block: `readManagementRoutesOptionsFromConfig` supplies what
   * `managementRoutes` layers under its explicit options, and
   * `readHealthCheckRegistryOptionsFromConfig` supplies the per-check deadline
   * the shared `HealthCheckRegistry` is built with.  They are separate because
   * the registry exists from the first `healthChecksOf(system)` call, usually
   * long before anything builds a route tree.
   *
   * Every leaf is spelled out rather than covered by a block root: a root
   * alone satisfies the `NoDeadConfigKeys` reachability check for everything
   * beneath it, so an inert leaf would ship green (#882).
   *
   * `auth` and `ipAllowlist` have no path here and cannot get one — they are
   * `Middleware` functions, which HOCON has no way to express.  That is what
   * makes the block unable to weaken the security wiring: it decides which
   * endpoints exist and where the probes answer, never who may reach them.
   */
  management: {
    enableLeaveEndpoint: 'actor-ts.management.enable-leave-endpoint',
    enableDownEndpoint: 'actor-ts.management.enable-down-endpoint',
    enableMetricsEndpoint: 'actor-ts.management.enable-metrics-endpoint',
    authProtectHealth: 'actor-ts.management.auth-protect-health',
    livenessPath: 'actor-ts.management.liveness-path',
    readinessPath: 'actor-ts.management.readiness-path',
    healthChecks: {
      checkTimeout: 'actor-ts.management.health-checks.check-timeout',
    },
  },

  /**
   * Named circuit breakers — `actor-ts.circuit-breaker.*`.  Read by
   * `CircuitBreakerExtension.breaker(id)`, which layers
   * `<root>.<id>.*` over `<root>.default.*` over the built-in floor, and the
   * caller's explicit options over all three.
   *
   * `default` is reserved: it is the defaults block AND the id `breaker()`
   * resolves with no argument, which is the same thing twice rather than a
   * collision.  `<root>.<id>.*` cannot be declared here at all — the id is the
   * application's — which is what `ConfigKeys.cache.root` is for too.
   *
   * Every leaf under `default` is spelled out rather than covered by that
   * root: a root alone satisfies the `NoDeadConfigKeys` reachability check for
   * everything beneath it, and here it would be worse than usual, because the
   * root's last segment is `default` — a substring of nearly every TypeScript
   * file — so the guard would have passed on nothing at all (#864).
   */
  circuitBreaker: {
    root: 'actor-ts.circuit-breaker',
    default: {
      maxFailures: 'actor-ts.circuit-breaker.default.max-failures',
      resetTimeout: 'actor-ts.circuit-breaker.default.reset-timeout',
      /** Comment-only in reference.conf — omitting it is what disables the per-call timeout. */
      callTimeout: 'actor-ts.circuit-breaker.default.call-timeout',
      maxResetTimeout: 'actor-ts.circuit-breaker.default.max-reset-timeout',
      backoffFactor: 'actor-ts.circuit-breaker.default.backoff-factor',
      randomFactor: 'actor-ts.circuit-breaker.default.random-factor',
      ignoredErrorNames: 'actor-ts.circuit-breaker.default.ignored-error-names',
    },
  },

  /**
   * Process-wide projection defaults — `actor-ts.projection.*`.  Read by
   * `ProjectionActor.byPersistenceId` / `byTag`, which layer them under the
   * explicit `ProjectionOptions` of a single projection.
   *
   * Top-level rather than under `actor-ts.persistence.*` because that block is
   * exclusively plugin-id namespaces (`journal.plugin` names another config
   * root), so a tuning leaf dropped in there reads as a plugin id.
   * `actor-ts.sharding` is the same shape — a top-level block owned by a
   * subdirectory subsystem.
   *
   * Every leaf is spelled out rather than covered by a block root: a root
   * alone satisfies the `NoDeadConfigKeys` reachability check for everything
   * beneath it, so an inert leaf would ship green (#875).
   */
  projection: {
    recoveryStrategy: 'actor-ts.projection.recovery-strategy',
    maxRetries: 'actor-ts.projection.max-retries',
    retryBackoff: 'actor-ts.projection.retry-backoff',
    maxRetryBackoff: 'actor-ts.projection.max-retry-backoff',
    pollInterval: 'actor-ts.projection.poll-interval',
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
    /**
     * Failure detection — `actor-ts.cluster.failure-detector.*` (#840).
     *
     * `implementation` picks the algorithm; `heartbeat-interval` is shared by
     * both and belongs to the cluster's heartbeat loop rather than to either
     * detector (#1142), which is why the `phi` sub-block does not repeat it.
     * `unreachable-after` / `down-after` are the *simple* detector's
     * thresholds and mean nothing to the φ-accrual one, whose suspicion values
     * live under `phi`.
     *
     * Full dotted leaves under `phi`, not a bare block root: `NoDeadConfigKeys`'
     * `coveringAccessor` falls back to the nearest root, so a root alone would
     * pass the guard for all five leaves whether or not the reader had ever
     * been written.
     */
    failureDetector: {
      implementation: 'actor-ts.cluster.failure-detector.implementation',
      heartbeatInterval: 'actor-ts.cluster.failure-detector.heartbeat-interval',
      unreachableAfter: 'actor-ts.cluster.failure-detector.unreachable-after',
      downAfter: 'actor-ts.cluster.failure-detector.down-after',
      phi: {
        unreachableThreshold: 'actor-ts.cluster.failure-detector.phi.unreachable-threshold',
        downThreshold: 'actor-ts.cluster.failure-detector.phi.down-threshold',
        maxSampleSize: 'actor-ts.cluster.failure-detector.phi.max-sample-size',
        minStdDeviation: 'actor-ts.cluster.failure-detector.phi.min-std-deviation',
        acceptableHeartbeatPause: 'actor-ts.cluster.failure-detector.phi.acceptable-heartbeat-pause',
      },
    },

    /**
     * Split-brain resolution — `actor-ts.cluster.split-brain-resolver.*`
     * (#838).  `active-strategy` names which `DowningProvider`
     * `readDowningFromConfig` (`src/cluster/downing/DowningFromConfig.ts`)
     * builds; the per-strategy leaves are that strategy's own options.
     *
     * Four strategies are selectable and `lease-majority` is not: it
     * arbitrates through a live `Lease` whose `owner` is this node's own
     * address, and a config reader holds a `Config` and nothing else.
     * #859 opened `actor-ts.coordination` for lease *tuning* and changed
     * nothing here — there is still no key that names which `Lease` backend
     * to build, so the reader refuses the value and points at
     * `withDowning(new LeaseMajority(…))`.
     *
     * `static-quorum.quorum-size` and the two `keep-referee` leaves ship
     * **comment-only** in `reference.conf`, so `hasPath` stays false until an
     * operator sets one.  Each is required or bounded and has no legal
     * default: `quorum-size = 0` is refused by `StaticQuorumOptionsValidator`
     * and `referee-address = ""` by `KeepRefereeOptionsValidator`, so a
     * shipped leaf could only be a value that stops the node from starting.
     * They are still declared here, which is what makes setting one in an
     * `application.conf` work — the `remote.tcp.advertised-host` shape.
     *
     * Full dotted leaves rather than a `split-brain-resolver` root, for the
     * reason `failure-detector.phi` above states: `NoDeadConfigKeys`'
     * `coveringAccessor` falls back to the nearest root, so a root alone
     * would pass the guard for every leaf under it whether or not the reader
     * addressed it.
     */
    splitBrainResolver: {
      activeStrategy: 'actor-ts.cluster.split-brain-resolver.active-strategy',
      keepMajority: {
        role: 'actor-ts.cluster.split-brain-resolver.keep-majority.role',
      },
      keepOldest: {
        role: 'actor-ts.cluster.split-brain-resolver.keep-oldest.role',
      },
      keepReferee: {
        /** Comment-only in `reference.conf` — `""` is refused by the validator. */
        refereeAddress: 'actor-ts.cluster.split-brain-resolver.keep-referee.referee-address',
        /** Comment-only — absence is what "no extra quorum rule" has to look like. */
        downAllIfBelowQuorum:
          'actor-ts.cluster.split-brain-resolver.keep-referee.down-all-if-below-quorum',
      },
      staticQuorum: {
        role: 'actor-ts.cluster.split-brain-resolver.static-quorum.role',
        /** Comment-only in `reference.conf` — `0` is refused by the validator. */
        quorumSize: 'actor-ts.cluster.split-brain-resolver.static-quorum.quorum-size',
      },
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
   *
   * `log-data-size-exceeding` reports on the same measurement one order of
   * magnitude earlier and changes nothing: a key past it still gossips, it is
   * merely named, because a value at a large fraction of the budget slows
   * every other key's sweep and nothing else says so.  `durable-keys` is the
   * only leaf here that is not a bound — it narrows what a configured
   * `durableStore` writes, and an empty list means every key (#856).
   */
  distributedData: {
    gossipInterval: 'actor-ts.distributed-data.gossip-interval',
    maxPendingQuorumRequests: 'actor-ts.distributed-data.max-pending-quorum-requests',
    maxQuorumTimeout: 'actor-ts.distributed-data.max-quorum-timeout',
    maxGossipBytes: 'actor-ts.distributed-data.max-gossip-bytes',
    logDataSizeExceeding: 'actor-ts.distributed-data.log-data-size-exceeding',
    durableKeys: 'actor-ts.distributed-data.durable-keys',
  },

  /**
   * Reliable delivery — `actor-ts.reliable-delivery.*` (#861).
   *
   * Every leaf is spelled out rather than covered by a block root, for the
   * reason the two groups below it give: `NoDeadConfigKeys`' covering accessor
   * falls back to *"a root above it"*, so a root-only entry would let any leaf
   * under it pass whether or not a reader addresses it.  The readers are
   * `readProducerControllerOptionsFromConfig`
   * (`src/delivery/ProducerControllerOptions.ts`) and
   * `readConsumerControllerOptionsFromConfig`
   * (`src/delivery/ConsumerControllerOptions.ts`), layered in
   * `ReliableDelivery.producer` / `.consumer`.
   *
   * The block is named for the `ReliableDelivery` class and the
   * `reliable-delivery.*` message kinds on the wire, not for the `src/delivery`
   * directory: `actor-ts.logger.sinks.*.delivery.*` is already taken by log-sink
   * batching, with its own `DeliveryOptions` type and `DEFAULT_DELIVERY_*`
   * constants, so a top-level `actor-ts.delivery` would collide in prose and in
   * constant naming even though HOCON would keep the two apart.
   *
   * `producer-idle-time-to-live` spells out the field's `Ttl`, following
   * `cluster.tombstone.time-to-live` ⇔ `tombstoneTtlMs` above — the same
   * divergence from the leaf/field lockstep, and the same reason for it: the
   * `Ms` suffix is carried by the HOCON duration unit and the abbreviation is
   * one AGENTS.md asks to spell out.
   *
   * `producer.producer-id` deliberately has no key.  It is a real options
   * field, but one shared value across every producer in a process is the
   * corruption `Constants.ts` documents — the consumer keys its deduplication
   * on it, so two producers sharing an id reset each other's window.
   */
  reliableDelivery: {
    producer: {
      resendTimeout: 'actor-ts.reliable-delivery.producer.resend-timeout',
      windowSize: 'actor-ts.reliable-delivery.producer.window-size',
    },
    consumer: {
      maxProducers: 'actor-ts.reliable-delivery.consumer.max-producers',
      producerIdleTimeToLive: 'actor-ts.reliable-delivery.consumer.producer-idle-time-to-live',
    },
  },

  /**
   * Decoder ceilings — `actor-ts.serialization.read-constraints.*` (#880).
   *
   * Every leaf is declared individually rather than as a block root, and that
   * is load-bearing: `NoDeadConfigKeys`'s `coveringAccessor` accepts a root
   * above a leaf, so a single `readConstraints` entry would cover all three and
   * a leaf nothing reads would pass the guard that exists to catch exactly
   * that.  Per-leaf entries make the guard check each reader.
   *
   * They bound READS only.  The encoder keeps a hard `MAX_NESTING_DEPTH`, so
   * lowering `max-nesting-depth` makes this node stricter than its own writer
   * and raising it past the encoder's cap is refused — a node that accepted
   * what it cannot produce is the asymmetry #1036 closed.
   */
  serialization: {
    readConstraints: {
      maxNestingDepth: 'actor-ts.serialization.read-constraints.max-nesting-depth',
      maxDocumentBytes: 'actor-ts.serialization.read-constraints.max-document-bytes',
      maxStringLength: 'actor-ts.serialization.read-constraints.max-string-length',
    },
  },

  /**
   * Lease coordination — `actor-ts.coordination.*` (#859).
   *
   * Every leaf is spelled out rather than covered by a block root, and that is
   * load-bearing: `NoDeadConfigKeys`' covering-accessor falls back to *"a root
   * above it"*, so a root-only entry would let any leaf under it pass whether
   * or not a reader ever addresses it. The readers here are
   * `readLeaseOptionsFromConfig` (`src/coordination/LeaseOptions.ts`) and
   * `readKubernetesLeaseOptionsFromConfig`
   * (`src/coordination/leases/KubernetesLeaseOptions.ts`).
   *
   * `lease.ttl`, `lease.renewal-interval` and `lease.kubernetes.namespace`
   * deliberately ship **no leaf** in `reference.conf`, so `hasPath` stays false
   * until an operator sets one. Each is a field the code either requires or
   * derives: a shipped `ttl` would satisfy `validateRequired` for every lease
   * in the process and make the #596 guard unreachable; a shipped
   * `renewal-interval` would displace the computed `max(500ms, ttl/3)`, and `0`
   * cannot stand in for "derive it" because the validator rejects it; a shipped
   * `namespace` could only be `""`, which the validator rejects too, and would
   * take away "read it from the Pod's ServiceAccount mount". They are still
   * read here, which is what makes setting one in an `application.conf` work.
   *
   * `acquire-retries` / `acquire-retry-delay` have no keys at all: the two
   * backends ship different built-in defaults (3 / 100 ms for Kubernetes, 1 /
   * 50 ms in memory) and a single leaf would silently unify them.
   */
  coordination: {
    lease: {
      ttl: 'actor-ts.coordination.lease.ttl',
      renewalInterval: 'actor-ts.coordination.lease.renewal-interval',
      kubernetes: {
        namespace: 'actor-ts.coordination.lease.kubernetes.namespace',
        namespacePath: 'actor-ts.coordination.lease.kubernetes.namespace-path',
        tokenPath: 'actor-ts.coordination.lease.kubernetes.token-path',
        caPath: 'actor-ts.coordination.lease.kubernetes.ca-path',
        tokenReloadInterval: 'actor-ts.coordination.lease.kubernetes.token-reload-interval',
        operationTimeout: 'actor-ts.coordination.lease.kubernetes.operation-timeout',
        leaseNameMaxLength: 'actor-ts.coordination.lease.kubernetes.lease-name-max-length',
      },
    },
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
   *
   * `untrusted-mode` and `trusted-selection-paths` narrow the one thing a
   * remote party chooses — the `to` path on an inbound envelope (#877).  They
   * do **not** decide whether `/system` is reachable: that is refused
   * unconditionally in `EnvelopeTrust`, because a switch defaulted off would
   * leave #964 open on every deployment that did not opt in.
   *
   * The last four are the transport's **association-lifecycle** bounds, which
   * have been enforced since #588 and #697 and only became configurable in
   * #846.  They are what an unauthenticated party can make this node hold:
   * `handshake-timeout` reclaims a connection that never speaks its half of
   * the handshake, `incomplete-frame-idle` reclaims one that went silent
   * mid-frame, `max-inbound-connections` stops either cost from being
   * multiplied by opening sockets in a loop, and `outbound-queue-size` bounds
   * what this node holds for a peer that is not taking it.
   *
   * `handshake-timeout` is deliberately **one** key rather than a dial/accept
   * pair.  The dialling side's clock starts before the TCP connect and the TLS
   * handshake and the accepting side's starts after the accept, so equal
   * numbers mean the peer that is still trying has always given up first; a
   * split pair lets an operator set the acceptor stricter and make a healthy
   * peer permanently unreachable.
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
    untrustedMode: 'actor-ts.remote.untrusted-mode',
    trustedSelectionPaths: 'actor-ts.remote.trusted-selection-paths',
    handshakeTimeout: 'actor-ts.remote.handshake-timeout',
    outboundQueueSize: 'actor-ts.remote.outbound-queue-size',
    maxInboundConnections: 'actor-ts.remote.max-inbound-connections',
    incompleteFrameIdle: 'actor-ts.remote.incomplete-frame-idle',
  },

  /**
   * Cluster-sharding defaults — `actor-ts.sharding.*`.  Read once per
   * started type by `ClusterSharding.start`, which layers them under the
   * explicit options; most reach the region, `rebalanceInterval` and
   * `acquireRetryInterval` and `handOffTimeout` the per-type coordinator, and
   * `shardRegionQueryTimeout` neither — it is the default
   * `ClusterSharding.shards()` / `shardRefFor()` wait, held on this node.
   *
   * `shardPassivationIdle` has no leaf in `reference.conf` on purpose — it
   * must stay absent for "unset means: follow `passivationIdle`" to be
   * expressible, since a shipped value would make `hasPath` true forever.
   *
   * `bufferSize` caps the region's routing buffer as a **region-wide total**
   * (#849).  The buffer is keyed by shard id, so reading it as per-shard
   * multiplies the bound by `numberOfShards`; and `0` here means *never
   * buffer*, the opposite polarity to `maxEntities = 0`, which means *no cap*.
   *
   * `role` names **which** role hosts a type; it does not *give* a node that
   * role, because `ClusterOptions.roles` is per-node identity and deliberately
   * has no leaf of its own.  Which role hosts a type is uniform across a
   * deployment — which roles a node carries is not — and that asymmetry is
   * both the argument for the key and the reason it ships as `""`: the empty
   * string is the only way a shipped leaf can still mean *unrestricted*, since
   * `reference.conf` merges under everything and would otherwise make
   * `hasPath` true forever (#847).
   *
   * `acquireRetryInterval` paces the coordinator's re-`acquire()` after a
   * failed one.  It only has an observable effect where a `Lease` was passed
   * in code: HOCON has no way to name one, and there is deliberately no
   * `use-lease` switch, because nothing in the tree turns a boolean into a
   * `Lease` and a switch that silently produced none would advertise
   * split-brain protection that is not there (#847, #855, #859).
   *
   * The three `entityRecovery*` leaves pace how remembered entities come back
   * after a region is handed a shard (#851).  They are declared here as full
   * dotted paths rather than as an `entity-recovery` block root on purpose:
   * `NoDeadConfigKeys`'s covering-accessor lookup falls back to *any* config
   * root above a leaf, so a root-only entry would let all three pass whether
   * or not a reader ever touched them.
   *
   * `entityRecoveryConstantRateNumberOfEntities` is a **region-wide** budget,
   * like `bufferSize` and `maxEntities` above and for the same reason: the
   * recovery queue is fed by every shard the region owns, so read per shard
   * the key would silently mean `numberOfShards ×` what it says.
   *
   * The two `rebalance*Limit` leaves bound shards **in flight**, not shards per
   * tick, and they reach the coordinator rather than a strategy on purpose
   * (#850): capping inside `LeastShardAllocationStrategy` — which already caps
   * itself — would have left the default `HashAllocationStrategy`, and every
   * user-supplied one, uncapped.
   */
  sharding: {
    numberOfShards: 'actor-ts.sharding.number-of-shards',
    role: 'actor-ts.sharding.role',
    rememberEntities: 'actor-ts.sharding.remember-entities',
    passivationIdle: 'actor-ts.sharding.passivation-idle',
    shardPassivationIdle: 'actor-ts.sharding.shard-passivation-idle',
    maxEntities: 'actor-ts.sharding.max-entities',
    bufferSize: 'actor-ts.sharding.buffer-size',
    registerRetryInterval: 'actor-ts.sharding.register-retry-interval',
    rebalanceInterval: 'actor-ts.sharding.rebalance-interval',
    handOffTimeout: 'actor-ts.sharding.hand-off-timeout',
    rebalanceAbsoluteLimit: 'actor-ts.sharding.rebalance-absolute-limit',
    rebalanceRelativeLimit: 'actor-ts.sharding.rebalance-relative-limit',
    acquireRetryInterval: 'actor-ts.sharding.acquire-retry-interval',
    shardRegionQueryTimeout: 'actor-ts.sharding.shard-region-query-timeout',
    entityRecoveryStrategy: 'actor-ts.sharding.entity-recovery.strategy',
    entityRecoveryConstantRateFrequency: 'actor-ts.sharding.entity-recovery.constant-rate.frequency',
    entityRecoveryConstantRateNumberOfEntities:
      'actor-ts.sharding.entity-recovery.constant-rate.number-of-entities',
    /**
     * Stale-region detection — `actor-ts.sharding.stale-region-detection.*`
     * (#853).  Grouped in HOCON because the three are only meaningful together;
     * the matching options fields stay flat (`staleRegionDetection`,
     * `regionHeartbeatIntervalMs`, `regionStaleAfterMs`), the same translation
     * `cluster.tombstone.*` already makes.
     *
     * Full dotted leaves, not a bare `staleRegionDetection` root, and for the
     * reason `entity-recovery` above spells out: `NoDeadConfigKeys` resolves a
     * leaf through *any* config root above it, so a root-only entry would let
     * all three pass with nothing reading them.
     */
    staleRegionDetection: {
      enabled: 'actor-ts.sharding.stale-region-detection.enabled',
      heartbeatInterval: 'actor-ts.sharding.stale-region-detection.heartbeat-interval',
      staleAfter: 'actor-ts.sharding.stale-region-detection.stale-after',
    },
  },

  /**
   * `ShardedDaemonProcess.init` defaults — `actor-ts.sharded-daemon-process.*`
   * (#854).  Read once per `init` and merged under the caller's options, which
   * is the seam the module had none of: it used to cast its argument straight
   * to the settings type, so a daemon set was configurable from code and from
   * nowhere else.
   *
   * A top-level group rather than a nesting under {@link ConfigKeys.sharding}
   * because a daemon set is a module built *on* sharding: `sharding.*` tunes
   * every sharded type, these two tune only the daemons.
   *
   * Both are full dotted paths rather than a `shardedDaemonProcess` block root,
   * for the reason `sharding.entityRecovery*` above spells out: `NoDeadConfigKeys`
   * resolves a leaf through *any* config root above it, so a root-only entry
   * would let both pass with nothing reading them.
   *
   * `name`, `numDaemons` and `actorFor` have no leaf: they describe one daemon
   * set, not a deployment, and a factory has no HOCON form at all.
   */
  shardedDaemonProcess: {
    livenessInterval: 'actor-ts.sharded-daemon-process.liveness-interval',
    role: 'actor-ts.sharded-daemon-process.role',
  },

  /**
   * DevTools attachment defaults — `actor-ts.devtools.*`.
   *
   * The block does not *start* DevTools: nothing in `ActorSystem` constructs
   * the extension, and `DevTools.attach(system)` is always a code call.  It
   * fills in what that call leaves unset, and is read once per attach or
   * mount by `readDevToolsOptionsFromConfig`.
   *
   * Every leaf is declared individually, `panels` included, rather than as a
   * block root read whole.  `NoDeadConfigKeys` resolves a leaf under a root
   * to that root's accessor, so a root-only entry would let a leaf nothing
   * reads pass the guard — and these leaves are read one literal at a time
   * precisely so the guard can see each of them.
   *
   * `auth`, `ipAllowlist`, `backend`, `cluster` and `replayFolds` have no
   * leaf because HOCON cannot express a function or a live object.
   * `allowUngatedMount` and `allowMessageSending` have none by decision: one
   * states a fact about the code that binds `mount()`'s routes rather than
   * about a deployment, the other grants a browser write access into the
   * running system (#881).
   */
  devtools: {
    host: 'actor-ts.devtools.host',
    port: 'actor-ts.devtools.port',
    allowRemote: 'actor-ts.devtools.allow-remote',
    serveUi: 'actor-ts.devtools.serve-ui',
    allowedOrigins: 'actor-ts.devtools.allowed-origins',
    /** Per-panel switches; a panel is disabled only by an explicit `false`. */
    panels: {
      actors: 'actor-ts.devtools.panels.actors',
      cluster: 'actor-ts.devtools.panels.cluster',
      tracing: 'actor-ts.devtools.panels.tracing',
      explain: 'actor-ts.devtools.panels.explain',
      timeTravel: 'actor-ts.devtools.panels.time-travel',
      profiler: 'actor-ts.devtools.panels.profiler',
      deadLetters: 'actor-ts.devtools.panels.dead-letters',
      eventStream: 'actor-ts.devtools.panels.event-stream',
      config: 'actor-ts.devtools.panels.config',
      send: 'actor-ts.devtools.panels.send',
    },
    // The four interval leaves drop the `Ms` their fields carry and take a
    // HOCON duration literal, as `cluster.receptionist.gossip-interval`
    // (field `gossipIntervalMs`) already does.
    mailboxSampleInterval: 'actor-ts.devtools.mailbox-sample-interval',
    mailboxSampleLimit: 'actor-ts.devtools.mailbox-sample-limit',
    statsInterval: 'actor-ts.devtools.stats-interval',
    spanBufferCapacity: 'actor-ts.devtools.span-buffer-capacity',
    spanFlushInterval: 'actor-ts.devtools.span-flush-interval',
    eventBufferCapacity: 'actor-ts.devtools.event-buffer-capacity',
    eventFlushInterval: 'actor-ts.devtools.event-flush-interval',
    replayAutoCapture: 'actor-ts.devtools.replay-auto-capture',
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
    systemName: 'actor-ts.worker-cluster.system-name',
    hostname: 'actor-ts.worker-cluster.hostname',
    basePort: 'actor-ts.worker-cluster.base-port',
    // The four duration leaves drop the `Ms` their fields carry and take a
    // HOCON duration literal, as `logger.close-timeout` (field
    // `closeTimeoutMs`) and `…delivery.flush-interval` (field
    // `flushIntervalMs`) already do.  A `…-ms` leaf would be the first in
    // reference.conf and would make `10s` unwritable.
    readyTimeout: 'actor-ts.worker-cluster.ready-timeout',
    restartPolicy: 'actor-ts.worker-cluster.restart-policy',
    restartMinBackoff: 'actor-ts.worker-cluster.restart-min-backoff',
    restartMaxBackoff: 'actor-ts.worker-cluster.restart-max-backoff',
    restartRandomFactor: 'actor-ts.worker-cluster.restart-random-factor',
    maxRestarts: 'actor-ts.worker-cluster.max-restarts',
    restartWindow: 'actor-ts.worker-cluster.restart-window',
  },

  /**
   * CoordinatedShutdown pipeline defaults — `actor-ts.coordinated-shutdown.*`.
   *
   * All of them are read inline in the `CoordinatedShutdown` constructor;
   * there is deliberately no `CoordinatedShutdownOptions` triad, for the
   * reason `DEFAULT_PHASE_TIMEOUT_MS` gives in `src/Constants.ts`.
   *
   * `phases` is a block root rather than a leaf, and it ships **comment-only**
   * in `reference.conf`: its children are named after the operator's phases,
   * so there is no fixed set of leaves to publish, and an example one
   * (`phases.service-unbind.timeout = 5s`) would freeze that example's budget
   * into every deployment's effective config (#866).
   */
  coordinatedShutdown: {
    defaultPhaseTimeout: 'actor-ts.coordinated-shutdown.default-phase-timeout',
    terminateActorSystem: 'actor-ts.coordinated-shutdown.terminate-actor-system',
    exitProcess: 'actor-ts.coordinated-shutdown.exit-process',
    exitCode: 'actor-ts.coordinated-shutdown.exit-code',
    autoRegisterTasks: 'actor-ts.coordinated-shutdown.auto-register-tasks',
    runByProcessSignals: 'actor-ts.coordinated-shutdown.run-by-process-signals',
    phases: 'actor-ts.coordinated-shutdown.phases',
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
