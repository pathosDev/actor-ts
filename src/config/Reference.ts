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

    # How long terminate() lets the actors under /user finish the work they
    # already have before the stop cascade starts.  The wait ends as soon as
    # the tree goes quiet, so an idle system pays a tick rather than the
    # budget; what is still queued when the budget runs out is dead-lettered
    # exactly as it was before.  Keep it under
    # coordinated-shutdown.default-phase-timeout — the last phase awaits
    # terminate(), so a drain as long as the phase leaves no room to stop
    # anything.  0 disables draining and restores the pre-#663 behaviour.
    #
    # A throttled or suspended mailbox is never waited on: neither drains at
    # a rate a shutdown can wait for.
    shutdown-drain-timeout = 2s
  }

  logger {
    # System log level.  Gates BEFORE the per-sink min-levels below, so a
    # sink asking for "debug" while this says "info" receives nothing —
    # lower this first, then narrow per sink.
    level = "info"   # debug | info | warn | error | off

    # Grace period terminate() gives the active logger to flush and close
    # its sinks before whenTerminated() resolves.  Bounds the whole logger,
    # so it applies to a custom one too — any logger with a close().
    close-timeout = 3s

    # Multi-sink pipeline.  Every sink ships disabled; enabling at least one
    # replaces the default single ConsoleLogger with a MultiSinkLogger over
    # the enabled set.  An explicit logger (or logSinks) passed to
    # ActorSystem.create replaces this whole block rather than merging with
    # it -- a sink belongs to one construction world or the other.
    #
    # The Sentry sink has no block here: it needs your own @sentry/node
    # import, which a config file cannot hold, so it is wired in code.
    # See docs -> Observe -> Logging -> Platform integrations.
    sinks {
      console {
        enabled   = false
        min-level = "info"     # debug | info | warn | error | off
        format    = "text"     # text = human-readable, json = one NDJSON object per record
        stream    = "auto"     # auto | stdout | stderr; auto = console.* for text, stdout for json
      }

      file {
        enabled   = false
        min-level = "info"
        format    = "text"
        directory = "logs"     # created if missing
        prefix    = "log"      # file name is <prefix>-<yyyy-MM-dd>-<HH-mm-ss>.<extension>
        extension = "txt"
        # Rolling over always opens a NEW stamped file — the active file is
        # never renamed, which Windows forbids while it is open anyway.
        max-file-bytes  = 64M      # roll when the file would pass this; 0 = never
        rotate-interval = "daily"  # off | hourly | daily — roll on the clock boundary
        # Retention only ever deletes files matching this sink's own prefix,
        # extension and timestamp shape — never anything else in the directory.
        max-files        = 14      # keep this many rotated files; 0 = keep all
        max-age          = 14d     # delete rotated files older than this; 0 = keep all
        compress-rotated = false   # gzip each rotated file to <name>.gz

        delivery {
          max-batch-size = 500
          flush-interval = 1s
          queue-capacity = 10000
          overflow       = "drop-new"   # drop-new | drop-head
        }
      }

      # Graylog.  Native rather than via OTLP because Graylog's
      # OpenTelemetry input speaks gRPC only, which the otlp sink does not.
      gelf {
        enabled   = false
        min-level = "info"
        protocol  = "udp"          # udp | tcp | http
        host      = "127.0.0.1"    # udp/tcp
        port      = 12201          # udp/tcp
        url       = ""             # http only, e.g. "http://graylog:12201/gelf"
        # The GELF "host" field.  Empty = the OS hostname, else the system name.
        host-name = ""
        compression     = "gzip"   # udp only: none | gzip (server auto-detects)
        max-chunk-bytes = 1420B    # udp only: datagram size before chunking
        request-timeout = 10s      # http only
        # TLS for tcp is code-only: those fields carry the key material
        # itself, not a path to it.
        delivery {
          max-batch-size = 100
          flush-interval = 2s
          queue-capacity = 10000
        }
      }

      # OpenTelemetry logs over HTTP with a JSON body.  One endpoint format
      # reaches Loki 3+, Parseable, SigNoz, Datadog, Axiom, Honeycomb, New
      # Relic and every OTel Collector — start here before a native sink.
      otlp {
        enabled   = false
        min-level = "info"
        url       = "http://localhost:4318/v1/logs"
        # service.name on the OTLP resource; defaults to the system name.
        service-name = ""
        scope-name   = "actor-ts"
        gzip         = false
        request-timeout = 10s
        # Request headers (API keys, tenant ids) are code-only: a config
        # file is the wrong home for a credential.
        delivery {
          max-batch-size = 100
          flush-interval = 2s
          queue-capacity = 10000
        }
      }

      # Grafana Loki's native push API.  Loki 3+ also accepts OTLP at
      # /otlp/v1/logs, so the otlp sink reaches it too; this one exists for
      # direct push and explicit control over the label set.
      loki {
        enabled   = false
        min-level = "info"
        url       = ""             # base URL, e.g. "http://loki:3100"
        tenant-id = ""             # X-Scope-OrgID, for multi-tenant Loki
        format    = "text"         # text | json — how each log line is rendered
        # Labels are Loki's INDEX.  Keep them static and few: every distinct
        # combination is a separate stream, and a per-record value here
        # (an actor path, a request id) multiplies streams without bound.
        # Everything variable rides as structured metadata instead.
        labels {
          service = ""             # empty = the actor system's name
        }
        structured-metadata = true
        request-timeout = 10s
        delivery {
          max-batch-size = 100
          flush-interval = 2s
          queue-capacity = 10000
        }
      }

      # Parseable's REST ingestion.  Its OTLP endpoint works too — this
      # sink sends a flatter record and skips OTLP semantics.
      parseable {
        enabled   = false
        min-level = "info"
        url       = ""             # base URL, e.g. "https://parseable.internal"
        stream    = ""             # target dataset; created on first use
        # Basic auth OR an API key, never both.  Prefer a substitution
        # (\${?PARSEABLE_API_KEY}) over writing a secret in here.
        username  = ""
        password  = ""
        api-key   = ""
        request-timeout = 10s
        delivery {
          max-batch-size = 100
          flush-interval = 2s
          queue-capacity = 10000
        }
      }

      # Seq, over CLEF — newline-delimited JSON with @-prefixed reserved
      # keys.  Close enough to the framework's own NDJSON that there is
      # almost nothing to translate.
      seq {
        enabled   = false
        min-level = "info"
        url       = ""             # base URL, e.g. "http://seq:5341"
        api-key   = ""             # X-Seq-ApiKey; prefer \${?SEQ_API_KEY}
        request-timeout = 10s
        delivery {
          max-batch-size = 100
          flush-interval = 2s
          queue-capacity = 10000
        }
      }

      # Splunk's HTTP Event Collector.
      splunk {
        enabled   = false
        min-level = "info"
        url       = ""             # HEC base URL, e.g. "https://splunk:8088"
        token     = ""             # HEC token; prefer \${?SPLUNK_HEC_TOKEN}
        index     = ""             # empty = the token's default index
        source     = "actor-ts"
        sourcetype = "_json"
        host-name  = ""            # empty = the actor system's name
        request-timeout = 10s
        delivery {
          max-batch-size = 100
          flush-interval = 2s
          queue-capacity = 10000
        }
      }

      # RFC 5424 syslog — the integration that needs no vendor: rsyslog,
      # syslog-ng, journald's forwarder, Papertrail and a long tail of
      # appliances all speak it.
      syslog {
        enabled   = false
        min-level = "info"
        transport = "udp"          # udp | tcp | tls
        host      = "127.0.0.1"
        port      = 514
        facility  = 16             # 0-23; 16 = local0, the range for applications
        app-name  = ""             # empty = the actor system's name
        host-name = ""             # empty = the OS hostname
        # tcp/tls framing.  octet-counting (RFC 6587) is the only one that
        # survives a message containing a newline — a stack trace always does.
        framing   = "octet-counting"   # octet-counting | lf
        # TLS material is code-only: those fields carry the key itself.
        delivery {
          max-batch-size = 100
          flush-interval = 2s
          queue-capacity = 10000
        }
      }
    }
  }

  actor {
    # User messages ONE actor handles per dispatcher turn before it yields.
    # Distinct from dispatcher.throughput below, which bounds how many queued
    # units — each belonging to a different actor — a ThroughputDispatcher
    # drains per tick.  This is the knob that amortises the scheduling round
    # trip, because a cell may only ever have one unit queued at a time.
    # 1 restores the pre-#409 message-at-a-time interleaving; raising it trades
    # fairness for throughput, since nothing else on the event loop runs until
    # the actor yields.  Override per actor with ActorOptions.withThroughput().
    throughput = 16

    # How long ActorRef.ask waits for a reply when the caller names no
    # timeoutMs.  A per-call argument always wins — this is only the answer to
    # "nobody said".
    #
    # Honoured by every ref that can reach its ActorSystem: local refs, the
    # TestProbe, the remote / singleton / shard refs, and EntityRef through its
    # region.  The refs that carry a system NAME and no system — dead letters,
    # Nobody, an unresolved path, the one-shot reply ref an ask synthesises, and
    # two framework-internal handles — keep the built-in 5s.  Every one of them
    # is a ref with no actor behind it, so an ask on one is waiting for a reply
    # that is not coming either way.  Reference -> Configuration has the split.
    #
    # Rejected rather than clamped when it is not a positive finite duration,
    # unlike throughput above: an ask that arms no deadline can never settle
    # (#765), so there is no nearest-sensible value to clamp to.  The system
    # refuses to start instead of throwing at every ask site.
    #
    # Below 4.6s the default scatter-gather router (4.5s) can no longer report
    # before the caller gives up, which is the defect #1088 fixed — the system
    # logs a WARN naming both knobs when that happens.
    ask-timeout = 5s
  }

  mailbox {
    # A bound every actor the application wrote gets without touching its
    # spawn site.
    #
    # Off by default, and "off" is the shipped behaviour rather than a tuned
    # number: since #1148 a mailbox is unbounded unless somebody asks for a
    # ceiling.  So setting a capacity here does not retune an existing bound,
    # it introduces message loss for every application actor at once.  Read
    # docs -> Operate -> Tuning -> Mailbox sizing before turning it on.
    #
    # Who wrote the class decides, not where the actor sits in the tree.
    # Sharded entities and cluster singleton instances are bounded although
    # the framework spawns them under /system, and so is everything an
    # application actor spawns in turn.  The framework's own actors are
    # exempt — shard regions and shards, coordinators, singleton managers,
    # the pub-sub mediator, the reliable-delivery producer, the DevTools
    # hub — because shedding their traffic would break invariants the
    # application never sees.  Framework actors that application code
    # spawns are inside the bound like anything else it spawns: the
    # WebSocket hub and its connections, the broker adapters, the TCP and
    # UDP actors, the gRPC client and server.  A spawn site that names its
    # own mailbox still wins, in both directions: withMailboxCapacity()
    # overrides the capacity, withMailbox() replaces the queue outright.
    default {
      capacity = 0            # 0 = unbounded (no global bound)
      # System-wide policy for ANY bounded mailbox: the global bound above,
      # and every actor that sets withMailboxCapacity() without naming a
      # policy of its own.  drop-head | drop-new | reject.
      overflow = "drop-head"
    }
  }

  dispatcher {
    # hybrid | immediate | microtask | throughput
    #
    # hybrid wakes actors on the microtask queue and spends every 64th unit on
    # a macrotask so timers and I/O still run; immediate is the previous
    # default, one setImmediate per turn — fair, and ~2.4 us a hop that a
    # request/response actor cannot amortise.  microtask is the unbounded form
    # and starves the event loop under a sustained volley; it is kept for
    # measurement, not for production.
    default = "hybrid"
    # Queued units a ThroughputDispatcher drains per tick, ACROSS actors —
    # see actor.throughput above for the per-actor batch.
    throughput = 16
  }

  # Bounded record of the messages the system could not deliver, inspectable
  # and replayable through system.deadLetterQueue.  Undeliverable messages are
  # published on the event stream either way -- this decides whether anything
  # KEEPS them, which by default nothing does.
  dead-letters {
    # One axis, ordered by how much of the letter is kept:
    # off        = publish only, keep nothing (the behaviour before #433)
    # metrics    = count them and keep no payload, for the alert without the
    #              evidence locker (retaining a message is a data-protection
    #              decision; observing a rate is not)
    # memory     = keep in a bounded ring, lost with the process
    # persistent = additionally write to the configured journal, so the queue
    #              is still there after a restart
    store = "off"

    # Letters held before the oldest is evicted.  The queue is a diagnostic
    # ring: an unbounded one turns a delivery outage into an out-of-memory.
    # Ignored by the off and metrics stores, which hold no letters.
    max-entries = 1000

    # Age letters out after this long.  0 disables ageing and leaves
    # max-entries as the only bound.
    retention = 1h

    # How often one letter may be replayed before it is quarantined.  A
    # replayed message that dead-letters again comes back as the SAME entry
    # with a higher count, so a poison message cannot be retried forever.
    max-replays = 3

    # Journal stream the persistent store writes to.  Empty = derive it from
    # the system name, so two systems sharing a journal keep separate queues.
    persistence-id = ""
  }

  # What the framework says about ITSELF, as against what it does.  Dead
  # letters appear both here and in dead-letters above, and the split is by
  # reader: that block decides whether anything KEEPS a letter, this one
  # decides how loudly one is ANNOUNCED.  A knob here never gates capture.
  diagnostics {
    # Dead letters logged in full before logging suspends.  0 turns
    # dead-letter logging off entirely.  Every letter is published on the
    # event stream either way -- this gates the log line and nothing else.
    log-dead-letters = 10

    # Log the burst terminate() produces while it drains mailboxes to dead
    # letters.  Off because an orderly shutdown drains every queued and
    # stashed message that way, so reporting it makes a clean stop read as
    # an incident.  An individual ref.stop() still logs -- the system is
    # not terminating.
    log-dead-letters-during-shutdown = off

    # How long logging stays suspended once the count above is reached.
    # 0 = never suspend, i.e. log every dead letter.
    log-dead-letters-suspend-duration = 5m

    # Write the merged configuration to the log once at startup, one record,
    # every key with the layer it came from -- the answer to "why is this
    # setting not what I wrote".  Off because a few hundred lines nobody
    # asked for is a behaviour change, and because the dump prints the tree.
    # Two rules keep credentials out of it, and both are heuristics.  A key
    # is withheld when its name, or the name of a branch above it, reads as
    # password, passphrase, secret, token, key, credential or auth: api-key
    # is, key-prefix and passivation are not.  And the user:password part of
    # a URL is masked whatever its key is called.  A bare password under a
    # key that does not name one, a credential in a query string, a
    # "Server=...;Password=..." connection string and a scheme-less
    # user:password@host server list still print.  Read the level note under
    # debug below -- this one is info, so it needs no second switch.
    log-config-on-start = off

    # Traces the framework emits at DEBUG.  Two switches, not one: the key
    # here says WHETHER a record is produced, and logger.level = debug says
    # whether it is written.  Each is off because it is a record per event on
    # a path the application drives -- per declined message, per actor
    # transition, per subscription -- so the cost belongs to whoever asks.
    debug {
      # Every message an actor was handed and declined.  The count and the
      # dead letter are unconditional; this names the message.
      unhandled = off

      # Actor start, stop and restart.  ActorStarted / ActorStopped /
      # ActorRestarted carry the same facts to an event-stream subscriber
      # that can be selective, which a log level cannot.
      lifecycle = off

      # Event-stream subscribe and unsubscribe.  Never publish: that runs on
      # every actor start, every stop and every dead letter.
      event-stream = off
    }

    # What a local tell is held to before it is delivered, so a message that
    # would not survive a boundary it has not met yet is reported while a
    # sender is still on the stack.  A worker hop structured-clones a message
    # -- a class instance arrives as a plain object, silently -- and a cluster
    # wire runs it through a serializer.  Each check is off | warn | fail:
    # warn logs once per message type, fail throws out of the tell.  Off in
    # production; TestKit sets structured-clone = fail.
    message-boundary {
      structured-clone = off
      serializer-round-trip = off
    }
  }

  cluster {
    gossip-interval = 1s
    seed-retry-interval = 3s
    weakly-up-after = 0s   # 0 disables auto weakly-up promotion

    # How often this node publishes a snapshot of its own membership view --
    # member count, up count, unreachable count, leader, self address -- as a
    # ClusterStatsPublished event on system.eventStream.  0 arms no timer,
    # which is what every release before this key did.
    #
    # Node-local, deliberately: on the cluster-wide bus a per-node periodic
    # sample would be N frames per node per interval.  Every figure is already
    # reachable through the Cluster API; what this buys is the cadence, so a
    # dashboard subscriber does not write a polling loop of its own.
    publish-stats-interval = 0s

    # Caps on the local member map.  max-frame-bytes bounds ONE gossip frame;
    # these bound what a sequence of well-formed frames can accumulate, since
    # gossip is what introduces addresses in the first place.  0 disables
    # either.  max-tombstones is the load-bearing one: a tombstone carries no
    # liveness, so nothing but the TTL below ever reclaims it.
    max-members = 1000
    max-tombstones = 10000

    # Members that must be present before ANYTHING moves to "up" -- the
    # leader's promotions and a founder's own self-election alike.  1 is what
    # every release before this key did: the first node forms a cluster of one
    # the moment it starts.
    #
    # Not bootstrap.minimum-members below, which is a *wait* predicate for
    # awaitReady/isReady -- it counts "up" members and never changes a status.
    # This one decides whether a status changes at all, which is why the name
    # carries -before-up.  Setting this largely subsumes that one: a node that
    # is "up" at all already implies the threshold was met.
    #
    # Counted over members in "joining", "weakly-up" and "up".  A "leaving"
    # member does not hold the gate open for its replacement, so a rolling
    # restart closes it for exactly as long as the replacement takes to
    # appear.  Never re-evaluated downwards: there is no up -> joining
    # transition, so a cluster that shrinks keeps the members it promoted and
    # holds only new ones.
    #
    # NOT a quorum and NOT a security control -- any node may announce itself
    # "up", so this bounds accidents, not adversaries.  Arbitration is
    # split-brain-resolver below.
    minimum-members-before-up = 1

    # Peers this node announces itself to at start-up, "system@host:port" (or
    # "host:port", which takes this system's own name).  Empty is the
    # documented "I am the first node": under the default 'immediate'
    # self-election policy, a node whose seed list is empty forms a cluster of
    # one and everybody else joins it.
    #
    # ONE list is correct on every node of a deployment, which is why this is
    # a key and not only a join-site argument: a node removes its OWN address
    # before dialling, so naming the designated first node here and shipping
    # the same file everywhere leaves that node with an empty list -- and
    # self-electing -- while every other node dials it.
    #
    # The shape that does NOT work is the symmetric one, every node listed:
    # self-exclusion then leaves nobody with an empty list, so nobody may
    # self-elect and nobody is ever promoted.  Config does not create that
    # trap and the node diagnoses it, but it does make it a one-line mistake.
    # Cluster.bootstrap with stable observation is the way out when the
    # members are not known in advance; the cluster.bootstrap block below
    # configures its discovery, and stable observation is switched on in code.
    #
    # A single substitution does NOT work: seed-nodes = \${?SEED_NODES} lands a
    # string where a list is read, and the node refuses to start.  Write one
    # optional substitution per entry -- unset ones drop out of the array:
    #
    #   seed-nodes = [ \${?SEED_1}, \${?SEED_2} ]
    #
    # For the single comma-separated variable, use seedsFromEnv(...) in code.
    #
    # discovery.config.seeds below is the other home for a static list, and
    # the order between the two is fixed: under Cluster.bootstrap, what
    # discovery returns -- that list, or CLUSTER_SEEDS -- is forwarded and
    # wins; this key applies when discovery named nobody or only this node.
    seed-nodes = []

    # Role tags this node carries.  Shard regions, cluster singletons, the
    # per-role thresholds above and the role-filtered downing strategies are
    # all placed BY role, so this key decides what this node is a candidate
    # for.  Empty = no roles, and every role filter reads that as "not a
    # candidate"; an unfiltered feature is unaffected either way.
    #
    # Unlike the seed list this one is usually per-node, so the substitution
    # form is the common one:
    #
    #   roles = [ \${?NODE_ROLE} ]
    roles = []

    # The application version this node states to its peers: a label for
    # operators, shown beside the member by /cluster/members and in every log
    # line that prints one, so the mixed window of a rolling update can be read
    # off the cluster itself.  Advisory and nothing else -- nothing places,
    # routes or downs on it.
    #
    # Ships no value on purpose, the remote.tcp.advertised-host shape: unset
    # states no version and puts nothing on the wire.  At most 64 visible ASCII
    # characters, no whitespace and no control character, because every peer
    # prints it; a peer's label that breaks the rule is dropped, never the
    # member.  It changes per release rather than per node, so the
    # substitution form is the common one -- an unset variable drops the key,
    # one set to nothing is refused at startup:
    #
    #   app-version = \${?APP_VERSION}

    # Per-role thresholds compose with the one above as an AND: the global
    # count and every configured role's count must be met.  Counted over the
    # same three statuses, filtered by role; a role absent from the block is
    # unconstrained rather than bounded at zero.  What it buys is "do not
    # place work on a cluster that has no backend yet" -- shard regions and
    # singletons are hosted by role, so an all-frontend cluster can satisfy a
    # global count while being useless to place on.
    #
    # Comment-only, because the role names belong to the deployment and no
    # leaf here could name one:
    #
    #   role.backend.minimum-members-before-up  = 2
    #   role.frontend.minimum-members-before-up = 1

    # Settings that have to agree across the cluster.  Each node publishes the
    # EFFECTIVE value of every listed setting on the gossip overlay and compares
    # what its peers publish back -- effective, not configured, because the
    # documented way to set most of these is a builder, which sits above the
    # config layer.  Absence on either side is silence, so a mixed-version or
    # partially-configured cluster says nothing rather than something wrong.
    configuration-compatibility-check {
      # off = report the divergence and change nothing else (the default).
      # on  = additionally bar the diverging peer from this node's placement
      # candidates.  It never downs or quarantines anyone: a misconfigured
      # MAJORITY would then evict the correctly-configured minority, which
      # turns a warning into an outage, and it is never an election input --
      # candidacy is a per-node view, and an elected role computed from an
      # asymmetric set has two winners.
      enforce = off

      # What is published and compared, named by the HOCON path whose effective
      # value each carries.  This is an allow-list of what LEAVES the node, so a
      # path absent here is never gossiped in the first place.
      #
      # Seeded with the wire cap because it is the divergence nothing detects:
      # there is no protocol negotiation yet (#823), so a frame over a peer's
      # lower cap kills the whole association and the sender never learns why.
      # sharding.number-of-shards is deliberately NOT here -- the coordinator
      # already refuses a region whose count disagrees, on the effective value.
      #
      # Two more are published and can be added, though each divergence is
      # either legitimate or self-healing:
      #   actor-ts.cluster.failure-detector.heartbeat-interval
      #   actor-ts.cluster.tombstone.time-to-live
      checked-paths = ["actor-ts.remote.max-frame-bytes"]
    }

    tombstone {
      time-to-live   = 24h
      prune-interval = 5m
      min-retention  = 0s   # 0 = derive from failure-detector down-after
    }

    # Which split-brain resolver arbitrates a partition.  off = none, and a
    # peer the failure detector declares down is then parked at unreachable
    # until an operator removes it -- or, with failure-detector.auto-down = on,
    # removed by the detector itself, which every side of a partition does at
    # the same moment, so the cluster forks instead of losing a side.  Naming
    # a strategy here builds the provider withDowning(...) takes in code, and
    # an explicit withDowning(...) still wins over this block.
    #
    # lease-majority arbitrates through a lease built from
    # coordination.lease below, so it needs a backend there -- with
    # backend = none the strategy is refused at startup.  The lease is named
    # after the system and owned by this node; neither has a key, and there is
    # no lease-majority block here.  Its role and acquire timeout stay code:
    # withDowning(new LeaseMajority(...)).
    split-brain-resolver {
      active-strategy = off   # off | keep-majority | keep-oldest | keep-referee | static-quorum | lease-majority

      # How long the membership AND reachability view must be unchanged before
      # the strategy above is consulted at all.  Every bundled strategy is a
      # pure function of one view, so a view captured mid-churn is a decision
      # made on evidence that was never true at any instant.  The clock is the
      # failure-detection tick, so the resolution is heartbeat-interval.
      #
      # No upper bound against failure-detector.down-after: with a strategy
      # configured the detector parks an unreachable peer and evicts nothing,
      # so the window has no deadline to out-run.  Ignored entirely when
      # active-strategy = off -- there is no decision to delay then: the
      # detector parks the peer, or removes it at down-after when
      # failure-detector.auto-down = on.
      stable-after = 20s

      # Down EVERY member, self included, when the view never once holds still
      # for stable-after across a run of changes lasting 3x stable-after --
      # and only while something is still unreachable, since a view that moves
      # because members join and leave cleanly is churn, not a partition.
      #
      # Off, because it is the one action here that stops the whole cluster and
      # it is reached by a timer rather than by a strategy's verdict: a rolling
      # restart whose replacements arrive less than stable-after apart looks
      # exactly like a cluster that will not settle.  On is a deployment saying
      # it would rather be down than be uncertain.
      down-all-when-unstable = off

      # "" = every member counts.  A role narrows the candidate set a strategy
      # arbitrates over; it never grants one.
      keep-majority.role = ""
      keep-oldest.role   = ""
      static-quorum.role = ""

      # Three keys ship comment-only, because "not configured" has no legal
      # spelling: quorum-size = 0 is refused by StaticQuorum's own validator
      # and referee-address = "" by KeepReferee's, so a shipped leaf could
      # only be a value that stops the node from starting.  Set one and the
      # matching strategy becomes selectable.
      #
      #   static-quorum.quorum-size             = 3
      #   keep-referee.referee-address          = "sys@10.0.0.1:2551"
      #   keep-referee.down-all-if-below-quorum = 2
    }

    failure-detector {
      # Which detection algorithm this node runs.  simple = plain elapsed-time
      # thresholds; phi = the variance-aware phi-accrual detector, which adapts
      # to the network it actually sees.  Opt-in: simple is what every cluster
      # ran before the choice existed.
      implementation = simple

      # Shared by BOTH implementations -- it is the cadence of the cluster's
      # heartbeat loop, not a property of the algorithm, so swapping the one
      # above must not change how often this node talks to its peers.  The phi
      # block below deliberately has no copy of it.
      heartbeat-interval = 500ms

      # What a down verdict does when no split-brain strategy is configured
      # (split-brain-resolver.active-strategy = off).  Governs BOTH
      # implementations -- phi reaches down as well.
      #   off -- the peer is parked at unreachable and stays a member until a
      #          strategy, Cluster.down or POST /cluster/down removes it.
      #   on  -- the detector removes the peer itself.  It cannot tell a
      #          crash from a partition, and under a partition every side
      #          removes the other at the same moment, so the cluster forks
      #          instead of losing a side.
      # Refused at startup beside a configured strategy, which decides every
      # removal and would leave this switch inert.
      auto-down = off

      # The simple detector's thresholds.  Ignored when implementation = phi.
      unreachable-after = 2s
      down-after = 5s     # measured from the last heartbeat, so > unreachable-after

      # The phi-accrual detector's tuning.  Ignored when implementation =
      # simple.  The two thresholds are phi values -- a continuous suspicion
      # score, not a duration -- and fractional ones are ordinary.
      phi {
        unreachable-threshold = 8
        down-threshold = 12          # must exceed unreachable-threshold
        max-sample-size = 200        # inter-arrival times kept per peer
        min-std-deviation = 100ms    # floor, so a very steady peer is not flagged on noise
        acceptable-heartbeat-pause = 3s   # grace added to the last heartbeat before phi rises
        # The mean phi assumes before a peer's first heartbeat, with a deviation
        # of a quarter of it.  auto = heartbeat-interval above, so a tuned
        # cadence carries it along; a duration decouples the two.
        expected-response-after = "auto"
      }
    }

    # What Cluster.bootstrap reads.  The first five keys tune the
    # stable-observation phase: poll discovery until the contact-point set has
    # been unchanged for stable-margin, then let the lowest-addressed node --
    # and only it -- form a cluster if no peer promoted it within
    # self-election-grace.  Those five are read only when the bootstrap's
    # stableObservation option is set, and that switch stays in code; every
    # other key here is read by every bootstrapCluster call.
    # required-contact-points is the one timing worth changing: 1 keeps
    # single-node development working, but only a value matching the expected
    # replica count catches discovery that is stably wrong rather than merely
    # slow.
    bootstrap {
      stable-margin           = 5s
      poll-interval           = 1s
      max-wait                = 60s
      required-contact-points = 1
      self-election-grace     = 10s

      # May this node FOUND a cluster when it finds nobody to join?  on is
      # right for one start only: a deployment's first, where somebody has to.
      # On every start after it the same answer is the split brain -- a node
      # cut off from its peers by a partition, a discovery outage or a DNS
      # answer that lags pod readiness comes up as the founder of a second
      # cluster beside the running one.  Set it off once the cluster exists:
      # no bootstrapped node then self-elects, on either bootstrap path, and
      # an explicit seeds: [] -- "I am the first node" -- is refused.  A node
      # that finds nobody fails its readiness wait instead of starting alone.
      # Shipped on so a first start and single-node development need nothing,
      # and every start warns once while it is on: the first-deploy setting
      # left on in production is the case this key exists for.
      new-cluster-enabled = on

      # WHICH provider the bootstrap polls, and WHAT it polls for.  Both keys
      # are read by every bootstrapCluster call, not only the stable-observation
      # one, and both are layered under the discovery: option in code.
      #
      # method names the provider: auto | config | dns | kubernetes -- the
      # vocabulary the option already accepts, auto included because it is
      # the shipped default and a config that could not express the current
      # behaviour would be a trap.  auto is the ladder (a static seed list,
      # then the Kubernetes API inside a pod, then DNS); the other three pin
      # one rung, so a misconfigured deployment fails loudly instead of
      # falling through to a provider that answers with nothing.
      #
      # service-name is the DNS name the dns rung resolves and the Service
      # whose Endpoints the kubernetes rung reads -- one key because one
      # deployment names one service.  "" means "not stated here", and the
      # CLUSTER_SERVICE_NAME environment variable then answers, which is the
      # layer BELOW this block rather than above it.  A deployment that wants
      # the variable at config precedence lifts it itself, which is a read
      # during parsing and not a fourth precedence layer:
      #
      #   service-name = \${?CLUSTER_SERVICE_NAME}
      discovery {
        method       = "auto"
        service-name = ""
      }

      # Fewest up members -- self included -- before bootstrapCluster's
      # awaitReady (and Cluster.awaitReady / isReady) counts the cluster as
      # ready.  1 keeps single-node development working; a deployment states
      # its replica count here, for the same reason as
      # required-contact-points.
      minimum-members         = 1

      # await-ready ships no value on purpose -- a key that is always present
      # could not express "unset", and unset is what selects the computed
      # default: self-election-grace + 5s behind stable observation, 5s
      # otherwise (#1086).  Set a duration to pin the budget regardless:
      #
      #   await-ready = 30s
    }

    # This node's defaults for every cluster singleton it starts, and for
    # every proxy it takes with cluster.singleton.ref().  Explicit
    # StartSingletonOptions still win per field, and so does a role declared
    # on the actor class's SingletonKey -- both are code, and code is the
    # layer above this one.  The block is per NODE, so a deployment running
    # two singletons that want different values overrides one in code.
    singleton {
      # "" = any node may host.  Not a value anyone runs with: it is the
      # published shape of the key, and the reader DROPS the empty string
      # rather than passing it on -- role = "" would fail
      # StartSingletonOptionsValidator's non-empty check on every node that
      # merely copied this file.  Set here rather than per singleton because
      # "singletons live on the backend nodes" is uniform across a deployment.
      role = ""

      # Messages a proxy holds while the cluster has no host for the
      # singleton, before it drops the newest to dead letters.  The wait is
      # normally one gossip round, and nothing bounds it: unreachable seeds,
      # or a partition in which this node sees nobody, last as long as the
      # outage while the application keeps sending.
      #
      # The one key a ref()-only node could not otherwise reach -- it passes
      # no options object at all, so this file is its only channel (#855).
      buffer-size = 1000

      # How long an incoming host waits for every eligible peer to confirm it
      # is not running the singleton, before hosting anyway.  A healthy
      # hand-over costs one round trip and never reaches this; reaching it
      # means a peer did not answer, and the manager spawns anyway and says
      # so at warn -- availability over an invariant it could not prove
      # (#949).
      hand-over-timeout = 10s

      # Give every singleton this node starts a lease built from
      # coordination.lease, so only the node holding it hosts -- the one
      # thing that still arbitrates when the incumbent cannot be reached.
      # Needs coordination.lease.backend: with backend = none, on is refused
      # when the singleton starts rather than hosting unprotected.  A lease
      # passed with withLease(...) wins, and withUseLease(false) opts one
      # singleton out.  The lease is named <system>-singleton-<type> and
      # owned by this node; there is no lease-name key.
      use-lease = off

      # How long the manager waits before re-acquiring a lease it failed to
      # take, however the lease arrived.  Worth setting: until an acquire
      # succeeds no node hosts the singleton and every proxy is buffering.
      acquire-retry-interval = 5s

      # Largest warm-hand-over snapshot this node puts on the wire, in bytes.
      # Only consulted when the singleton actor implements WarmHandOverActor:
      # a snapshot over the cap is not sent and the successor starts cold,
      # which is what every singleton did before the feature existed.  Raise
      # it against the TRANSPORT's frame cap (remote.max-frame-bytes), not
      # against this number -- a snapshot is base64 in a JSON frame, so it
      # costs about a third more on the wire.
      max-hand-over-state-bytes = 1M

      # Re-spawn the singleton after its instance dies UNEXPECTEDLY --
      # stopSelf(), or a supervision budget exhausted -- as against the
      # planned teardown of a hand-over.  Turn it off only where stopSelf()
      # is a terminal state; the manager then releases its lease instead of
      # holding one over a dead child (#1175).  The honest scope of this one
      # is per singleton rather than per node, so a deployment mixing both
      # styles sets it with withRestartOnTermination.
      restart-on-termination = on
    }

    # The outside-in ClusterClient and the cluster-side endpoint it dials.
    # Nested under cluster.client and NOT merged into cluster.receptionist
    # below: that block belongs to the discovery Receptionist, a different
    # actor with a different protocol that happens to share the word.
    #
    # A ClusterClient is standalone -- it holds no ActorSystem, so unlike every
    # other block here there is no system.config to read it from.  It is loaded
    # with the same chain ActorSystem.create uses (ACTOR_TS_CONFIG, then
    # ./application.conf, then these defaults), which is what makes a client
    # built with no options at all a configurable thing rather than a broken
    # one.  The receptionist half below is asymmetric on purpose: it runs
    # inside a system, so it reads that system's config and loads nothing.
    #
    # Three options stay code-only and have no leaf here.  client-identity is
    # a security decision, not a packaging one -- the per-client half of the
    # wire address is drawn from the CSPRNG so two clients cannot collide or
    # pre-claim each other's slot, and one value shared by a fleet is exactly
    # what that defeats.  tls carries certificate material, and logger is a
    # Logger instance; neither has a HOCON spelling.
    client {
      # Cluster nodes an otherwise-unconfigured client dials, each "host:port"
      # or "<system>@host:port", tried in order and re-tried round-robin on a
      # dial failure.  Ships no value on purpose, the remote.tcp.advertised-host
      # shape: the list is per-deployment identity no default could state, and
      # an empty list is not the absence of one -- it is refused by the
      # validator, so a shipped leaf could only be a value that stops every
      # client that merely copied this file.
      #
      #   contact-points = ["orders@10.0.0.1:2552", "orders@10.0.0.2:2552"]

      # Synthetic system name the client puts in its hello.  It names the
      # client's side of the handshake and nothing else -- it is not an
      # identity and not an authorisation, and the cluster it dials need not
      # be called this.
      system-name = "cluster-client"

      # Deadline for ask(path, message) when the call itself names none.  A
      # per-call timeoutMs still wins, as it does for ActorRef.ask.
      ask-timeout = 5s

      # How long ONE contact point gets to answer the hello handshake before
      # the client gives up on it and moves to the next.  This bounds the same
      # handshake remote.handshake-timeout bounds from the accepting side, and
      # shares its 5s for the reason stated there -- the dialling side's clock
      # starts first, so it is always the one that gives up first.
      connect-timeout = 5s

      # Cluster-side endpoint, started per node with
      # system.extension(ClusterClientReceptionistId).start(cluster).
      receptionist {
        # Deadline for the ask this node makes on the client's behalf when an
        # arriving envelope carries an askId.  Deliberately independent of the
        # client's own ask-timeout above: they are two hops of one round trip,
        # set on two different machines, and the client's is the one the caller
        # actually waits out.
        ask-timeout = 5s
      }
    }

    # Cluster-wide publish/subscribe (DistributedPubSub).  The caps bound what
    # one mediator can be made to hold -- by local subscribers and by a peer's
    # gossiped topic claims alike.  A Subscribe over a cap is answered with
    # SubscribeRejected, never silently dropped.
    pub-sub {
      gossip-interval = 1s
      max-subscribers-per-topic = 10000
      max-topics = 10000
      max-remote-nodes-per-topic = 1000
      # A publish that reached no subscriber goes to system.deadLetters, so a
      # mistyped topic is observable instead of silent.  off = discard it.
      send-to-dead-letters-when-no-subscribers = on
    }

    # Cluster-wide service registry (Receptionist).  Subscribers are watched,
    # so a stopped one is dropped; the caps bound the ones that are still alive.
    # The total counts key/subscriber pairs, not distinct subscribers — one
    # subscriber on three keys spends three of it.
    receptionist {
      gossip-interval = 1s
      max-subscribers-per-key = 1000
      max-subscriptions-total = 10000
    }
  }

  # Cluster-wide replicated CRDT store (DistributedData).  Top-level rather
  # than under cluster.* because the module is -- the cluster is a positional
  # argument to start(), not a tunable.  Both caps bound quorum requests
  # (updateAsync + getAsync); 0 disables either.  What they buy is a bound on
  # the unsettled set itself: every entry holds a promise, a timer and a
  # target set until its deadline passes, so refusing past the cap turns what
  # would be a timeout storm into immediate, attributable rejections.
  #
  # max-gossip-bytes bounds one outbound gossip frame instead; a larger store
  # is pushed a slice per tick.  It is clamped down to remote.max-frame-bytes,
  # because a frame past that cap is rejected on its length prefix and costs
  # the whole peer association -- heartbeats included.  0 removes the budget
  # (the clamp still applies).
  distributed-data {
    gossip-interval = 1s

    # Deadline for an updateAsync / getAsync whose call names no timeoutMs; a
    # per-call timeoutMs still wins, and max-quorum-timeout below clamps this
    # exactly as it clamps that.  Its own key rather than actor.ask-timeout,
    # which moves ActorRef.ask -- a different wait from how long this replica
    # holds a pending slot for its peers to answer.  Positive: 0 would arm no
    # timer, and a request waiting on a silent replica would never settle.
    quorum-timeout = 5s

    max-pending-quorum-requests = 1000
    max-quorum-timeout = 30s
    max-gossip-bytes = 1M

    # Name a key whose own encoding passes this, and keep gossiping it -- this
    # warns, it never skips.  Roughly a tenth of the budget above (100 KiB
    # against 1 MiB), because that is where one value starts governing
    # everyone else's convergence: ten such keys fill a whole tick, so every
    # other key waits an extra sweep per offender.  Its own quiet period,
    # deliberately not shared with the oversize warning above -- "split this
    # value" and "raise the budget" are different actions and neither may
    # silence the other.  0 = never warn.
    log-data-size-exceeding = 100K

    # Which keys a configured durableStore actually persists.  EMPTY MEANS
    # EVERY KEY -- what every release so far has done -- and never "persist
    # nothing"; persisting nothing is what configuring no store does.  An
    # entry is an exact key name or a prefix with one trailing "*"
    # (session-*); that is the whole syntax, because a richer pattern means
    # building a matcher out of this file and a regex from config is a ReDoS
    # surface.  Note that a replica's record is rewritten whole on every save,
    # so REMOVING an entry drops the keys it named from the persisted record
    # on the next mutation.  Inert, with a startup warning, when no store is
    # configured.
    durable-keys = []
  }

  remote {
    # This node's address, all four leaves under tcp: host and port are the
    # pair it BINDS, advertised-host and advertised-port the identity peers
    # DIAL.  Cluster.join and Cluster.bootstrap both read them under their
    # options, so a deployment can move the address into config, and every
    # one of them ships comment-only.  On the bootstrap path the environment
    # sits beneath this block -- CLUSTER_HOST / POD_IP / HOSTNAME under host,
    # CLUSTER_PORT under port -- so the order is the usual one with the
    # environment appended at the bottom: explicit options > this block > the
    # variables > the built-in pair, which lives in code.  A published leaf
    # would be the config layer on every node and the variables would never
    # answer.  With nothing set anywhere, the built-in pair is what binds:
    #
    #   tcp {
    #     host = "0.0.0.0"
    #     port = 2552
    #   }
    #
    # host is the interface to BIND, and the wildcard is the right default
    # for it.  It is not an identity: what peers dial is
    # advertised-host, which falls back to host only when host is not a
    # wildcard, then to CLUSTER_HOST / POD_IP / HOSTNAME, then to 127.0.0.1.
    # advertised-host ships no value on purpose -- a key that is always
    # present could not express "unset", and unset is what makes that
    # fallback chain reachable.  Set it wherever the bound interface and the
    # dialable address differ, which in Kubernetes is every pod:
    #
    #   advertised-host = \${?POD_IP}
    #
    # Leaving it at the wildcard in a multi-node deployment is the failure it
    # exists to prevent: every node advertises the identical
    # system@0.0.0.0:2552, each reads the others' announcements as claims
    # about itself, and every member map ends up holding one entry.
    #
    # port and advertised-port are the same split one axis over, and
    # advertised-port ships no value for the same reason: unset means "the
    # same as port".  Only a deployment that REMAPS the port needs it -- a
    # published container port, where the process listens on 2552 inside and
    # the outside world reaches it on the port that -p 3000:2552 published:
    #
    #   port            = 2552
    #   advertised-port = 3000
    #
    # Kubernetes does not need it: pod-to-pod gossip dials the container port
    # directly, so only the host half moves there.
    tls {
      # Read but NOT honoured: the transport the cluster builds for itself is
      # always plaintext.  Setting this to true only buys a startup WARN that
      # says so — encrypting the wire is issue #941.
      enabled = false
    }
    max-frame-bytes = 16M   # per-frame wire cap; lower it on semi-trusted networks

    # Who a peer may address BY NAME.  An inbound envelope carries a target
    # path the sender chose, and this node resolves it against its own actor
    # tree -- the one thing on the wire a remote party picks freely.
    #
    # Off, that reaches any /user actor by name, which is what makes an
    # ActorRef usable across nodes.  On, only the paths listed below.  Turn it
    # on where the cluster network crosses a boundary you do not control, the
    # same networks max-frame-bytes above is worth lowering on.
    #
    # /system is NOT what this switches.  Framework actors -- shard
    # coordinators and regions, singleton managers, the pub-sub mediator, the
    # DevTools lanes -- are reachable only through the handlers their owners
    # register, in both modes.  That door attaches the connection's identity to
    # the frame; resolving the path by name never did.
    untrusted-mode = false

    # Paths a peer may address by name while untrusted-mode is on.  Empty
    # means: nothing beyond the registered framework endpoints above.
    #
    # An entry is one exact path, unless it ends in /* -- then it is that path
    # and everything below it.  The suffix is segment-anchored, so
    # "/user/orders/*" admits /user/orders/7 and refuses /user/orders-archive.
    # Nothing else here is a pattern:
    #
    #   trusted-selection-paths = ["/user/orders/*", "/user/reporting/intake"]
    trusted-selection-paths = []

    # The association lifecycle: what an unauthenticated party that can open a
    # TCP connection to this port is able to make this node hold.  All four
    # have been enforced since the transport was hardened; only now are they
    # settable.  Keep them positive -- none of them has an "off" reading, and
    # 0 is a distinct way of breaking the node for each.
    #
    # handshake-timeout bounds a connection that never speaks its half of the
    # handshake, in BOTH directions, and it is one key on purpose.  The
    # dialling side's clock starts before the TCP connect and the TLS
    # handshake, the accepting side's after the accept -- so with one number
    # the peer that is still trying has always given up first, and the
    # acceptor can never be the deadline that punishes a slow-but-legitimate
    # dial.  A split dial/accept pair would let an accept deadline set below
    # the dial deadline make a healthy peer permanently unjoinable.
    handshake-timeout = 5s

    # How many frames are held for a peer that cannot take them right now,
    # oldest dropped first -- the newest membership and heartbeat state is the
    # state worth keeping.  Today that is the buffer in front of the
    # handshake, so a send racing the handshake is held rather than lost; the
    # key is named for the category rather than that one buffer, because the
    # post-handshake backpressure queue is the same quantity with the same
    # policy and the same warning and will land under this key rather than a
    # second one.
    outbound-queue-size = 1000

    # How many inbound connections this node accepts before it refuses sockets
    # outright, newest refused rather than oldest evicted -- eviction would let
    # an attacker push established peers off the node.  Together with
    # incomplete-frame-idle below it is what bounds inbound decode memory at
    # all, and this is the half worth tightening: set it from the real peer
    # count where that is known, with headroom for the ClusterClients that dial
    # in.  Refusing a legitimate peer is a partition.
    max-inbound-connections = 1024

    # How long a connection may hold a half-received frame with no further byte
    # arriving.  A STALL bound, not a budget for the frame: it is re-armed on
    # every chunk, so a peer shipping a large frame over a slow link is never
    # punished for being slow -- only for going silent.  Keep it above
    # handshake-timeout; a socket that sends nothing at all never reaches this
    # deadline, and the handshake timer is what covers that one.
    incomplete-frame-idle = 30s
  }

  # Seed discovery -- what the providers behind Cluster.bootstrap's
  # discovery: option read when a deployment owns their settings rather than
  # the application source.  Top-level rather than under cluster.* for the
  # reason distributed-data is: the module is.  src/discovery/ has its own
  # subpath export, a SeedProvider is BUILT and then handed to the cluster, and
  # the same providers serve a hand-wired Cluster.join that never bootstraps.
  #
  # WHICH provider runs is not here -- that is
  # cluster.bootstrap.discovery.method, because it is a property of the join,
  # not of a provider.  This block is per-provider settings only, so a
  # deployment can pin the DNS answer without also deciding the ladder.
  #
  # Precedence is the project's usual one, with the environment BELOW this
  # block rather than above it: explicit options > this block > the CLUSTER_*
  # variables > the built-in defaults.  The variables kept the bottom slot so
  # an env-only deployment keeps working byte for byte; a deployment that wants
  # one of them at config precedence lifts it with a substitution --
  # namespace = \${?CLUSTER_NAMESPACE} -- which the parser resolves while
  # reading the file, so it is still three layers and not four.
  #
  # That ordering is what decides which of these keys may ship a value at all.
  # Every leaf here is READ by whether it is present, so a published default
  # occupies the config layer on a node that configured nothing -- harmless
  # where nothing sits underneath (cache-ttl, use-srv,
  # kubernetes.request-timeout), and the whole of the bug where something
  # does.  The keys with a CLUSTER_* variable beneath them therefore ship as
  # comments: namespace and config.seeds below, and
  # cluster.bootstrap.discovery.service-name is the same rule solved the other
  # way, published empty and dropped by its reader.
  discovery {
    dns {
      # How long one resolved answer is reused before the resolver is asked
      # again.  In-process and per provider instance on purpose: resolution is
      # a per-process concern, and a shared cache would cost more than the
      # lookup it saves.  Failures are never cached -- a query that threw is
      # retried on the next call.  0 disables caching, which is what a
      # deployment relying on rapid DNS failover wants.
      cache-ttl = 60s

      # Read SRV records instead of A records.  SRV carries a port per target,
      # so each address is paired with the port the record names rather than
      # with this node's own remoting port -- the shape a headless Service with
      # named ports produces.
      use-srv = false

      # pinned-addresses ships no value on purpose: an always-present empty
      # list could not express "no pinning", and no pinning is the default.
      # It is the DNS-hijack mitigation (#145) -- an answer outside the list is
      # discarded instead of being offered to the cluster as a seed, which
      # matters most exactly where mTLS is not configured.
      #
      # The entry shape follows use-srv above, and a list with nothing usable
      # in the configured mode is REFUSED rather than silently discarding every
      # seed: CIDRs match the IPs A records return, host suffixes match the
      # target names SRV records carry.
      #
      #   pinned-addresses = ["10.0.0.0/8"]
    }

    kubernetes {
      # Ceiling on the one HTTPS request the in-cluster fetcher makes to the
      # API server.  A wall-clock deadline on the whole exchange, not a socket
      # timeout: Bun never arms the socket one while a TLS handshake is
      # pending, and a handshake that never completes is the outage this
      # exists for.  Without it a server that accepts the connection and
      # never answers -- a control-plane restart, a NetworkPolicy dropping the
      # reply -- hangs lookup() forever, and the ladder never falls through to
      # its next rung: every layer above handles a provider that throws, none
      # a provider that hangs (#1524).  Same value as the lease client's
      # operation-timeout, deliberately not shared with it -- that one feeds
      # the lease renewal arithmetic, this one bounds a bootstrap poll.
      request-timeout = 10s

      # namespace -- the namespace whose Endpoints object is read.  Ships no
      # value on purpose, the remote.tcp.advertised-host shape: this key has
      # the CLUSTER_NAMESPACE variable underneath it, and a key that is always
      # present cannot express "unset", so a published default would BE the
      # config layer on every node and the variable below it would be
      # unreachable.  Which is what shipped in the first cut of this block and
      # broke every pod outside the default namespace -- it read the wrong
      # Endpoints object, found no seeds and self-elected, the cold-start split
      # brain the bootstrap exists to close.  Unset, the fallback chain is
      # reachable again: CLUSTER_NAMESPACE, then the built-in "default".
      #
      #   namespace = "my-namespace"

      # pinned-addresses -- deliberately unset for the same reason as the DNS
      # one, and CIDRs only: Endpoints resolve to pod IPs, so a host suffix
      # could never match and is refused.  This is not the same guard as the
      # TLS pin the default fetcher already does; it is the layer above one --
      # an Endpoints object may name ANY IP, cluster-external included, and
      # RBAC that can write Endpoints is a much cheaper find than a CA key.
      #
      #   pinned-addresses = ["10.0.0.0/8"]
    }

    # config.seeds -- the static rung of the ladder, and the whole of
    # method = config: a deployment topology rather than a default nobody can
    # publish.  ONE list is correct on every node when it names the designated
    # first node by the host:port that node advertises.  The bootstrap drops
    # this node's own address from what discovery returns, so that node is left
    # with nobody to dial and founds the cluster -- where new-cluster-enabled
    # allows it -- while every other node dials it.  A list naming EVERY node
    # is the symmetric trap cluster.seed-nodes describes: nobody is left
    # alone, nobody self-elects, and it converges only under the bootstrap's
    # stableObservation option, which is code.
    #
    # Comment-only for precedence, as namespace is: CLUSTER_SEEDS sits beneath
    # it, and a published leaf -- even an empty one -- would be the config
    # layer on every node and silence the variable.  [] is neither "unset" nor
    # "we are alone": it drops this rung and turns CLUSTER_SEEDS off while the
    # Kubernetes and DNS rungs still run, and under method = config it is
    # refused.
    #
    # What discovery returns outranks cluster.seed-nodes: the bootstrap
    # forwards a discovered seed, and seed-nodes applies only when discovery
    # named nobody or only this node.  CLUSTER_SEEDS is a rung of this ladder,
    # so a seed it names outranks seed-nodes as well.
    #
    #   config {
    #     seeds = ["node-a:2552"]   # the designated first node, on every node
    #   }
  }

  # Lease coordination -- what a Lease backend reads, whoever builds it.  The
  # framework builds one per consumer that asks -- sharding.use-lease,
  # cluster.singleton.use-lease, split-brain-resolver.active-strategy =
  # lease-majority -- with the backend named here.  A lease built in code
  # reads this block too, UNDER the options passed to new InMemoryLease(...) /
  # new KubernetesLease(...): explicit options win, this block is next, the
  # built-in defaults are last.
  coordination {
    lease {
      # What the framework builds its leases with: none | kubernetes.  none
      # builds nothing, and a switch that asks for a lease is then refused at
      # startup rather than running unprotected.  in-memory is not selectable:
      # its store lives in one process, or one worker thread, so a lease
      # built from it would gate nothing.
      #
      # A built lease is named after its consumer -- <system>-singleton-<type>,
      # <system>-sharding-<type>, <system>-split-brain-resolver, made a valid
      # Kubernetes object name -- and owned by the node that builds it: its
      # cluster address and incarnation.  Both are identity, which one shared
      # file cannot carry, so name and owner have no key and are refused when
      # written.
      backend = none

      # ttl -- deliberately unset.  A lease is constructed with an explicit
      # ttlMs and the constructor rejects a missing one (#596); a shipped value
      # here would supply it for every lease in the process and make that guard
      # unreachable.  Set it to give a whole deployment one TTL:
      #
      #   ttl = 30s
      #
      # renewal-interval -- deliberately unset as well.  Unset selects a third
      # of the TTL with a floor (100ms in-memory, 500ms Kubernetes), capped at
      # half the TTL so a renewal always comes round before the record lapses,
      # and the validator rejects 0, so a "0 means derive it" sentinel is not
      # expressible:
      #
      #   renewal-interval = 10s
      #
      # acquire-retries and acquire-retry-delay are deliberately NOT settable
      # here: the two backends ship different built-in defaults (3 attempts /
      # 100ms for Kubernetes, 1 / 50ms in memory) and one leaf cannot express
      # both without silently unifying them.

      kubernetes {
        # namespace -- deliberately unset.  Unset means "read namespace-path
        # from the Pod's own ServiceAccount mount", and an empty string is
        # rejected by the validator, so there is no value that could stand for
        # "not set":
        #
        #   namespace = "actors"

        # Where the kubelet projects this Pod's ServiceAccount credential.
        # These name the IN-CLUSTER source only: pointing one of them elsewhere
        # while also naming an explicit apiServerUrl is refused, because that
        # pairing is what sent the cluster's own bearer token to an
        # operator-named host (#599).
        namespace-path = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"
        token-path = "/var/run/secrets/kubernetes.io/serviceaccount/token"
        ca-path = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"

        # How long a credential read from that mount may be reused before the
        # token file's mtime is checked again (#760).  No effect on an
        # explicitly supplied authToken, which is static by construction --
        # there is nowhere to re-read it from.
        token-reload-interval = 1m

        # Hard ceiling on one API-server request.  The renewal loop reasons
        # from this number: at the 15s TTL the docs recommend the renewal
        # interval is 5s, so a single request may legitimately span two ticks
        # and the in-flight guard drops the one that overlaps.  A wall-clock
        # deadline on the whole exchange, held by an abort signal and not by
        # the socket timeout, which Bun never arms while a TLS handshake is
        # pending -- the guard's arithmetic rests on this ceiling existing
        # during exactly that stall (#1529).
        operation-timeout = 10s

        # Lease object names longer than this are truncated to a stable head
        # plus a hash of the whole original name, so every node derives the
        # same object name from the same input.  253 is the DNS-1123 subdomain
        # bound the API server enforces on a coordination.k8s.io/v1 Lease.
        lease-name-max-length = 253
      }
    }
  }

  # Reliable delivery -- the push+ack protocol behind ReliableDelivery.producer
  # and ReliableDelivery.consumer.  These five layer UNDER whatever those two
  # statics were passed, so an explicit withWindowSize(...) still wins.  They
  # are read THERE and nowhere else: neither controller can read config from
  # its constructor, so one constructed directly and handed to system.spawn
  # keeps its built-in defaults and never sees this block.
  reliable-delivery {
    producer {
      # How long the producer waits for an acknowledgment before retransmitting
      # the same seq.  One fixed interval, re-armed unchanged on every miss --
      # there is no backoff here to tune (#646).
      resend-timeout = 500ms

      # Flow-control window: at most this many un-acked messages in flight.
      # Further sends queue in memory until an acknowledgment opens a slot, so
      # raising it trades the producer's heap against throughput over a link
      # whose round-trip dominates.  Keep it under the consumer's
      # max-out-of-order below: that many sends are already in flight when a
      # gap opens, so a window above the cap stalls this producer on its very
      # first gap, with nothing queued behind it.
      window-size = 16
    }
    consumer {
      # Most producers the consumer keeps deduplication state for at once.
      # The map is keyed by a producerId the SENDER chooses, so 0 -- unbounded
      # -- hands a peer the decision about how much this consumer retains, one
      # entry per distinct id and never released; that is the growth #728
      # bounded, and it has no symptom short of the OOM.  At the cap the
      # least-recently-used entry is evicted, which costs that producer's
      # duplicate suppression and nothing else.
      max-producers = 1024

      # How long a producer's deduplication entry survives with no delivery
      # from it.  The sweep runs on this same interval, so an idle entry is
      # released somewhere between one and two of them; 0 turns the sweep off
      # and leaves max-producers as the only thing reclaiming anything.  Keep
      # it well above the producers' resend-timeout -- an entry dropped while
      # its producer is still retransmitting one seq costs a duplicate handler
      # call, and the default leaves three orders of magnitude of headroom.
      producer-idle-time-to-live = 5m

      # Most sequences the consumer retains for ONE producer above an open gap
      # in that producer's stream.  At the cap a delivery that would grow the
      # set is refused -- no handler call and no acknowledgment -- so that
      # producer stalls and its retransmit keeps the send; the delivery that
      # closes the gap is admitted however full the set is.  A floor as well
      # as a bound: keep it above the largest window-size of any producer
      # talking to this consumer, or that producer stalls on its first gap.
      # 0 -- unbounded -- lets a sender that withholds one seq grow that
      # producer's set for as long as it keeps sending, the growth #728
      # bounded.
      max-out-of-order = 1024
    }
  }

  # Ceilings applied to bytes this process DECODES.  They bound what a peer or
  # a client can make a decoder do; they never change what this node writes, so
  # lowering one makes this node stricter than its own encoder rather than
  # altering the wire format.  A codec added later inherits the contract.
  #
  # Deliberately NOT applied to the persistence PayloadCodec: those bytes were
  # written by this framework into its own journal, so a row that stops
  # decoding is a recovery failure rather than an attack.  The HTTP body edge
  # is out too -- Marshalling builds its serializers with no system handle to
  # read this through, which is issue #967.
  serialization {
    read-constraints {
      # Container levels a decoder will descend.  Both codecs recurse once per
      # array / map / tag level, so without this a few hundred KB of nesting
      # exhausts the JS stack; JSON.parse offers nothing to inherit, being
      # iterative in every supported runtime.  Real payloads are shallow.
      # 256 is also the ENCODER's hard ceiling, so this may be lowered but
      # never raised -- a node that read deeper than it writes would accept a
      # payload it cannot produce.
      max-nesting-depth = 256

      # Ceiling on one document handed to JsonSerializer / CborSerializer,
      # checked before it is parsed.  0 = no ceiling of our own, and it is the
      # default because something already bounds every path the framework owns:
      # remote.max-frame-bytes on the cluster wire, the body cap over HTTP.
      max-document-bytes = 0

      # Ceiling on one CBOR byte string, text string or map key, checked
      # against the length prefix BEFORE the bytes are allocated.  0 removes
      # it.  CBOR-only: by the time the JSON walker sees a string, JSON.parse
      # has already materialised it.  The default sits above
      # remote.max-frame-bytes, so on the cluster wire the frame cap is the
      # effective ceiling and this one never binds.
      max-string-length = 20M
    }
  }

  http {
    backend = "fastify"   # fastify | express | hono
    # In-flight drain window for unbind() before connections are forced.
    # 0 keeps the historical behaviour (force immediately); raise it if you
    # want in-flight requests to finish on shutdown.
    shutdown-grace-period = 0ms

    # Connection-level bounds for the server itself -- the listening socket a
    # bind() opens, not a route on it.  withServerOptions(...) wins per field,
    # then this block, then the built-in default, and the merged result is
    # validated (OptionsError on a bad value).  The timeouts and
    # max-connections are installed on the server at listen(), so they reach
    # a backend you constructed yourself just as they reach the one the
    # framework builds.  The rest are fixed when the server is built --
    # max-content-length and max-header-bytes below, and tls and http2 -- so
    # the framework builds its backend with them, and one you built yourself
    # has to carry them: a hand-built Fastify adopts them only through
    # fastifyFactoryOptions(serverOptions), and bind() refuses a backend whose
    # own cap differs from a set key rather than serve under either number.
    #
    # NOT every backend can honour them.  Fastify, Express and Hono-on-Node
    # all expose the node:http server these are written to; Bun.serve and
    # Deno.serve expose neither that server nor an equivalent knob, so under
    # the Hono backend on Bun or Deno the timeouts, max-connections and
    # max-header-bytes are unavailable rather than quietly ignored -- bind()
    # names each one you set in a warning.  The one exception is idle-timeout
    # on Bun, which Bun.serve takes as its own idleTimeout when it is built --
    # see below.  request-timeout is enforced by a
    # periodic sweep, http.createServer's connectionsCheckingInterval -- 30s
    # by default and not set by actor-ts -- so a connection is closed no
    # earlier than the value set here and no later than one sweep after it.
    # It bounds receiving only: how long a handler may take to answer is
    # http.request-timeout, a different key.
    #
    # header-timeout is not swept, because it is not the runtime that enforces
    # it: writing server.headersTimeout is honoured on node and accepted-and-
    # ignored on bun and on deno, so actor-ts arms the deadline itself, from
    # the accepted connection, and it fires at the value set here.  That needs
    # the server to report its connections -- deno's node:http shim emits no
    # 'connection' event, so on deno it is unavailable whatever the backend.
    # 0 disables it (#870).
    #
    # Four leaves ship no value, because "unset" is a state none of them has a
    # number for:
    #
    #   idle-timeout -- how long an idle keep-alive connection is held before
    #     it is destroyed.  Unset keeps the backend's own, and the backends
    #     disagree on purpose: 72s on Fastify, so the server outlives a load
    #     balancer's idle window and the balancer never posts a request onto a
    #     socket that is closing, against node:http's 5s on Express and
    #     Hono-on-Node.  Set a duration to make them agree, or 0 to disable it.
    #     On the Hono backend under Bun it is Bun.serve's own idleTimeout, a
    #     wider bound: whole-connection inactivity, so a handler that writes
    #     nothing for that long, a long poll or a sparse SSE stream is cut
    #     too, and an idle HTTP/2 session with it.  Whole seconds, rounded
    #     up, checked on a 4s sweep that can close a connection up to one
    #     sweep early; above 255s bind() refuses it.  Unset there, it is not
    #     Bun's own 10s but derived from the longest request deadline --
    #     http.request-timeout, raised to the longest requestTimeout() in the
    #     routes -- so the 503 is written first: 36s for the built-in 30s.
    #
    #       idle-timeout = 5s
    #
    #   max-connections -- concurrent connections accepted before new ones are
    #     closed, unlimited by default.  The same shape
    #     http.websocket.max-connections has, but server-wide: it counts every
    #     connection on this binding, WebSocket upgrades and an attached
    #     DevTools server included.
    #
    #       max-connections = 10000
    #
    #   max-content-length -- the largest request body accepted, in bytes; a
    #     larger one is answered 413 before the handler runs, on every
    #     backend.  Unset keeps the backend's own cap: the 1 MiB every shipped
    #     backend applies, or what withMaxBodyBytes or Fastify's bodyLimit set
    #     on a backend you built.  Set, a backend built with a different cap
    #     of its own is refused at bind(); an equal one binds.
    #
    #       max-content-length = 8MiB
    #
    #   max-header-bytes -- the largest request header block accepted, in
    #     bytes; a larger one never reaches a handler.  Unset keeps the
    #     runtime's own: 16 KiB on node:http, and on Bun the process-wide
    #     --max-http-header-size.  Built into the server on Fastify, Express
    #     and Hono-on-Node; Bun.serve and Deno.serve have no per-server option
    #     for it.  On an HTTP/2 listener it caps the HTTP/1.1 requests on the
    #     shared port, but on Node not an HTTP/2 stream's headers.
    #
    #       max-header-bytes = 16KiB
    #
    # TLS is off unless the tls block below names a certificate, and off is
    # the right answer behind a reverse proxy or an ingress that terminates
    # for you.  Set, the process itself is the TLS endpoint -- Bun.serve,
    # https/http2 under @hono/node-server, Deno.serve, and Fastify's https
    # factory option.  Express does not terminate TLS: it REFUSES to bind
    # rather than serve plain HTTP under a setting that says otherwise, so
    # TLS for an Express server terminates in front of it.  The three
    # *-file leaves are paths, read once when this block is; in code
    # (withTls) the same fields carry PEM contents, never a path.  Client
    # certificates (request-client-cert, reject-unauthorized) are honoured on
    # Bun, Node and Fastify; Deno.serve has no client-auth option, so on Deno
    # request-client-cert is refused rather than silently ignored (#1522).
    #
    #   tls {
    #     cert-file           = "/etc/actor-ts/tls/cert.pem"
    #     key-file            = "/etc/actor-ts/tls/key.pem"
    #     ca-file             = "/etc/actor-ts/tls/ca.pem"   # for client-certificate verification
    #     request-client-cert = false
    #     reject-unauthorized = true
    #   }
    server {
      header-timeout  = 60s   # time to receive the complete headers -- the slow-loris guard
      request-timeout = 300s  # time to receive the ENTIRE request; bounds uploads, never responses
      # HTTP/2 over the TLS socket, HTTP/1.1 staying available on the same
      # port.  Refused without tls -- h2c is not offered.  Deno negotiates h2
      # whenever TLS is on and has no knob for it, so there this records
      # intent rather than deciding.
      http2           = false
    }

    # Per-route CORS defaults for cors(options, routes).  Leaf names are the
    # kebab-case of the CorsOptionsType fields; the route's own options win per
    # field, and the merged result is validated (OptionsError on a bad value).
    # Resolved when the route tree is compiled, which is the first moment this
    # configuration is in scope.
    #
    # Four leaves are read but ship no value, because publishing one would be
    # worse than publishing nothing:
    #
    #   origins -- the exact-match allowlist, e.g. ["https://app.example"].
    #     Unset is what keeps a cors() with no origins anywhere a loud error
    #     rather than a silent deny-all.  Allowing every origin stays code-only
    #     (withAnyOrigin()): a "*" written here is refused with a ConfigError,
    #     so no config file can widen a route's policy to any origin.  The
    #     predicate form is code-only too -- a function has no HOCON spelling.
    #   methods -- Access-Control-Allow-Methods.  Unset, it follows the methods
    #     actually registered at each pattern, which is narrower than any list
    #     that could be written here.
    #   allowed-headers -- unset, the sanitised request headers are echoed.
    #   max-age -- preflight cache lifetime in SECONDS, as a bare integer
    #     rather than a duration string: the header carries seconds, and a
    #     duration would be read as milliseconds.  Unset, no
    #     Access-Control-Max-Age header is sent at all.
    cors {
      exposed-headers = []    # Access-Control-Expose-Headers; [] sends none
      credentials     = off   # forbidden with "*" origins (the Fetch spec)
    }

    # The Strict-Transport-Security policy hsts() / strictTransportSecurity()
    # sends.  Leaf names are the kebab-case of the HstsOptionsType fields; the
    # route's own options win per field, and the merged policy is validated
    # when the route tree is compiled -- inside bind(), so a bad value, or a
    # preload the policy cannot back, fails there with an OptionsError.
    #
    # It governs that middleware only.  The hsts field of securityHeaders(...)
    # and of withSecurityHeaders(...) stays code-only: a server that sends HSTS
    # through the bundle is not changed by anything written here.
    #
    # max-age is in SECONDS, as a bare integer rather than a duration string:
    # the header carries seconds, and a duration would be read as
    # milliseconds.  max-age = 0 is refused with a ConfigError -- it tells
    # every browser to forget the pin, so switching HSTS off is code-only
    # (withMaxAge(0)).
    hsts {
      max-age             = 15552000  # 180 days
      include-sub-domains = on
      preload             = off       # needs max-age >= 31536000 and include-sub-domains
    }

    # How long a handler under requestTimeout() may take to answer before the
    # middleware answers 503 for it.  Not http.server.request-timeout, which
    # bounds how long a peer takes to SEND a request and never a response:
    # this clock starts once the request has arrived.  The route's own
    # options win (requestTimeout(5000)), and the merged deadline is validated
    # when the route tree is compiled -- inside bind(), OptionsError on a bad
    # value, including one longer than a timer can hold (about 24.9 days).
    # The response sent on timeout is a function and stays code-only
    # (withOnTimeout(...)).
    request-timeout {
      deadline = 30s
    }

    # Outbound HttpClient defaults — the system's shared client and any
    # newClient(...) that leaves a field unset.  Leaf names are the kebab-case
    # of the HttpClientOptions fields with any unit suffix dropped (the value
    # carries the unit), and are validated on read (a bad value throws
    # OptionsError).  A request may still override each of them per call;
    # these are the floor the fleet inherits without a code change.
    client {
      max-response-bytes = 8M       # buffered response body ceiling
      default-timeout    = 30s      # deadline for a call that names none
      redirect           = "follow" # follow | error | manual
      max-redirects      = 5        # hops a followed chain may take
    }

    # Server-side defaults for websocket() routes (per-connection policy).
    # Leaf names are the kebab-case of the WebsocketRouteOptions fields with
    # any unit suffix dropped; a route may override any of them, and the
    # resolved values are validated (OptionsError on a bad value).
    websocket {
      max-frame-bytes    = 1M       # inbound frame size cap
      on-oversize-frame  = "close"  # close | drop
      on-invalid-message = "close"  # close | drop | hook
      max-buffered-bytes = 4M       # outbound buffer cap before backpressure
      on-backpressure    = "drop"   # drop | close
      # max-connections is unlimited by default; set a positive integer to cap.
      # Inbound frames held while the connection actor starts; past either cap
      # the socket is closed with 1013 instead of buffered without bound.
      max-pre-attach-frames = 256
      max-pre-attach-bytes  = 4M
      # How long an admitted upgrade waits for its connection actor before the
      # socket is closed and its max-connections slot released.  Infinity to
      # disable (code only — HOCON has no Infinity literal).
      accept-timeout = 10s
      # Bound on each connection actor's outbound mailbox — the queue
      # connection.tell, sendRaw and close go into.  Unset by default, so a
      # connection falls through to actor-ts.mailbox.default above, which is
      # itself unbounded unless set; a route's own value wins over both.  Past
      # the bound the policy sheds frames, never the close.  The policy needs
      # a capacity beside it (a global one does not count).
      # drop-head | drop-new | reject.
      # connection-mailbox-capacity = 1024
      # connection-mailbox-overflow = "drop-head"
    }
  }

  # Defaults for every breaker resolved through the CircuitBreakerExtension --
  # system.extension(CircuitBreakerExtensionId).breaker('payment-api').  Leaf
  # names are the kebab-case of the CircuitBreakerOptions fields with any unit
  # suffix dropped, and are validated on read (a bad value throws OptionsError).
  # A breaker built in code reads none of this; that door is unchanged.
  circuit-breaker {
    # The floor every named breaker inherits.  "default" is reserved: it is the
    # defaults block and it is also the id breaker() resolves with no argument,
    # which is the same thing said twice rather than a collision.
    default {
      max-failures      = 10     # consecutive failures before the breaker opens
      reset-timeout     = 15s    # how long it stays open before letting a probe through

      # Growth of that window while the breaker keeps re-opening.  The delay is
      # reset-timeout * backoff-factor^(consecutive opens - 1), clamped to
      # max-reset-timeout, then spread by +/- random-factor.  The shipped
      # 1.0 / 0.0 pair reproduces the flat, unjittered window exactly, so
      # turning either on is a change a deployment makes on purpose.
      max-reset-timeout = 60s    # ceiling the grown window is clamped to
      backoff-factor    = 1.0    # 1.0 = no growth
      random-factor     = 0.0    # 0.0 = no jitter; 0.2 is the spread used elsewhere

      # Error.name values that never count as a failure.  Checked BEFORE the
      # code-side isFailure predicate, so a name listed here is not a failure
      # whatever the code says -- an operator cannot reach into a compiled
      # predicate, and a key that goes inert for the deployments that needed it
      # is not a key.  "CircuitBreakerTimeoutError" is listable and means "a
      # call that blew its own call-timeout does not count against the breaker".
      ignored-error-names = []
    }

    # call-timeout is deliberately not a leaf: omitting it is what disables the
    # per-call timeout and the validator refuses 0, so "no deadline" is a state
    # only a missing key can express.  Written, it is read like any other:
    #
    #   actor-ts.circuit-breaker.default.call-timeout = 2s
    #
    # Per-breaker overrides live under the breaker's own id and win over the
    # default block leaf by leaf:
    #
    #   actor-ts.circuit-breaker.payment-api { max-failures = 3, reset-timeout = 30s }
    #
    # The id is the application's, so those paths cannot be listed here.
  }

  # Projections poll the read side and feed a read model.  These are the
  # process-wide defaults; ProjectionOptions on a single projection wins.
  projection {
    # What a projection does when its handler throws.  Deliberately not
    # "fail": the common failure is transient (the read model is restarting),
    # and stopping on the first blip makes every read-model deploy a dead
    # projection that nobody notices until the view is visibly stale.
    recovery-strategy = "retry-and-fail"   # fail | skip | retry-and-fail | retry-and-skip
    max-retries       = 3                  # attempts AFTER the first, for the retry-* strategies
    retry-backoff     = 1s                 # first retry delay; doubles per attempt
    max-retry-backoff = 60s                # ceiling on the doubling delay
    poll-interval     = 1s                 # how often a projection polls for new events

    # Most events per handleGroup call.  Grouped (handleGroup) projections
    # only: a handle projection is delivered one event per call and ignores
    # this.  Groups are cut from what one poll returned, so the poll interval
    # is the window and nothing is held back to fill a group.
    group-after-envelopes = 20
  }

  # Fleet-wide defaults for BackoffSupervisor.  The options passed to a single
  # supervisor win per field; these fill in whatever it leaves unset, so a
  # deployment can retune every supervisor's respawn pacing without touching
  # the call sites.  The window below is the same curve worker-cluster paces a
  # crashed slot with.
  backoff-supervisor {
    min-backoff    = 200ms              # floor of the delay; must be > 0
    max-backoff    = 10s                # ceiling; must be >= min-backoff
    # Jitter fraction in [0, 1], so a herd of supervisors does not respawn in
    # lockstep.  Inert for a supervisor that supplies its own policy — that
    # policy computes the whole delay, jitter included.
    random-factor  = 0.2
    max-stash-size = 1000               # messages held per supervisor while its child is dead
    # never | after-min-stable | a duration.  after-min-stable resets the
    # restart counter once the child has outlived one min-backoff; a duration
    # names that window explicitly.
    reset-counter  = "after-min-stable"
    forward        = "stash"            # stash | drop — what happens to messages meanwhile
    trigger-on     = "any"              # any | failure | stop — which terminations respawn
    # How long a respawned child has to survive before the stash drains into
    # it, so a child that crashes in preStart does not take the stash with it.
    # "auto" is min(50ms, min-backoff), resolved per supervisor against its own
    # min-backoff, so the grace never outlasts the backoff window it sits in; a
    # duration fixes it, and 0 drains at once.
    drain-grace    = "auto"
    # Whether messages arriving inside that grace go straight to the respawned
    # child (true) or wait in the stash until it has survived the grace (false),
    # which costs up to one grace of latency after each respawn but
    # dead-letters nothing while a child keeps crashing in preStart.
    forward-during-grace = true
  }

  cache {
    # Defaults for the built-in in-memory cache (the "default" cache, and any
    # cache whose plugin resolves to actor-ts.cache.in-memory).  Leaf names are
    # the kebab-case of the InMemoryCacheOptions fields with any unit suffix
    # dropped, and are validated on read — a bad value throws OptionsError.
    # max-entries caps this map's entries; the one-character-different
    # actor-ts.sharding.max-entities caps a shard region's entity actors, and
    # neither block complains about the other's spelling.
    in-memory {
      max-entries      = 10000   # LRU cap on entries (Infinity/unbounded only settable in code)
      cleanup-interval = 60s     # background expired-entry sweep (0 disables the sweep)

      # Expiry for entries whose writer named no ttlMs of its own.  Both cover
      # set / mset ONLY: for incr and setIfAbsent the cache is the source of
      # truth, so "no ttlMs" there is the caller saying this counter or this
      # lock outlives any policy, and bounding one from a config file would
      # expire a claim nobody released.
      time-to-live     = 0       # how long such an entry lives (0 = forever)
      # A read pushes that entry's expiry out to now + time-to-idle, never
      # past its time-to-live — so an idle window at or above time-to-live
      # never binds.  Only entries in the eviction-first half are extended:
      # refreshing a rate-limit counter on every read would keep its window
      # from ever closing.
      time-to-idle     = 0       # 0 = a read extends nothing
    }
    # Per-instance overrides live under the cache's own name and win over the
    # block above, so one consumer can be sized for its own key space:
    #
    #   actor-ts.cache.idempotency.in-memory.max-entries = 200000
    #
    # The name is the application's, so these paths cannot be listed here.
    # actor-ts.cache.<name>.plugin selects the backend the same way.
    #
    # prefix-quotas splits ONE instance between the consumers writing into it,
    # so a flood of keys under one prefix evicts only that prefix's entries
    # (#607).  Each quota is a cap and a reservation; they must sum to at most
    # that instance's max-entries.  Off by default — an undivided map is the
    # behaviour every release before it had.  Quote the prefixes, they contain
    # a colon:
    #
    #   actor-ts.cache.shared.in-memory {
    #     max-entries   = 10000
    #     prefix-quotas { "rsp:" = 7000, "idem:" = 2000, "rl:" = 1000 }
    #   }
    #
    # A per-name table replaces the global one rather than merging with it.

    # Connection settings for every cache whose plugin resolves to
    # actor-ts.cache.redis.  ioredis is a lazy optional peer, so a block that
    # nobody resolves costs nothing — the driver is imported on the first
    # cache operation, not at startup.  Empty means UNSET throughout: the "" is
    # the shape of the key, and the reader drops it rather than handing it on.
    redis {
      url        = ""   # redis://host:6379 or rediss://… — prefer \${?REDIS_URL}
      db         = 0    # logical database; ignored when url is set, put it in the URL path
      key-prefix = ""   # prepended to every key, e.g. "billing:"
      password   = ""   # prefer a substitution: password = \${?REDIS_PASSWORD}
      # host and port are deliberately comments rather than leaves.  url is
      # mutually exclusive with them and OptionsError says so, which only stays
      # useful while "unset" is expressible: a shipped host = "localhost" would
      # be set for everyone, and every url would then be refused.  Left unset,
      # ioredis applies its own 127.0.0.1:6379.
      #
      #   host = "localhost"
      #   port = 6379
    }

    # The same for actor-ts.cache.memcached (memjs, also a lazy optional peer).
    memcached {
      servers    = "localhost:11211"   # comma-separated host:port list
      username   = ""                  # SASL — prefer \${?MEMCACHED_USERNAME}
      password   = ""                  # SASL — prefer \${?MEMCACHED_PASSWORD}
      key-prefix = ""                  # applied server-side to every operation
    }

    # Both blocks take a per-instance layer under the cache's own name, the
    # way in-memory does — so two consumers can hold different Redis
    # databases without sharing one connection's settings:
    #
    #   actor-ts.cache.rate-limit.plugin = "actor-ts.cache.redis"
    #   actor-ts.cache.rate-limit.redis.db = 3
  }

  # The operational HTTP surface managementRoutes(system, cluster, ...) builds,
  # and the deadline the shared HealthCheckRegistry gives one check.  Leaf
  # names match ManagementRoutesOptionsType field for field; explicit options
  # still win over everything here.  auth and ipAllowlist are absent by nature
  # -- they are Middleware functions, so this block can move a probe or open an
  # endpoint but never decide who may reach one.
  management {
    # The mutating and metrics endpoints stay off unless asked for.
    enable-leave-endpoint   = false
    enable-down-endpoint    = false
    enable-metrics-endpoint = false
    # Extend the auth middleware over /health and /ready too.  Off, because a Kubernetes
    # probe cannot present a credential and would restart the pod on the 401.
    auth-protect-health     = false

    # The two probe endpoints, as SINGLE path segments -- a value containing a
    # slash is refused, because it would be stored as one segment, match no URL
    # and make the endpoint silently disappear.  These are the paths that ship
    # today, so changing a default here moves a documented endpoint.
    liveness-path  = "health"
    readiness-path = "ready"

    health-checks {
      # Deadline for ONE check.  Past it that check reports status = false with
      # a detail naming the deadline and its siblings still report normally, so
      # a hung dependency costs one failing entry rather than the whole probe.
      check-timeout = 1s
    }
  }

  persistence {
    # Behaviour of every PersistentActor in this system, read once by
    # PersistenceExtension.  The sub-blocks below are plugin-id namespaces and
    # belong to the backend that owns them; these five are not, which is why
    # they sit one level above where a plugin id can appear.

    # Journal replays allowed to run at once, system-wide.  0 = uncapped.
    #   A shard hand-off re-creates every entity it owns at once and each one
    #   replays, so without a cap a rolling restart opens thousands of reads
    #   against a pool sized for tens and every replay slows down together.
    #   sharding.entity-recovery paces the entity STARTS one layer up; this
    #   bounds how many of their replays are in flight once they are started.
    max-concurrent-recoveries = 50
    # Ceiling on ONE actor's whole recovery -- snapshot load, journal read,
    #   fold, and the highestSeq probe a fully compacted stream needs.  Not a
    #   per-event bound: Journal.read returns the slice in one call, so there
    #   is no per-event step to bound.  Past it the replay fails with a
    #   RecoveryTimeoutError through onRecoveryFailure.  0 = no deadline.
    recovery-timeout = 30s
    # Fall back to a full journal replay when the snapshot store cannot
    #   answer, instead of failing the recovery.  It deliberately does NOT
    #   cover an actor that set integrity() or encryption(): a store rejecting
    #   a tampered body and a store that is simply down both surface as a
    #   rejected load, and swallowing the first would turn an integrity check
    #   into a retry.
    snapshot-is-optional = false

    # The circuit-breaker each store is called through, BY ID -- the numbers
    #   live under actor-ts.circuit-breaker.<id>, layered over
    #   actor-ts.circuit-breaker.default, so they are configured exactly like
    #   every other breaker instead of a second time here.  "" = no breaker.
    #
    # call-timeout is the one worth knowing about: it is the ceiling on a
    #   single append, and it is what makes a backend that accepts the
    #   connection and then stalls fail at the stall rather than wedge the
    #   actor.  It ships unset, because omitting it is what means "no
    #   deadline" -- to bound appends, write:
    #
    #     actor-ts.circuit-breaker.persistence-journal.call-timeout = 10s
    #
    # Two ids rather than one: a snapshot store that is down must not
    #   fast-fail a journal that is fine.  Point both at one id where the two
    #   share a database and therefore fail together.
    journal-breaker  = "persistence-journal"
    snapshot-breaker = "persistence-snapshot"

    journal {
      plugin = "actor-ts.persistence.journal.in-memory"

      # Local SQLite journal.  registerSqlitePlugins(ext) makes this id real;
      # the block below is what that call reads when it is given no options.
      # Explicit SqliteJournalOptions always win over anything here.
      sqlite {
        # Database file.  "" means "not set" and falls through to an anonymous
        #   in-memory database, private to the handle that opens it -- which is
        #   also why it is published empty rather than as ":memory:": three
        #   blocks each shipping a real default would let a deployment point the
        #   journal at a file, leave the snapshot store alone, and lose every
        #   snapshot on restart while the config file read as if that had been
        #   chosen.
        path = ""
        # The tags table is derived as <events-table>_tags, and the metadata
        #   table as <events-table>_meta -- both follow this name.
        events-table = "events"
        wal = off                     # journal_mode = WAL: concurrent readers during a write
        busy-timeout = 1s             # lock wait before SQLITE_BUSY; 0 fails fast
      }

      # PostgreSQL journal.  registerPostgresPlugins(ext) makes this id real;
      # the block below is what that call reads when it is given no options.
      # Explicit PostgresJournalOptions always win over anything here.
      #
      # The five relational journals below share one implementation, so they
      # share one field table -- events-table, tags-table, auto-create-tables --
      # and differ only in how they are reached.
      postgres {
        # Connection string.  "" means "not set", so an unset url falls through
        #   to whatever the register helper was given instead of overriding it
        #   with an empty one.  Keep the credentials out of the file:
        #   url = \${?DATABASE_URL}.  A url that switches TLS verification off
        #   (sslmode=no-verify and its kin) is refused with a ConfigError.
        url = ""
        events-table = "events"
        # tags-table -- deliberately unset: the default is DERIVED from the
        #   name above (<events-table>_tags), so absence is what keeps the two
        #   in step.  Set it only to point the tag index at an existing table.
        auto-create-tables = on       # CREATE TABLE IF NOT EXISTS on first use
        # The connection's tuning -- typed leaves, each deliberately unset:
        #   absence leaves the driver's own default (pg 8.23 over pg-pool 3.14),
        #   which is the only value that keeps tracking it.  A bad value is
        #   refused with an OptionsError when the store is built.
        # max-pool-size -- connections the pool holds; pg-pool's max, default 10.
        # idle-timeout -- how long an idle connection stays open; pg-pool's
        #   idleTimeoutMillis, default 10s.
        # connect-timeout -- how long opening a connection may take; pg's
        #   connectionTimeoutMillis, default none (it waits indefinitely).
        # ca-file -- PEM file of the CA that signed the server certificate,
        #   read when the pool opens and handed to pg as ssl.ca: a path, never
        #   the certificate itself.  Refused beside a url ssl parameter, which
        #   pg would put in its place (name the CA there with sslrootcert),
        #   and beside a CA written into poolConfig.
        # A pre-built pool and a poolConfig object have NO leaf: the first is a
        #   live object, the second the driver's whole option surface, which
        #   stays code-only for everything the leaves above leave out
        #   (RegisterPostgresPluginsOptions.withPool / withPoolConfig).
      }

      # MariaDB / MySQL journal -- see the postgres block above.
      mariadb {
        url = ""                      # mariadb://user:pass@host:3306/db
        events-table = "events"
        # tags-table -- derived as <events-table>_tags; see postgres above.
        auto-create-tables = on
        # The connection's tuning, deliberately unset as under postgres above:
        #   absence leaves the connector's own default (mariadb 3.5).
        # max-pool-size -- connections the pool holds; connectionLimit,
        #   default 10.
        # acquire-timeout -- how long a caller waits for a free connection;
        #   acquireTimeout, default 10s.
        # idle-timeout -- how long an idle connection stays open; idleTimeout,
        #   default 1800s.  Whole seconds only: the connector counts in seconds.
        # connect-timeout -- how long opening a connection may take;
        #   connectTimeout, default 1s, capped at the acquire timeout.
        # ca-file -- PEM file of the CA that signed the server certificate,
        #   read when the pool opens and handed over as ssl.ca: the one route
        #   to a private CA from configuration, the url's ssl being a bare
        #   switch.  Refused beside a url ssl that switches TLS off.
        # A leaf beside the same option in the url's query (connectionLimit,
        #   say) is refused: set it in one place.
      }

      # SQL Server journal -- see the postgres block above.
      mssql {
        # A connection string, "Server=host,1433;Database=app;…".  An mssql://
        #   url is refused when the store is built: node-mssql has parsed none
        #   since its 8.0 and reads one as no server at all.  A url that
        #   switches TLS verification off (TrustServerCertificate set to
        #   anything but false) is refused with a ConfigError.
        url = ""
        events-table = "events"
        # tags-table -- derived as <events-table>_tags; see postgres above.
        auto-create-tables = on
        # The connection's tuning, deliberately unset as under postgres above:
        #   absence leaves node-mssql's own default (mssql 12.7).
        # max-pool-size -- connections the pool holds; pool.max, default 10.
        # idle-timeout -- how long an idle connection stays open;
        #   pool.idleTimeoutMillis, default 30s.
        # connect-timeout -- how long opening a connection may take;
        #   connectionTimeout, default 15s.
        # request-timeout -- how long one request may run; requestTimeout,
        #   default 15s.
        # ca-file -- PEM file of the CA that signed the server certificate,
        #   read when the pool opens and handed to tedious to verify against:
        #   the one route to a private CA from configuration, a connection
        #   string having no key for one.  Refused beside an Encrypt or a
        #   TrustServerCertificate in the url that would leave it unused.
        # A leaf beside the same key in the url (Max Pool Size, Connect
        #   Timeout, Request Timeout) is refused: set it in one place.
      }

      # libSQL / Turso journal -- see the postgres block above.
      libsql {
        url = ""                      # libsql://… , or http(s):// / ws(s):// for a self-hosted sqld
        auth-token = ""               # Turso token; prefer \${?TURSO_AUTH_TOKEN}
        events-table = "events"
        # tags-table -- derived as <events-table>_tags; see postgres above.
        auto-create-tables = on
      }

      # Cloudflare D1 journal -- see the postgres block above.  D1 is reached by
      # three coordinates rather than a URL, and it is the one backend that
      # speaks over plain HTTP, so base-url is a real default rather than a
      # placeholder.
      cloudflare-d1 {
        account-id  = ""
        database-id = ""              # the UUID, not the database name
        api-token   = ""              # D1:Edit token; prefer \${?CLOUDFLARE_API_TOKEN}
        base-url    = "https://api.cloudflare.com/client/v4"
        # The transport's two bounds.  Every statement is one HTTPS request, and
        #   a replay reads an actor's whole history in one statement, so these
        #   bound a whole replay: how long its one request may take, and how
        #   large the one response it arrives in may grow.
        timeout = 30s
        max-response-bytes = 64M
        events-table = "events"
        # tags-table -- derived as <events-table>_tags; see postgres above.
        auto-create-tables = on
      }

      # MongoDB journal.  registerMongoPlugins(ext) makes this id real; the
      # block below is what that call reads when a field is left unset.
      # Explicit MongoJournalOptions always win over anything here.
      #
      # Mongo names its containers COLLECTIONS, so the leaves say collection and
      # the switch creates indexes rather than tables.  A leaf named after
      # another backend's vocabulary is a leaf an operator has to translate.
      mongodb {
        url = ""                      # mongodb://... or mongodb+srv://...; "" = not set
        database-name = "actor_ts"
        events-collection = "events"  # its meta collection is <it>_meta
        auto-create-indexes = on      # the unique index is what refuses a duplicate append
        # The client's tuning -- typed leaves, each deliberately unset: absence
        #   leaves the driver's own default (mongodb 6 and 7 alike), which is
        #   the only value that keeps tracking it.  A bad value is refused with
        #   an OptionsError when the store is built.
        # max-pool-size -- connections the client holds open to one server;
        #   maxPoolSize, default 100.
        # min-pool-size -- connections it keeps open ahead of use; minPoolSize,
        #   default 0.  At most max-pool-size.
        # server-selection-timeout -- how long an operation waits for a server
        #   it can use; serverSelectionTimeoutMS, default 30s.
        # connect-timeout -- how long opening a connection may take;
        #   connectTimeoutMS, default 30s.
        # ca-file -- PEM file of the CA that signed the server certificate,
        #   read when the client opens and handed to the driver as its ca, with
        #   tls on: a path, never the certificate itself.  Refused beside a url
        #   tlsCAFile, which the driver would drop for it, and beside a url tls
        #   or ssl that switches TLS off.
        # A leaf beside the same option in the url's query (maxPoolSize, say)
        #   is refused: the driver would keep the leaf and drop the url's
        #   without a word.  Set it in one place.
        # A pre-built client and a clientOptions object have NO leaf: the first
        #   is a live object, the second the driver's whole option surface,
        #   which stays code-only for everything the leaves above leave out
        #   (RegisterMongoPluginsOptions.withClient / withClientOptions).
      }

      # DynamoDB journal -- see the mongodb block above for the shape.  Reached
      # by a region rather than a URL, and the table name carries the actor_ts_
      # prefix on purpose: a DynamoDB table name is account- and region-global,
      # so a bare "events" would collide with whatever else the account owns.
      dynamodb {
        region   = ""                 # e.g. eu-central-1; "" = not set
        endpoint = ""                 # dynamodb-local / LocalStack; "" = the real service
        events-table = "actor_ts_events"
        # The client's retry and timeout settings -- typed leaves, each
        #   deliberately unset: absence leaves the SDK's own resolution (an
        #   AWS_* environment variable, then the shared config file, then its
        #   default), which a shipped value would overrule.  A bad value is
        #   refused with an OptionsError when the store is built.
        # max-attempts -- attempts per request, the first included;
        #   maxAttempts, default 3 (AWS_MAX_ATTEMPTS while unset).
        # retry-mode -- standard or adaptive; retryMode, default standard
        #   (AWS_RETRY_MODE while unset).  Any other word is refused.
        # request-timeout -- how long one attempt may take before it fails;
        #   the request handler's requestTimeout, default none.
        # connection-timeout -- how long opening the connection may take; the
        #   request handler's connectionTimeout, default none.
        # A pre-built operations facade and a clientConfig object have NO leaf:
        #   the second is the SDK's whole option surface and stays code-only,
        #   credentials above all -- omitted, the SDK's own default chain
        #   supplies them.  A leaf beside what it replaces in clientConfig is
        #   refused: set it in one place.
        # Table provisioning: how a table the store creates on first use is
        #   created.  billing-mode is pay-per-request (on-demand, no capacity
        #   to plan) or provisioned; anything else is refused, AWS's own
        #   spelling of either included.
        billing-mode = "pay-per-request"
        # provisioned-throughput -- the capacity a provisioned table is created
        #   with, deliberately unset: published, it would be refused under the
        #   default billing mode, and a provisioned table with no pair is
        #   created at 5 read and 5 write capacity units.  Set both halves:
        #   provisioned-throughput { read-capacity-units = 10, write-capacity-units = 5 }
        table-ready-timeout = 30s     # how long a new table may take to turn ACTIVE
        auto-create-tables = on       # CreateTable on first use; an existing table is fine
      }

      # Cassandra / ScyllaDB journal.  registerCassandraPlugins(ext) makes this
      # id real.  The widest block in the family: Cassandra is reached by a seed
      # list rather than a URL, and its schema is four tables rather than one
      # plus a derived name, because a wide-column store has no join to derive
      # one with.
      cassandra {
        contact-points = []           # [] = not set; e.g. ["10.0.0.1", "10.0.0.2"]
        keyspace = ""                 # "" = not set; required at the point of use
        local-data-center = "datacenter1"
        port = 9042
        auto-create-keyspace = off    # CREATE KEYSPACE on start, with the replication below
        # The replication auto-create-keyspace creates the keyspace with; nothing
        #   reads it otherwise.  class is simple-strategy or
        #   network-topology-strategy -- CQL's own class names are refused
        #   here -- and replication-factor is simple-strategy's copy count.
        replication {
          class = "simple-strategy"
          replication-factor = 1
          # data-centers -- network-topology-strategy's copies per data center,
          #   deliberately unset.  A list rather than a map, because a data
          #   center's name is data, not a key; set under simple-strategy, it
          #   is refused rather than ignored:
          #   data-centers = [
          #     { name = "eu-west-1", replication-factor = 3 }
          #     { name = "us-east-1", replication-factor = 3 }
          #   ]
        }
        # credentials -- no leaf: key material.
        # consistency -- deliberately unset: with nothing here the DRIVER picks
        #   the CQL level, and absence is what keeps that true.  Set the numeric
        #   value from cassandra-driver's types.consistencies (LOCAL_QUORUM = 6)
        #   to pin it.
        events-table    = "events"
        metadata-table  = "metadata"            # highest sequence number per pid
        all-ids-table   = "all_persistence_ids" # the lookup behind persistenceIds()
        tag-index-table = "events_by_tag"       # written only when use-tag-index is on
        partition-size = 500000       # rows per partition before rolling over
        auto-create-tables = on
        use-tag-index = off           # dual-write an events_by_tag side table
        lightweight-transactions = on # Paxos claim per append; off risks a lost write
        # serial-consistency -- deliberately unset: ignored unless the LWT above
        #   is on, and unset the driver picks cluster-wide SERIAL.  Set 9
        #   (localSerial) to keep Paxos inside the local data center.
      }
    }
    snapshot-store {
      plugin = "actor-ts.persistence.snapshot-store.in-memory"

      # The built-in in-memory snapshot store -- the one this file selects above,
      # and the only block outside the per-backend fan-out.
      in-memory {
        # Snapshots kept per persistenceId.  0 keeps EVERY one, which is where
        #   this store deliberately parts company with its siblings (they keep
        #   3): it is what an unconfigured application gets, so a default bound
        #   would quietly start discarding snapshots for every test in the repo.
        #   Set it to bound a long-running fixture.
        keep-n = 0
      }

      # Local SQLite snapshot store -- see the journal's sqlite block above.
      sqlite {
        path = ""                     # "" = not set; an in-memory database per handle
        snapshots-table = "snapshots"
        keep-n = 3                    # snapshots kept per persistenceId; 0 disables pruning
        busy-timeout = 1s
      }

      # The five relational snapshot stores -- see the journal blocks above for
      # what each connection half means.  The connection is repeated under every
      # plugin root rather than hoisted: a plugin id IS its config section, and
      # the three axes are selected independently, so they may legitimately name
      # different databases.  A deployment that shares one connection writes it
      # once and substitutes -- url = \${actor-ts.persistence.journal.postgres.url}.
      postgres {
        url = ""
        snapshots-table = "snapshots"
        keep-n = 3                    # snapshots kept per persistenceId; 0 disables pruning
        auto-create-tables = on
        # Deliberately unset, as under the journal's postgres block:
        # max-pool-size -- pg-pool's max, default 10.
        # idle-timeout -- pg-pool's idleTimeoutMillis, default 10s.
        # connect-timeout -- pg's connectionTimeoutMillis, default none.
        # ca-file -- PEM file read into ssl.ca when the pool opens.
      }

      mariadb {
        url = ""
        snapshots-table = "snapshots"
        keep-n = 3
        auto-create-tables = on
        # Deliberately unset, as under the journal's mariadb block:
        # max-pool-size -- connectionLimit, default 10.
        # acquire-timeout -- acquireTimeout, default 10s.
        # idle-timeout -- idleTimeout, default 1800s; whole seconds only.
        # connect-timeout -- connectTimeout, default 1s.
        # ca-file -- PEM file read into ssl.ca when the pool opens.
      }

      mssql {
        url = ""
        snapshots-table = "snapshots"
        keep-n = 3
        auto-create-tables = on
        # Deliberately unset, as under the journal's mssql block:
        # max-pool-size -- pool.max, default 10.
        # idle-timeout -- pool.idleTimeoutMillis, default 30s.
        # connect-timeout -- connectionTimeout, default 15s.
        # request-timeout -- requestTimeout, default 15s.
        # ca-file -- PEM file tedious verifies the server against.
      }

      libsql {
        url = ""
        auth-token = ""               # prefer \${?TURSO_AUTH_TOKEN}
        snapshots-table = "snapshots"
        keep-n = 3
        auto-create-tables = on
      }

      cloudflare-d1 {
        account-id  = ""
        database-id = ""
        api-token   = ""              # prefer \${?CLOUDFLARE_API_TOKEN}
        base-url    = "https://api.cloudflare.com/client/v4"
        timeout = 30s                 # the transport's bounds; see the journal's block
        max-response-bytes = 64M
        snapshots-table = "snapshots"
        keep-n = 3
        auto-create-tables = on
      }

      # MongoDB snapshot store -- see the journal's mongodb block above.
      mongodb {
        url = ""
        database-name = "actor_ts"
        snapshots-collection = "snapshots"
        keep-n = 3                    # snapshots kept per persistenceId; 0 disables pruning
        auto-create-indexes = on
        # Deliberately unset, as under the journal's mongodb block:
        # max-pool-size -- maxPoolSize, default 100.
        # min-pool-size -- minPoolSize, default 0.
        # server-selection-timeout -- serverSelectionTimeoutMS, default 30s.
        # connect-timeout -- connectTimeoutMS, default 30s.
        # ca-file -- PEM file read into the driver's ca when the client opens.
      }

      # DynamoDB snapshot store -- see the journal's dynamodb block above.
      dynamodb {
        region   = ""
        endpoint = ""
        snapshots-table = "actor_ts_snapshots"
        keep-n = 3
        billing-mode = "pay-per-request" # see the journal's dynamodb block
        # provisioned-throughput -- deliberately unset; see the journal's block.
        table-ready-timeout = 30s
        auto-create-tables = on
        # Deliberately unset, as under the journal's dynamodb block:
        # max-attempts -- maxAttempts, default 3.
        # retry-mode -- retryMode, standard or adaptive; default standard.
        # request-timeout -- the request handler's requestTimeout, default none.
        # connection-timeout -- its connectionTimeout, default none.
      }

      # Cassandra / ScyllaDB snapshot store -- see the journal's cassandra block
      # above for what each connection leaf means.  The connection is repeated
      # here rather than hoisted: a plugin id IS its config section, and the two
      # axes are selected independently, so they may legitimately name different
      # keyspaces.  A deployment that shares one writes it once and substitutes.
      cassandra {
        contact-points = []
        keyspace = ""
        local-data-center = "datacenter1"
        port = 9042
        auto-create-keyspace = off
        replication {                 # see the journal's cassandra block
          class = "simple-strategy"
          replication-factor = 1
          # data-centers -- deliberately unset; see the journal's block.
        }
        # consistency -- deliberately unset; see the journal's cassandra block.
        snapshots-table = "snapshots"
        keep-n = 3
        auto-create-tables = on
      }

      # Object-storage snapshot store -- S3-compatible or local filesystem.
      # This block also configures the durable-state store that the same
      # registerObjectStoragePlugins() call returns: the two share ONE
      # backend, so the settings are declared once here rather than twice.
      # Explicit ObjectStoragePluginOptions always win over anything below.
      object-storage {
        backend = ""                  # "" | filesystem | s3 -- "" leaves the backend to code
        prefix  = ""                  # prepended to every object key, e.g. "env-prod/"
        keep-n  = 3                   # snapshots kept per persistenceId; 0 disables pruning
        # Decompression-bomb guard on read.  Infinity opts out and is code-only
        # (withMaxDecompressedBytes) -- HOCON has no Infinity literal, and 0 is
        # not a free sentinel either because the validator rejects it.
        max-decompressed-bytes = 512M

        compression {
          algorithm = "gzip"          # none | gzip | zstd
          # level -- deliberately unset: the default is algorithm-specific
          #   (gzip 6, zstd 3) and is chosen by the encoder from absence.
          #   Set an integer to pin it; it is never recorded on the wire.
        }

        encryption {
          mode = "none"               # none | sse-s3 | sse-kms
          kms-key-id = ""             # required when mode = sse-kms; a key ARN, not key material
          # mode = client-aes256-gcm is REFUSED here: it needs a 32-byte master
          #   key, which must never live in a config file.  Configure it in code
          #   with ObjectStoragePluginOptions.withEncryption(...).
        }

        s3 {
          bucket = ""
          region = ""                 # "auto" for Cloudflare R2
          endpoint = ""               # MinIO / R2 / B2 / Spaces / Wasabi; empty = AWS S3
          force-path-style = off      # required for MinIO and most non-AWS stores
          # Credentials never appear here.  Omitting them uses the SDK default
          #   chain: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, EC2 instance
          #   profile, or IAM Roles for Service Accounts.
        }

        filesystem {
          dir = ""                    # root directory; created recursively
          lock-timeout = 5s           # wait for a per-key write lock before failing
          stale-lock   = 30s          # lock files older than this are force-removed
        }
      }
    }

    # The third plug-in axis.  A DurableStateActor that names no store in its
    # options uses whichever store this selects, exactly as a PersistentActor
    # uses the journal above.
    durable-state {
      plugin = "actor-ts.persistence.durable-state.in-memory"

      # Local SQLite durable-state store -- see the journal's sqlite block.
      sqlite {
        path = ""                     # "" = not set; this store has no in-memory fallback
        table = "durable_state"
        auto-create-tables = on       # CREATE TABLE IF NOT EXISTS on first use
        busy-timeout = 1s
      }

      # The five relational durable-state stores -- see the journal blocks above.
      # Each backend's store is a registered factory now rather than an instance
      # its register helper built eagerly and returned, so the plugin key above
      # actually selects one.
      postgres {
        url = ""
        table = "durable_state"
        auto-create-tables = on
        # Deliberately unset, as under the journal's postgres block:
        # max-pool-size -- pg-pool's max, default 10.
        # idle-timeout -- pg-pool's idleTimeoutMillis, default 10s.
        # connect-timeout -- pg's connectionTimeoutMillis, default none.
        # ca-file -- PEM file read into ssl.ca when the pool opens.
      }

      mariadb {
        url = ""
        table = "durable_state"
        auto-create-tables = on
        # Deliberately unset, as under the journal's mariadb block:
        # max-pool-size -- connectionLimit, default 10.
        # acquire-timeout -- acquireTimeout, default 10s.
        # idle-timeout -- idleTimeout, default 1800s; whole seconds only.
        # connect-timeout -- connectTimeout, default 1s.
        # ca-file -- PEM file read into ssl.ca when the pool opens.
      }

      mssql {
        url = ""
        table = "durable_state"
        auto-create-tables = on
        # Deliberately unset, as under the journal's mssql block:
        # max-pool-size -- pool.max, default 10.
        # idle-timeout -- pool.idleTimeoutMillis, default 30s.
        # connect-timeout -- connectionTimeout, default 15s.
        # request-timeout -- requestTimeout, default 15s.
        # ca-file -- PEM file tedious verifies the server against.
      }

      libsql {
        url = ""
        auth-token = ""               # prefer \${?TURSO_AUTH_TOKEN}
        table = "durable_state"
        auto-create-tables = on
      }

      cloudflare-d1 {
        account-id  = ""
        database-id = ""
        api-token   = ""              # prefer \${?CLOUDFLARE_API_TOKEN}
        base-url    = "https://api.cloudflare.com/client/v4"
        timeout = 30s                 # the transport's bounds; see the journal's block
        max-response-bytes = 64M
        table = "durable_state"
        auto-create-tables = on
      }

      # MongoDB durable-state store -- see the journal's mongodb block above.
      mongodb {
        url = ""
        database-name = "actor_ts"
        collection = "durable_state"
        # Deliberately unset, as under the journal's mongodb block:
        # max-pool-size -- maxPoolSize, default 100.
        # min-pool-size -- minPoolSize, default 0.
        # server-selection-timeout -- serverSelectionTimeoutMS, default 30s.
        # connect-timeout -- connectTimeoutMS, default 30s.
        # ca-file -- PEM file read into the driver's ca when the client opens.
      }

      # DynamoDB durable-state store -- see the journal's dynamodb block above.
      # There is no cassandra sibling here at all: no Cassandra durable-state
      # store ships, so this axis is two backends wide where the other two are
      # three.
      dynamodb {
        region   = ""
        endpoint = ""
        table = "actor_ts_durable_state"
        billing-mode = "pay-per-request" # see the journal's dynamodb block
        # provisioned-throughput -- deliberately unset; see the journal's block.
        table-ready-timeout = 30s
        auto-create-tables = on
        # Deliberately unset, as under the journal's dynamodb block:
        # max-attempts -- maxAttempts, default 3.
        # retry-mode -- retryMode, standard or adaptive; default standard.
        # request-timeout -- the request handler's requestTimeout, default none.
        # connection-timeout -- its connectionTimeout, default none.
      }
    }
  }

  sharding {
    number-of-shards = 64
    # Which role hosts shards; "" = unrestricted.  This names the role, it does
    #   NOT give a node one -- that is cluster.roles above (or
    #   ClusterOptions.withRoles), so a role no up member carries places
    #   nothing at all and every message for the type sits in the region buffer.
    role = ""
    rebalance-interval = 2s
    hand-off-timeout = 10s
    # Ceiling on how many shards a rebalance may have IN FLIGHT -- not per tick.
    #   A tick fires every rebalance-interval while a hand-off may run for a
    #   whole hand-off-timeout, so a per-tick cap would still stack them up.
    #   Where both are set the LOWER wins, and a ceiling never floors below 1 --
    #   otherwise a small cluster would stop rebalancing altogether.
    # This bounds only the VOLUNTARY path.  Shards whose region died have no
    #   owner at all and are re-homed immediately, ceiling or not.
    # 0 switches a ceiling off; 0 for both is uncapped, which is what the
    #   default HashAllocationStrategy did -- 42 of these 64 shards move in one
    #   tick when a third node joins, stopping and replaying every entity under
    #   them at once.
    rebalance-absolute-limit = 0     # 0 = no absolute ceiling
    rebalance-relative-limit = 0.1   # fraction of number-of-shards; 0 = no relative ceiling
    # Give every sharded type's coordinator a lease built from
    #   coordination.lease, so only the side holding it allocates shards under
    #   a partition.  Needs coordination.lease.backend: with backend = none, on
    #   is refused when the type starts rather than running unprotected.  A
    #   lease passed with withLease(...) wins, and withUseLease(false) opts one
    #   type out.  Named <system>-sharding-<type>, owned by this node; there is
    #   no lease-name key.
    use-lease = off
    # Retry cadence after a failed coordinator lease acquire, however the
    #   lease arrived.
    acquire-retry-interval = 5s
    remember-entities = false
    passivation-idle = 5m    # idle window before an entity passivates; 0 disables the sweep
    # shard-passivation-idle -- how long a shard may stand empty before it
    #   stops as well.  Deliberately left unset rather than given a value:
    #   unset, it follows passivation-idle, which is what "the shard goes
    #   when its entities do" needs.  Set it (0ms disables) to decouple them.
    max-entities = 0         # 0 = no per-node cap
    # Messages one region holds ACROSS ALL SHARDS while their homes are
    # unknown or handing off; the newest is dead-lettered past the cap.
    # Mind the polarity against max-entities above: here 0 = never buffer.
    buffer-size = 100000
    register-retry-interval = 500ms      # re-send an unacknowledged region Register
    shard-region-query-timeout = 5s      # default wait for shards() / shardRefFor()
    # How remembered entities come back after a region is handed a shard.
    #   all           -- every one at once, the moment the registry arrives.
    #   constant-rate -- number-of-entities per frequency, ACROSS ALL SHARDS
    #                    this region owns, until the backlog is drained.
    # The budget is region-wide, like buffer-size and max-entities above: read
    #   per shard it would silently mean number-of-shards times itself.
    # It paces entity STARTS.  A replay is asynchronous, so one outlasting the
    #   window still overlaps the next batch -- the number of replays in flight
    #   is bounded in the persistence layer, not here.
    entity-recovery {
      strategy = all
      constant-rate.frequency = 100ms
      constant-rate.number-of-entities = 5
    }
    # A backstop for a region that went silent while its node is still a
    #   member.  A node's shards are re-homed once the node is removed -- by a
    #   split-brain strategy, by cluster.failure-detector.auto-down = on at
    #   down-after (5s), or by Cluster.down -- and a region stopped cleanly
    #   sends its own notification.  What neither covers is a region gone or
    #   wedged on a node that is STILL UP and gossiping: that notification is
    #   single-shot and its send error is swallowed on the way down, and THAT
    #   is the hole here.  A crashed node nothing removes stays a member too,
    #   parked at unreachable, and this sweep treats its silent regions like
    #   any other.
    # Off by default because eviction is destructive: every entity under every
    #   shard the region held is stopped and re-created elsewhere.
    # enabled drives BOTH halves -- off, no region beats and no coordinator
    #   sweeps, so the mechanism costs nothing at all until it is asked for.
    #   Turn it on everywhere: a region that does not beat is never swept, so a
    #   half-rolled deployment degrades to "not yet armed" rather than to a
    #   loop of evictions.
    # The beat is PER SHARDED TYPE, not per node -- N types cost N frames per
    #   heartbeat-interval per node, on top of the cluster's own heartbeats.
    # stale-after must exceed heartbeat-interval, and by more than one beat:
    #   at four intervals a single dropped frame is not a verdict.  There is no
    #   check-interval -- the sweep rides the rebalance-interval tick above,
    #   which is already the dial for "how often does the coordinator look at
    #   the shard map".
    stale-region-detection {
      enabled = off
      heartbeat-interval = 5s   # region -> coordinator beat
      stale-after = 20s         # silence after which a region is declared gone
    }
    # HOW the max-entities cap above chooses, not WHETHER it applies -- every
    #   key here is inert while max-entities = 0, which is the shipped default.
    #   passivation-idle and max-entities keep their own paths on purpose: they
    #   are a window and a bound, this block is a policy, and aliasing either
    #   into here would mean two leaves feeding one field.
    # replacement:
    #   least-recently-used            -- the entity untouched longest.  Default,
    #                                     and what every release before this did.
    #   segmented-least-recently-used  -- probation for entities seen once,
    #                                     protected for entities seen again;
    #                                     evicts from probation first.  Plain LRU
    #                                     cannot tell "touched once, ever" from
    #                                     "touched constantly until a moment ago",
    #                                     so a scan over cold ids evicts a hot
    #                                     working set one entity at a time.
    #   least-frequently-used          -- fewest accesses, counts halved
    #                                     periodically so the ranking follows
    #                                     recent traffic rather than a lifetime.
    # admission-window-proportion reserves a probationary slice of the cap for
    #   brand-new entities.  It is what makes a filter expressible at all: a
    #   region cannot refuse the entity a message has just arrived for, so the
    #   candidate judged against the incumbent is whatever falls out of the
    #   window's far end.  admission-filter = frequency-sketch therefore REQUIRES
    #   a window > 0 and is rejected without one, rather than silently doing
    #   nothing.
    passivation {
      replacement = least-recently-used
      segmented-protected-proportion = 0.8  # rest is probation; segmented-... only
      admission-window-proportion = 0.0     # 0 = no probationary window
      admission-filter = off                # off | frequency-sketch
      # How long an entity may take to act on the stop-message a Passivate sent
      #   it before the shard stops it outright.  Ships OFF: the stop-message is
      #   a request, and an entity mid-drain -- a long flush, a slow final write
      #   -- is entitled to take as long as the drain takes, so the bound is for
      #   the operator who knows the drain to set.  Independent of max-entities:
      #   a positive value arms the backstop with or without a cap.  Unset, an
      #   entity that never acts on the message never terminates and holds its
      #   slot against max-entities for the life of the node.
      stop-timeout = 0ms
    }
  }

  # A daemon set is a module built ON sharding, not a sharding tunable, so it
  # gets a block of its own -- the same reading distributed-data above states
  # for not living under cluster.*.  Only these two keys are deployment facts;
  # the set's name, its daemon count and its per-index actor describe one
  # daemon set rather than a deployment and have no leaf at all.
  sharded-daemon-process {
    # Safety net for the event-driven wake-up path: every liveness-interval,
    #   every daemon index is re-woken whether or not a topology event fired,
    #   so a wake-up lost to a brief partition-and-heal still re-materialises
    #   its daemon.  LeaderChanged / MemberRemoved still re-wake on their own;
    #   this only covers the one they missed.  0 disables the ping.
    liveness-interval = 30s
    # Which role hosts the daemons.  "" is NOT "unrestricted" here -- it is "no
    #   daemon-specific opinion", and the daemon region then falls through to
    #   sharding.role like every other sharded type.  Name a role here to place
    #   ONLY the daemons on it and leave the rest to sharding.role.  Like that
    #   key this one names a role and never grants one, so a role no up member
    #   carries places no daemon at all.
    role = ""
  }

  devtools {
    # DevTools never starts from configuration -- nothing in ActorSystem
    # constructs the extension, and DevTools.attach(system) is always a code
    # call.  This block fills in the fields that call leaves unset.
    host = "127.0.0.1"
    port = 9333            # 0 lets the OS pick; the binding reports which
    # A routable host needs a gate.  auth and ipAllowlist are middleware and
    # have no HOCON form, so this acknowledgement is the only config-side
    # answer to the host rule -- and it sits beside the host that needs it.
    #
    # Two acknowledgements are deliberately NOT settable here.
    # allow-ungated-mount states a fact about the code that binds mount()'s
    # routes, not about a deployment; allow-message-sending is the one
    # DevTools capability that WRITES into the running system from a
    # browser.  Both stay code-only, next to the call they qualify.
    allow-remote = false
    serve-ui = true
    # Extra origins allowed to open the tap socket.  Same-origin is always
    # accepted; this only widens, for a UI served from somewhere else.
    allowed-origins = []

    # A panel switched off here is off for good -- its data never leaves the
    # process, whatever a client asks for.  tracing, time-travel,
    # dead-letters and event-stream are the four that surface message
    # payloads.  An explicit panels object in code overrides these switch by
    # switch, not wholesale.
    panels {
      actors = true
      cluster = true
      tracing = true
      explain = true
      time-travel = true
      profiler = true
      dead-letters = true
      event-stream = true
      config = true
      send = true
    }

    mailbox-sample-interval = 1s     # actor tree + mailbox/cell resampling
    mailbox-sample-limit = 50        # mailboxes one sample carries
    stats-interval = 1s              # dashboard figures
    span-buffer-capacity = 10000     # retained spans, in messages
    span-flush-interval = 250ms
    # false leaves the tracing panel running -- spans, timings, flame graph
    # -- and empties only its Payload column, where panels.tracing = false
    # takes the whole panel.  For a shared box whose DevTools port more
    # people can reach than the message bodies should be.  A capture the
    # application set for itself is untouched either way.
    capture-payloads = true
    event-buffer-capacity = 500      # events buffered between flushes
    event-flush-interval = 250ms
    replay-auto-capture = true       # borrow onEvent from a running actor
  }

  # Actors on worker threads from configuration alone.  workers above zero
  # starts a worker mesh in the background and moves every top-level user
  # actor whose path matches offload onto a worker; the application code
  # does not change.  0 is today's single-threaded system, bit for bit.
  # The actor module -- the file exporting the classes a worker may spawn --
  # is code, never a leaf here: by convention actors.js next to the entry
  # module, otherwise ParallelismOptions.withModule(...).  Hostnames, roles,
  # ports and restart pacing of the threads are the worker-mesh and
  # worker-cluster blocks below.
  parallelism {
    workers = 0                      # 0 = off | N | "auto" = available parallelism minus the main thread
    offload = ["/user/*"]            # path patterns; * = one segment, ** = any depth; /system is refused
    placement = "consistent-hash"    # consistent-hash (by actor name) | round-robin
    leader = "main"                  # main | worker -- who hosts the shard coordinator and role-less singletons
    spawn-timeout = 10s              # a worker's acknowledgment of a spawn; then the ref fails
    buffer-size = 100000             # messages held across every spawn still awaiting its worker
  }

  # Pure functions on worker threads (OffloadPool, context.offload).  A task
  # is a named export of a module -- code, so the module is named in code,
  # never here -- and its arguments and result are structured-cloned.  The
  # single-threaded runtime's blocking dispatcher: an await in a handler
  # yields the loop and parallelises nothing, this does.
  offload-pool {
    size = "auto"            # workers at most; "auto" = available parallelism minus the main thread
    min-size = 0             # workers kept alive through idleness
    max-queue = 10000        # tasks waiting for a worker before overflow decides
    overflow = "reject"      # reject (OffloadQueueFullError) | wait (back-pressure)
    idle-timeout = 60s       # a worker beyond min-size with nothing to do is retired after this
    task-timeout = 0s        # 0 = no deadline unless run() names one; a deadline terminates the worker
    max-restarts = 10        # worker terminations (crash, deadline) replaced inside restart-window; -1 = forever
    restart-window = 60s
    warm-up = off            # spawn every worker at start instead of on the first task that needs it
  }

  worker-cluster {
    workers = "auto"   # "auto" uses navigator.hardwareConcurrency
    system-name = "worker-cluster"   # ActorSystem name each worker hosts
    hostname = "worker"              # host component of each worker's address
    base-port = 1                    # first worker's port; each slot increments
    ready-timeout = 10s              # per-worker hello/init/ready handshake
    restart-policy = "on-failure"   # always | on-failure | never

    # Respawn pacing for a crashed slot: the delay starts at
    # restart-min-backoff and doubles per attempt up to restart-max-backoff,
    # with +/- restart-random-factor jitter so sibling slots do not
    # synchronise.
    restart-min-backoff = 200ms
    restart-max-backoff = 10s
    restart-random-factor = 0.2
    # Restarts granted per slot inside restart-window before it is retired
    # for good; -1 restarts forever.  A window of 0 never resets the tally.
    max-restarts = 10
    restart-window = 60s
  }

  # The main thread as a member of its own worker mesh (WorkerMesh).  The
  # actor module and the bootstrap are set in code, never here: a config file
  # must not decide which code a worker runs.  Restart pacing and the ready
  # timeout are the worker-cluster block's above.
  worker-mesh {
    workers = "auto"          # "auto" = available parallelism minus the main thread, at least 1
    main-hostname = "main"    # host component of the main thread's address; sorts before the workers', so main leads
    main-port = 1             # port component of the main thread's address (synthetic, nothing binds it)
    worker-hostname = "worker"
    base-port = 2             # first worker's port; each slot increments
    main-roles = []           # cluster roles the main thread joins with
    worker-roles = []         # cluster roles every worker joins with
    # The main thread pulls every worker's metrics registry into its own
    # /metrics this often; the series carry thread="main" | "worker-<slot>".
    # 0 switches the relay off and exports the main thread alone.
    metrics-relay-interval = 10s
  }

  coordinated-shutdown {
    default-phase-timeout = 5s
    terminate-actor-system = true
    exit-process = false   # call process.exit(exit-code) once the pipeline completes
    # Status that exit carries.  Only consulted when exit-process is on; a
    # value outside 0-255 is a ConfigError at startup rather than a code the
    # operating system silently truncates.
    exit-code = 0

    # Framework components register their own teardown in the pipeline: the
    # HTTP server unbinds in service-unbind, broker actors close their
    # connections in service-stop, a joined cluster leaves in cluster-leave,
    # DevTools detaches with the rest of the service layer.  Set false to keep
    # the phases and register everything yourself -- for an embedder that owns
    # the lifecycle of the resources it handed the system.
    auto-register-tasks = true

    # Whether runUntilTerminated() and the cluster bootstrap arm SIGTERM and
    # SIGINT on your behalf.  false leaves the pipeline in place and the
    # signals to the host process that owns them.  What this switches is the
    # *default*: a caller that names its signals -- runUntilTerminated(['SIGTERM']),
    # shutdown-on-signals in the bootstrap options -- still installs them,
    # because explicit options outrank config.
    run-by-process-signals = true

    # phases ships no values on purpose: its children are named after YOUR
    # phases, so there is no fixed set of leaves to publish, and an example
    # one would freeze that example's budget into every deployment's
    # effective config.  Each child takes timeout, recover and depends-on,
    # all optional:
    #
    #   phases {
    #     service-requests-done { timeout = 30s }
    #     actor-system-terminate { timeout = 60s }
    #     flush-metrics {
    #       timeout    = 3s
    #       recover    = false
    #       depends-on = ["before-actor-system-terminate"]
    #     }
    #   }
    #
    # A child naming one of the twelve canonical phases merges into it; any
    # other name declares a new phase, and there depends-on is required --
    # a phase with no edges sorts into the first batch and would run before
    # before-service-unbind.  depends-on on a canonical phase is ADDED to
    # the edge it already has, never a replacement, so a config file cannot
    # re-parent cluster-leave ahead of service-unbind.
  }
}
`.trim();
