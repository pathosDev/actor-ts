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
  /** Logger root — `actor-ts.logger.*`. */
  logger: {
    level: 'actor-ts.logger.level',
  },

  /** Dispatcher root — `actor-ts.dispatcher.*`. */
  dispatcher: {
    default: 'actor-ts.dispatcher.default',
    throughput: 'actor-ts.dispatcher.throughput',
  },

  /** Cache plugin-ids — `actor-ts.cache.*`. */
  cache: {
    inMemory: 'actor-ts.cache.in-memory',
    redis: 'actor-ts.cache.redis',
    memcached: 'actor-ts.cache.memcached',
  },

  /** IO broker config roots — `actor-ts.io.broker.*`. */
  io: {
    broker: {
      amqp: 'actor-ts.io.broker.amqp',
      grpc: {
        client: 'actor-ts.io.broker.grpc.client',
        server: 'actor-ts.io.broker.grpc.server',
      },
      jetstream: 'actor-ts.io.broker.jetstream',
      kafka: 'actor-ts.io.broker.kafka',
      mqtt: 'actor-ts.io.broker.mqtt',
      nats: 'actor-ts.io.broker.nats',
      redisStreams: 'actor-ts.io.broker.redis-streams',
      sse: 'actor-ts.io.broker.sse',
      tcp: 'actor-ts.io.broker.tcp',
      udp: 'actor-ts.io.broker.udp',
      websocket: 'actor-ts.io.broker.websocket',
    },
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

  /** Cluster transport root — `actor-ts.transport`. */
  transport: 'actor-ts.transport',

  /** Worker IPC sentinels — used by the multi-runtime test harness. */
  worker: {
    hello: 'actor-ts.worker-hello',
    init: 'actor-ts.worker-init',
    ready: 'actor-ts.worker-ready',
  },
} as const;
