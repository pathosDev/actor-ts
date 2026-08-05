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

    failure-detector {
      heartbeat-interval = 500ms
      unreachable-after = 2s
      down-after = 5s     # measured from the last heartbeat, so > unreachable-after
    }
  }

  remote {
    # Bind address of this node.  Cluster.join reads these when its options
    # leave host/port unset, so a deployment can move the address into config.
    tcp {
      host = "0.0.0.0"
      port = 2552
    }
    tls {
      enabled = false   # DEAD KEY — not read by anything yet, see issue #591
    }
    max-frame-bytes = 16M   # per-frame wire cap; lower it on semi-trusted networks
  }

  http {
    backend = "fastify"   # fastify | express | hono
    # In-flight drain window for unbind() before connections are forced.
    # 0 keeps the historical behaviour (force immediately); raise it if you
    # want in-flight requests to finish on shutdown.
    shutdown-grace-period = 0ms

    # Server-side defaults for websocket() routes (per-connection policy).
    # Leaf names match the WebsocketRouteOptions fields (camelCase); a route
    # may override any of them, and the resolved values are validated
    # (OptionsError on a bad value).
    websocket {
      maxFrameBytes    = 1M       # inbound frame size cap
      onOversizeFrame  = "close"  # close | drop
      onInvalidMessage = "close"  # close | drop | hook
      maxBufferedBytes = 4M       # outbound buffer cap before backpressure
      onBackpressure   = "drop"   # drop | close
      # maxConnections is unlimited by default; set a positive integer to cap.
    }
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
  }

  sharding {
    number-of-shards = 64
    rebalance-interval = 2s
    hand-off-timeout = 10s
    remember-entities = false
    passivation-idle = 5m    # idle window before an entity passivates; 0 disables the sweep
    # shard-passivation-idle -- how long a shard may stand empty before it
    #   stops as well.  Deliberately left unset rather than given a value:
    #   unset, it follows passivation-idle, which is what "the shard goes
    #   when its entities do" needs.  Set it (0ms disables) to decouple them.
    max-entities = 0         # 0 = no per-node cap
  }

  worker-cluster {
    workers = "auto"   # "auto" uses navigator.hardwareConcurrency
    restart-policy = "on-failure"   # always | on-failure | never
  }

  coordinated-shutdown {
    default-phase-timeout = 5s
    terminate-actor-system = true
    exit-process = false   # call process.exit(0) once the pipeline completes
  }
}
`.trim();
