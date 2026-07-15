/**
 * Bundled default configuration — the `reference.conf` values every
 * feature module expects to see.  Shipped as a HOCON string constant so
 * there is no asset-copying step during `bun run build`.
 *
 * Users override these values by:
 *   - writing an `application.conf` file (HOCON or JSON), or
 *   - passing `{ config: { ... } }` to `ActorSystem.create`.
 */
export const REFERENCE_CONF = `
actor-ts {
  system {
    name = "default"
  }

  logger {
    level = "info"   # debug | info | warn | error | off
  }

  dispatcher {
    default = "immediate"   # immediate | microtask | throughput
    throughput = 16
  }

  cluster {
    gossip-interval = 1s
    seed-retry-interval = 3s
    leader-election = "lowest-address"

    failure-detector {
      heartbeat-interval = 500ms
      unreachable-after = 2s
      down-after = 5s
    }
  }

  remote {
    transport = "tcp"
    tcp {
      hostname = "0.0.0.0"
      port = 2552
    }
    tls {
      enabled = false
    }
    max-frame-size = 1M
  }

  http {
    backend = "fastify"   # fastify | bun | express
    shutdown-grace-period = 5s
  }

  cache {
    # Defaults for the built-in in-memory cache (the "default" cache, and any
    # cache whose plugin resolves to actor-ts.cache.in-memory).  Leaf names
    # match the InMemoryCacheOptions fields (camelCase) and are validated on
    # read — a bad value throws OptionsError.
    in-memory {
      maxEntries = 10000   # LRU cap on entries (Infinity/unbounded only settable in code)
      cleanupMs  = 60000   # background expired-entry sweep interval, ms (0 disables the sweep)
    }
  }

  persistence {
    journal {
      plugin = "actor-ts.persistence.journal.in-memory"
    }
    snapshot-store {
      plugin = "actor-ts.persistence.snapshot-store.in-memory"
    }
    recovery {
      mode = "eager"    # eager | parallel
    }
  }

  sharding {
    number-of-shards = 64
    rebalance-interval = 2s
    hand-off-timeout = 10s
    remember-entities = false
    passivation-idle = 0ms
  }

  worker {
    count = "auto"   # "auto" uses navigator.hardwareConcurrency
    restart-policy = "on-failure"   # always | on-failure | never
  }

  coordinated-shutdown {
    default-phase-timeout = 5s
    terminate-actor-system = true
    exit-jvm = false   # node-level: whether to call process.exit
  }
}
`.trim();
