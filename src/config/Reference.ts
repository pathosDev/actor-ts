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
        max-chunk-bytes = 1420     # udp only: datagram size before chunking
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
  }

  mailbox {
    # A bound every actor under /user gets without touching its spawn site.
    #
    # Off by default, and "off" is the shipped behaviour rather than a tuned
    # number: since #1148 a mailbox is unbounded unless somebody asks for a
    # ceiling.  So setting a capacity here does not retune an existing bound,
    # it introduces message loss for every application actor at once.  Read
    # docs -> Operate -> Tuning -> Mailbox sizing before turning it on.
    #
    # The bound reaches strict descendants of /user only.  The framework's
    # own actors live under /system — shard regions, the pub-sub mediator,
    # the reliable-delivery producer, the DevTools hub — and shedding their
    # traffic would break invariants the application never sees.  A spawn
    # site that names its own mailbox still wins, in both directions:
    # withMailboxCapacity() overrides the capacity, withMailbox() replaces
    # the queue outright.
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
  }

  cluster {
    gossip-interval = 1s
    seed-retry-interval = 3s
    weakly-up-after = 0s   # 0 disables auto weakly-up promotion

    # Caps on the local member map.  max-frame-bytes bounds ONE gossip frame;
    # these bound what a sequence of well-formed frames can accumulate, since
    # gossip is what introduces addresses in the first place.  0 disables
    # either.  max-tombstones is the load-bearing one: a tombstone carries no
    # liveness, so nothing but the TTL below ever reclaims it.
    max-members = 1000
    max-tombstones = 10000

    tombstone {
      time-to-live   = 24h
      prune-interval = 5m
      min-retention  = 0s   # 0 = derive from failure-detector down-after
    }

    # Which split-brain resolver arbitrates a partition.  off = none, and the
    # failure detector then evicts an unreachable peer on its own once
    # down-after elapses -- which every side of a partition does at the same
    # moment, so the cluster forks instead of losing a side.  Naming a strategy
    # here builds the provider withDowning(...) takes in code, and an explicit
    # withDowning(...) still wins over this block.
    #
    # lease-majority is deliberately NOT selectable: LeaseMajority arbitrates
    # through a live Lease whose owner is this node's own address, and no key
    # can name one.  Build it in code -- withDowning(new LeaseMajority(...)).
    split-brain-resolver {
      active-strategy = off   # off | keep-majority | keep-oldest | keep-referee | static-quorum

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
        acceptable-heartbeat-pause = 0s   # grace added to the last heartbeat before phi rises
      }
    }

    # Stable-observation bootstrap: poll discovery until the contact-point set
    # has been unchanged for stable-margin, then let the lowest-addressed node
    # -- and only it -- form a cluster if no peer promoted it within
    # self-election-grace.  Opt-in: bootstrapCluster reads this block only when
    # its stableObservation option is set.  required-contact-points is the one
    # knob worth changing: 1 keeps single-node development working, but only a
    # value matching the expected replica count catches discovery that is
    # stably wrong rather than merely slow.
    bootstrap {
      stable-margin           = 5s
      poll-interval           = 1s
      max-wait                = 60s
      required-contact-points = 1
      self-election-grace     = 10s

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
    # Bind address of this node.  Cluster.join reads these when its options
    # leave host/port unset, so a deployment can move the address into config.
    #
    # host is the interface to BIND, and the wildcard below is the right
    # default for it.  It is not an identity: what peers dial is
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
    tcp {
      host = "0.0.0.0"
      port = 2552
    }
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
  }

  # Lease coordination -- what a Lease backend reads when it is built with
  # settings a deployment owns rather than the application source.  Nothing in
  # the framework constructs a Lease for you: every withLease(...) slot takes an
  # instance, so these values layer UNDER the options passed to
  # new InMemoryLease(...) / new KubernetesLease(...) instead of standing in for
  # them.  Precedence is the usual one -- explicit options win, this block is
  # next, the built-in defaults are last.
  coordination {
    lease {
      # ttl -- deliberately unset.  A lease is constructed with an explicit
      # ttlMs and the constructor rejects a missing one (#596); a shipped value
      # here would supply it for every lease in the process and make that guard
      # unreachable.  Set it to give a whole deployment one TTL:
      #
      #   ttl = 30s
      #
      # renewal-interval -- deliberately unset as well.  Unset selects
      # max(500ms, ttl/3), which is the computed default both backends want,
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
        # and the in-flight guard drops the one that overlaps.
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
  # and ReliableDelivery.consumer.  These four layer UNDER whatever those two
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
      # whose round-trip dominates.  Keep it under the consumer's out-of-order
      # retention (1024, not settable here), which is what stalls a producer
      # that runs ahead of a gap.
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
    }
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

    # drain-grace is deliberately absent.  Its default is min(50ms, min-backoff)
    # — derived from another leaf in this block — so a published literal would
    # freeze 50ms for a supervisor whose min-backoff is smaller, and lengthen
    # the grace past the backoff window it is meant to sit inside.  Set
    # drainGraceMs in code where the min-backoff it depends on is also in view.
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
    }
    snapshot-store {
      plugin = "actor-ts.persistence.snapshot-store.in-memory"

      # Local SQLite snapshot store -- see the journal's sqlite block above.
      sqlite {
        path = ""                     # "" = not set; an in-memory database per handle
        snapshots-table = "snapshots"
        keep-n = 3                    # snapshots kept per persistenceId; 0 disables pruning
        busy-timeout = 1s
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
    }
  }

  sharding {
    number-of-shards = 64
    # Which role hosts shards; "" = unrestricted.  This names the role, it does
    #   NOT give a node one -- a node's own roles stay code-only
    #   (ClusterOptions.withRoles), so a role no up member carries places
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
    # Retry cadence after a failed coordinator lease acquire.  Only observable
    #   where a Lease was passed in code: HOCON cannot name one, and there is
    #   deliberately no use-lease switch to pretend otherwise.
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
    # A backstop for a region that is gone or wedged on a node that is STILL UP
    #   and gossiping -- the one case nothing else covers.  A node that stops
    #   gossiping is force-downed by the failure detector in
    #   cluster.failure-detector.down-after (5s) and its shards are re-homed
    #   from there, which is 4x faster than this; and a region stopped cleanly
    #   sends its own notification.  That notification is single-shot and its
    #   send error is swallowed on the way down, and THAT is the hole here.
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
    # process, whatever a client asks for.  time-travel, dead-letters and
    # event-stream are the three that surface message payloads.  An explicit
    # panels object in code overrides these switch by switch, not wholesale.
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
    event-buffer-capacity = 500      # events buffered between flushes
    event-flush-interval = 250ms
    replay-auto-capture = true       # borrow onEvent from a running actor
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
