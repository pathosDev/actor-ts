import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { isPlainObject, parseHocon } from '../../../src/config/HoconParser.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import {
  DEFAULT_ACTOR_THROUGHPUT,
  DEFAULT_DISPATCHER_THROUGHPUT,
  DEFAULT_PHASE_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
} from '../../../src/Constants.js';
import { DEFAULT_GOSSIP_INTERVAL_MS } from '../../../src/util/Constants.js';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from '../../../src/cluster/Constants.js';
import { defaultFailureDetectorOptions } from '../../../src/cluster/FailureDetector.js';
import {
  DEFAULT_DEAD_LETTER_MAX_ENTRIES,
  DEFAULT_DEAD_LETTER_MAX_REPLAYS,
  DEFAULT_DEAD_LETTER_RETENTION_MS,
  DEFAULT_DEAD_LETTER_STORE,
} from '../../../src/deadletters/DeadLetterQueueOptions.js';
import { DEFAULT_LOG_DEAD_LETTERS, DEFAULT_LOG_DEAD_LETTERS_DURING_SHUTDOWN, DEFAULT_LOG_DEAD_LETTERS_SUSPEND_DURATION_MS } from '../../../src/diagnostics/DiagnosticsOptions.js';
import { DEFAULT_WEBSOCKET_POLICY } from '../../../src/http/websocket/WebsocketPolicy.js';
import { DEFAULT_WORKER_RESTART_POLICY } from '../../../src/worker/WorkerClusterOptions.js';
import { DEFAULT_MAX_RESTARTS, DEFAULT_RESTART_MAX_BACKOFF_MS, DEFAULT_RESTART_MIN_BACKOFF_MS, DEFAULT_RESTART_RANDOM_FACTOR, DEFAULT_RESTART_WINDOW_MS, DEFAULT_WORKER_BASE_PORT, DEFAULT_WORKER_HOSTNAME, DEFAULT_WORKER_READY_TIMEOUT_MS, DEFAULT_WORKER_SYSTEM_NAME } from '../../../src/worker/WorkerClusterOptions.js';
import {
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REQUIRED_CONTACT_POINTS,
  DEFAULT_SELF_ELECTION_GRACE_MS,
  DEFAULT_STABLE_MARGIN_MS,
} from '../../../src/cluster/bootstrap/StableObservationOptions.js';
import { DEFAULT_MINIMUM_MEMBERS } from '../../../src/cluster/ClusterReadiness.js';
import {
  DEFAULT_MAX_MEMBERS,
  DEFAULT_MAX_TOMBSTONES,
  DEFAULT_SEED_RETRY_INTERVAL_MS,
  DEFAULT_TOMBSTONE_PRUNE_INTERVAL_MS,
  DEFAULT_TOMBSTONE_TTL_MS,
} from '../../../src/cluster/ClusterOptions.js';
import { DEFAULT_PORT } from '../../../src/cluster/ClusterBootstrapOptions.js';
import { DEFAULT_MAX_FRAME_BYTES } from '../../../src/cluster/Protocol.js';
import {
  DEFAULT_MAX_REMOTE_NODES_PER_TOPIC,
  DEFAULT_MAX_SUBSCRIBERS_PER_TOPIC,
  DEFAULT_MAX_TOPICS,
} from '../../../src/cluster/pubsub/DistributedPubSubOptions.js';
import {
  DEFAULT_MAX_SUBSCRIBERS_PER_KEY,
  DEFAULT_MAX_SUBSCRIPTIONS_TOTAL,
} from '../../../src/discovery/ReceptionistOptions.js';
import {
  DEFAULT_NUM_SHARDS,
  DEFAULT_PASSIVATION_IDLE_MS,
  DEFAULT_REGISTER_RETRY_INTERVAL_MS,
  DEFAULT_SHARD_REGION_BUFFER_SIZE,
} from '../../../src/cluster/sharding/ShardingOptions.js';
import {
  DEFAULT_HAND_OFF_TIMEOUT_MS,
  DEFAULT_REBALANCE_INTERVAL_MS,
} from '../../../src/cluster/sharding/ShardCoordinatorOptions.js';
import { DEFAULT_SHARD_REGION_QUERY_TIMEOUT_MS } from '../../../src/cluster/sharding/StartShardingOptions.js';
import {
  DEFAULT_MAX_GOSSIP_BYTES,
  DEFAULT_MAX_PENDING_QUORUM_REQUESTS,
  DEFAULT_MAX_QUORUM_TIMEOUT_MS,
} from '../../../src/crdt/DistributedDataOptions.js';
import {
  DEFAULT_WEBSOCKET_MAX_FRAME_BYTES,
  DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_BYTES,
  DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_FRAMES,
} from '../../../src/http/Constants.js';
import {
  DEFAULT_HTTP_CLIENT_MAX_REDIRECTS,
  DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_CLIENT_REDIRECT_MODE,
  DEFAULT_HTTP_CLIENT_TIMEOUT_MS,
} from '../../../src/http/HttpClientOptions.js';
import { DEFAULT_CLEANUP_MS, DEFAULT_MAX_ENTRIES } from '../../../src/cache/InMemoryCacheOptions.js';
import { DEFAULT_PROJECTION_MAX_RETRIES, DEFAULT_PROJECTION_MAX_RETRY_BACKOFF_MS, DEFAULT_PROJECTION_RECOVERY_STRATEGY, DEFAULT_PROJECTION_RETRY_BACKOFF_MS } from '../../../src/persistence/projection/ProjectionOptions.js';
import { DEFAULT_LIVE_QUERY_POLL_INTERVAL_MS } from '../../../src/persistence/Constants.js';
import { DEFAULT_SINK_CLOSE_TIMEOUT_MS } from '../../../src/logging/MultiSinkLoggerOptions.js';
import {
  DEFAULT_DELIVERY_FLUSH_INTERVAL_MS,
  DEFAULT_DELIVERY_MAX_BATCH_SIZE,
  DEFAULT_DELIVERY_OVERFLOW,
  DEFAULT_DELIVERY_QUEUE_CAPACITY,
} from '../../../src/logging/DeliveryOptions.js';
import {
  DEFAULT_CONSOLE_SINK_FORMAT,
  DEFAULT_CONSOLE_SINK_STREAM,
} from '../../../src/logging/ConsoleSinkOptions.js';
import {
  DEFAULT_FILE_SINK_DIRECTORY,
  DEFAULT_FILE_SINK_EXTENSION,
  DEFAULT_FILE_SINK_FORMAT,
  DEFAULT_FILE_SINK_MAX_AGE_MS,
  DEFAULT_FILE_SINK_MAX_FILES,
  DEFAULT_FILE_SINK_MAX_FILE_BYTES,
  DEFAULT_FILE_SINK_PREFIX,
  DEFAULT_FILE_SINK_ROTATE_INTERVAL,
} from '../../../src/logging/FileSinkOptions.js';
import { DEFAULT_GELF_MAX_CHUNK_BYTES } from '../../../src/logging/GelfChunking.js';
import {
  DEFAULT_GELF_COMPRESSION,
  DEFAULT_GELF_HOST,
  DEFAULT_GELF_PORT,
  DEFAULT_GELF_PROTOCOL,
  DEFAULT_GELF_REQUEST_TIMEOUT_MS,
} from '../../../src/logging/GelfSinkOptions.js';
import { DEFAULT_LOKI_REQUEST_TIMEOUT_MS } from '../../../src/logging/LokiSinkOptions.js';
import {
  DEFAULT_OTLP_REQUEST_TIMEOUT_MS,
  DEFAULT_OTLP_SCOPE_NAME,
  DEFAULT_OTLP_URL,
} from '../../../src/logging/OtlpHttpSinkOptions.js';
import { DEFAULT_PARSEABLE_REQUEST_TIMEOUT_MS } from '../../../src/logging/ParseableSinkOptions.js';
import { DEFAULT_SEQ_REQUEST_TIMEOUT_MS } from '../../../src/logging/SeqSinkOptions.js';
import {
  DEFAULT_SPLUNK_REQUEST_TIMEOUT_MS,
  DEFAULT_SPLUNK_SOURCE,
  DEFAULT_SPLUNK_SOURCETYPE,
} from '../../../src/logging/SplunkSinkOptions.js';
import { DEFAULT_SYSLOG_FACILITY } from '../../../src/logging/SyslogFrame.js';
import {
  DEFAULT_SYSLOG_FRAMING,
  DEFAULT_SYSLOG_HOST,
  DEFAULT_SYSLOG_PORT,
  DEFAULT_SYSLOG_TRANSPORT,
} from '../../../src/logging/SyslogSinkOptions.js';

/**
 * Every default this project documents is written down twice: once as a
 * `DEFAULT_*` constant in `src/`, and once as a HOCON literal in
 * `REFERENCE_CONF`.  This asserts the two agree.
 *
 * The gap it closes is specific.  `ReferenceConfDocs.test.ts` already pins the
 * `reference-conf.mdx` pages byte-for-byte to `REFERENCE_CONF`, and
 * `NoDeadConfigKeys.test.ts` already proves every key is reachable from
 * `ConfigKeys` and read somewhere — but both stop at the same ceiling, which
 * `NoDeadConfigKeys` states in its own words: they prove a *reference*, not a
 * correct *value*.  `REFERENCE_CONF` is a hand-maintained string, so a wrong
 * number typed into it is copied faithfully into both language pages and
 * every existing guard stays green.  That is the drift #470 exists to stop:
 * the published default and the shipped default disagreeing, with nothing
 * that can notice.
 *
 * Chaining it to the byte-pin is what makes this cover the *documentation*
 * rather than just the config: docs == REFERENCE_CONF (proved there) and
 * REFERENCE_CONF == the constants (proved here), so the documented default is
 * the shipped default transitively.
 *
 * Values are read through `Config`, the same loader the runtime uses, rather
 * than through a regex over the string.  A test that re-implements duration
 * and byte parsing can disagree with the parser that actually runs, and then
 * it is asserting its own arithmetic.
 *
 * ## Two halves, and why the second one exists
 *
 * The value assertions below only cover the keys the table names, so on their
 * own they are silent about a key nobody wrote down.  That is not theoretical:
 * this guard landed on 2026-08-16 and the whole `actor-ts.dead-letters.*`
 * block was published the next day with four `DEFAULT_DEAD_LETTER_*` constants
 * behind it and no entry here, and the suite stayed green — because the only
 * completeness check was `DOCUMENTED_DEFAULTS.length >= 70`, a floor a growing
 * table clears by growing.
 *
 * So the second half **partitions** `REFERENCE_CONF`: every leaf must be in
 * the table, in `DELIBERATE_DIVERGENCES`, or in one of the four
 * explicitly-listed unasserted groups below.  A new key is in none of them and
 * fails, which is the point — the author has to decide which it is.  The
 * groups are literal key lists on purpose and not shape predicates: "anything
 * ending in `.enabled`" would have absorbed the next `enabled` key whose
 * constant says `true` while the published default says `false`, which is the
 * very drift being guarded.
 */

/**
 * How to read a key — picks the `Config` accessor that matches its literal.
 *
 * `number` is not a synonym for `int`, and mislabelling a fractional leaf is
 * silent in both directions: `getInt` *throws* on `0.2`, while `duration` and
 * `bytes` return a bare number unchanged, so labelling
 * `restart-random-factor = 0.2` a duration passes while asserting nothing
 * about it being a fraction (#883).
 */
type DefaultKind = 'duration' | 'bytes' | 'int' | 'number' | 'string' | 'bool';

type DocumentedDefault = {
  /** Full dotted HOCON path as it appears in `REFERENCE_CONF`. */
  readonly key: string;
  readonly kind: DefaultKind;
  /**
   * The `DEFAULT_*` constant, imported so a rename is a compile error.
   *
   * `boolean` joined the union with the `bool` kind (#1000).  Before it, a
   * published `off` had nowhere to go but `FEATURE_SWITCHES`, whose stated
   * reason for existing is that its members have *no* constant to disagree
   * with — so a switch that grew one would have been filed under an
   * explanation that no longer applied to it.
   */
  readonly constant: number | string | boolean;
};

/**
 * The seven sinks that batch through `DeliveryOptions` and take its built-in
 * defaults unchanged.  `file` is deliberately absent — see `DELIBERATE_DIVERGENCES`.
 */
const BATCHING_SINKS = ['gelf', 'otlp', 'loki', 'parseable', 'seq', 'splunk', 'syslog'] as const;

const deliveryDefaults: readonly DocumentedDefault[] = BATCHING_SINKS.flatMap((sink) => [
  { key: `actor-ts.logger.sinks.${sink}.delivery.max-batch-size`, kind: 'int', constant: DEFAULT_DELIVERY_MAX_BATCH_SIZE },
  { key: `actor-ts.logger.sinks.${sink}.delivery.flush-interval`, kind: 'duration', constant: DEFAULT_DELIVERY_FLUSH_INTERVAL_MS },
  { key: `actor-ts.logger.sinks.${sink}.delivery.queue-capacity`, kind: 'int', constant: DEFAULT_DELIVERY_QUEUE_CAPACITY },
] satisfies DocumentedDefault[]);

const DOCUMENTED_DEFAULTS: readonly DocumentedDefault[] = [
  /* --- core --- */
  { key: 'actor-ts.actor.throughput', kind: 'int', constant: DEFAULT_ACTOR_THROUGHPUT },
  { key: 'actor-ts.dispatcher.throughput', kind: 'int', constant: DEFAULT_DISPATCHER_THROUGHPUT },
  { key: 'actor-ts.coordinated-shutdown.default-phase-timeout', kind: 'duration', constant: DEFAULT_PHASE_TIMEOUT_MS },
  { key: 'actor-ts.system.shutdown-drain-timeout', kind: 'duration', constant: DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS },

  /* --- cluster --- */
  { key: 'actor-ts.cluster.gossip-interval', kind: 'duration', constant: DEFAULT_GOSSIP_INTERVAL_MS },
  { key: 'actor-ts.cluster.pub-sub.gossip-interval', kind: 'duration', constant: DEFAULT_GOSSIP_INTERVAL_MS },
  { key: 'actor-ts.cluster.receptionist.gossip-interval', kind: 'duration', constant: DEFAULT_GOSSIP_INTERVAL_MS },
  { key: 'actor-ts.distributed-data.gossip-interval', kind: 'duration', constant: DEFAULT_GOSSIP_INTERVAL_MS },
  { key: 'actor-ts.cluster.failure-detector.heartbeat-interval', kind: 'duration', constant: DEFAULT_HEARTBEAT_INTERVAL_MS },
  { key: 'actor-ts.cluster.failure-detector.unreachable-after', kind: 'duration', constant: defaultFailureDetectorOptions.unreachableAfterMs },
  { key: 'actor-ts.cluster.failure-detector.down-after', kind: 'duration', constant: defaultFailureDetectorOptions.downAfterMs },
  { key: 'actor-ts.cluster.seed-retry-interval', kind: 'duration', constant: DEFAULT_SEED_RETRY_INTERVAL_MS },
  { key: 'actor-ts.cluster.max-members', kind: 'int', constant: DEFAULT_MAX_MEMBERS },
  { key: 'actor-ts.cluster.max-tombstones', kind: 'int', constant: DEFAULT_MAX_TOMBSTONES },
  { key: 'actor-ts.cluster.tombstone.time-to-live', kind: 'duration', constant: DEFAULT_TOMBSTONE_TTL_MS },
  { key: 'actor-ts.cluster.tombstone.prune-interval', kind: 'duration', constant: DEFAULT_TOMBSTONE_PRUNE_INTERVAL_MS },

  /* --- cluster bootstrap --- */
  { key: 'actor-ts.cluster.bootstrap.poll-interval', kind: 'duration', constant: DEFAULT_POLL_INTERVAL_MS },
  { key: 'actor-ts.cluster.bootstrap.stable-margin', kind: 'duration', constant: DEFAULT_STABLE_MARGIN_MS },
  { key: 'actor-ts.cluster.bootstrap.max-wait', kind: 'duration', constant: DEFAULT_MAX_WAIT_MS },
  { key: 'actor-ts.cluster.bootstrap.self-election-grace', kind: 'duration', constant: DEFAULT_SELF_ELECTION_GRACE_MS },
  { key: 'actor-ts.cluster.bootstrap.required-contact-points', kind: 'int', constant: DEFAULT_REQUIRED_CONTACT_POINTS },
  // `await-ready` is comment-only in reference.conf (unset selects the
  // grace-aware computed default, #1086) — no leaf, so nothing to assert.
  { key: 'actor-ts.cluster.bootstrap.minimum-members', kind: 'int', constant: DEFAULT_MINIMUM_MEMBERS },

  /* --- remote --- */
  { key: 'actor-ts.remote.tcp.port', kind: 'int', constant: DEFAULT_PORT },
  { key: 'actor-ts.remote.max-frame-bytes', kind: 'bytes', constant: DEFAULT_MAX_FRAME_BYTES },

  /* --- pub-sub / receptionist --- */
  { key: 'actor-ts.cluster.pub-sub.max-subscribers-per-topic', kind: 'int', constant: DEFAULT_MAX_SUBSCRIBERS_PER_TOPIC },
  { key: 'actor-ts.cluster.pub-sub.max-topics', kind: 'int', constant: DEFAULT_MAX_TOPICS },
  { key: 'actor-ts.cluster.pub-sub.max-remote-nodes-per-topic', kind: 'int', constant: DEFAULT_MAX_REMOTE_NODES_PER_TOPIC },
  { key: 'actor-ts.cluster.receptionist.max-subscribers-per-key', kind: 'int', constant: DEFAULT_MAX_SUBSCRIBERS_PER_KEY },
  { key: 'actor-ts.cluster.receptionist.max-subscriptions-total', kind: 'int', constant: DEFAULT_MAX_SUBSCRIPTIONS_TOTAL },

  /* --- sharding --- */
  { key: 'actor-ts.sharding.number-of-shards', kind: 'int', constant: DEFAULT_NUM_SHARDS },
  { key: 'actor-ts.sharding.passivation-idle', kind: 'duration', constant: DEFAULT_PASSIVATION_IDLE_MS },
  { key: 'actor-ts.sharding.rebalance-interval', kind: 'duration', constant: DEFAULT_REBALANCE_INTERVAL_MS },
  { key: 'actor-ts.sharding.hand-off-timeout', kind: 'duration', constant: DEFAULT_HAND_OFF_TIMEOUT_MS },
  { key: 'actor-ts.sharding.buffer-size', kind: 'int', constant: DEFAULT_SHARD_REGION_BUFFER_SIZE },
  { key: 'actor-ts.sharding.register-retry-interval', kind: 'duration', constant: DEFAULT_REGISTER_RETRY_INTERVAL_MS },
  { key: 'actor-ts.sharding.shard-region-query-timeout', kind: 'duration', constant: DEFAULT_SHARD_REGION_QUERY_TIMEOUT_MS },

  /* --- distributed data --- */
  { key: 'actor-ts.distributed-data.max-pending-quorum-requests', kind: 'int', constant: DEFAULT_MAX_PENDING_QUORUM_REQUESTS },
  { key: 'actor-ts.distributed-data.max-quorum-timeout', kind: 'duration', constant: DEFAULT_MAX_QUORUM_TIMEOUT_MS },
  { key: 'actor-ts.distributed-data.max-gossip-bytes', kind: 'bytes', constant: DEFAULT_MAX_GOSSIP_BYTES },

  /* --- dead letters --- */
  { key: 'actor-ts.dead-letters.store', kind: 'string', constant: DEFAULT_DEAD_LETTER_STORE },
  { key: 'actor-ts.dead-letters.max-entries', kind: 'int', constant: DEFAULT_DEAD_LETTER_MAX_ENTRIES },
  { key: 'actor-ts.dead-letters.retention', kind: 'duration', constant: DEFAULT_DEAD_LETTER_RETENTION_MS },
  { key: 'actor-ts.dead-letters.max-replays', kind: 'int', constant: DEFAULT_DEAD_LETTER_MAX_REPLAYS },

  /* --- diagnostics --- */
  { key: 'actor-ts.diagnostics.log-dead-letters', kind: 'int', constant: DEFAULT_LOG_DEAD_LETTERS },
  { key: 'actor-ts.diagnostics.log-dead-letters-during-shutdown', kind: 'bool', constant: DEFAULT_LOG_DEAD_LETTERS_DURING_SHUTDOWN },
  { key: 'actor-ts.diagnostics.log-dead-letters-suspend-duration', kind: 'duration', constant: DEFAULT_LOG_DEAD_LETTERS_SUSPEND_DURATION_MS },

  /* --- worker cluster --- */
  { key: 'actor-ts.worker-cluster.system-name', kind: 'string', constant: DEFAULT_WORKER_SYSTEM_NAME },
  { key: 'actor-ts.worker-cluster.hostname', kind: 'string', constant: DEFAULT_WORKER_HOSTNAME },
  { key: 'actor-ts.worker-cluster.base-port', kind: 'int', constant: DEFAULT_WORKER_BASE_PORT },
  { key: 'actor-ts.worker-cluster.ready-timeout', kind: 'duration', constant: DEFAULT_WORKER_READY_TIMEOUT_MS },
  { key: 'actor-ts.worker-cluster.restart-policy', kind: 'string', constant: DEFAULT_WORKER_RESTART_POLICY },
  { key: 'actor-ts.worker-cluster.restart-min-backoff', kind: 'duration', constant: DEFAULT_RESTART_MIN_BACKOFF_MS },
  { key: 'actor-ts.worker-cluster.restart-max-backoff', kind: 'duration', constant: DEFAULT_RESTART_MAX_BACKOFF_MS },
  { key: 'actor-ts.worker-cluster.restart-random-factor', kind: 'number', constant: DEFAULT_RESTART_RANDOM_FACTOR },
  { key: 'actor-ts.worker-cluster.max-restarts', kind: 'int', constant: DEFAULT_MAX_RESTARTS },
  { key: 'actor-ts.worker-cluster.restart-window', kind: 'duration', constant: DEFAULT_RESTART_WINDOW_MS },

  /* --- http --- */
  { key: 'actor-ts.http.websocket.max-frame-bytes', kind: 'bytes', constant: DEFAULT_WEBSOCKET_MAX_FRAME_BYTES },
  { key: 'actor-ts.http.websocket.max-buffered-bytes', kind: 'bytes', constant: DEFAULT_WEBSOCKET_POLICY.maxBufferedBytes },
  { key: 'actor-ts.http.websocket.on-oversize-frame', kind: 'string', constant: DEFAULT_WEBSOCKET_POLICY.onOversizeFrame },
  { key: 'actor-ts.http.websocket.on-invalid-message', kind: 'string', constant: DEFAULT_WEBSOCKET_POLICY.onInvalidMessage },
  { key: 'actor-ts.http.websocket.on-backpressure', kind: 'string', constant: DEFAULT_WEBSOCKET_POLICY.onBackpressure },
  { key: 'actor-ts.http.websocket.max-pre-attach-frames', kind: 'int', constant: DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_FRAMES },
  { key: 'actor-ts.http.websocket.max-pre-attach-bytes', kind: 'bytes', constant: DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_BYTES },
  { key: 'actor-ts.http.websocket.accept-timeout', kind: 'duration', constant: DEFAULT_WEBSOCKET_POLICY.acceptTimeoutMs },
  { key: 'actor-ts.http.client.default-timeout', kind: 'duration', constant: DEFAULT_HTTP_CLIENT_TIMEOUT_MS },
  { key: 'actor-ts.http.client.max-redirects', kind: 'int', constant: DEFAULT_HTTP_CLIENT_MAX_REDIRECTS },
  { key: 'actor-ts.http.client.max-response-bytes', kind: 'bytes', constant: DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES },
  { key: 'actor-ts.http.client.redirect', kind: 'string', constant: DEFAULT_HTTP_CLIENT_REDIRECT_MODE },

  /* --- cache --- */
  { key: 'actor-ts.cache.in-memory.max-entries', kind: 'int', constant: DEFAULT_MAX_ENTRIES },
  // `duration`, not `int`: #1405 republished this as `60s`, which `getInt`
  // rejects outright.  `DEFAULT_CLEANUP_MS` is unchanged — only the accessor
  // that has to read the literal moved.
  { key: 'actor-ts.cache.in-memory.cleanup-interval', kind: 'duration', constant: DEFAULT_CLEANUP_MS },

  /* --- projection --- */
  { key: 'actor-ts.projection.recovery-strategy', kind: 'string', constant: DEFAULT_PROJECTION_RECOVERY_STRATEGY },
  { key: 'actor-ts.projection.max-retries', kind: 'int', constant: DEFAULT_PROJECTION_MAX_RETRIES },
  { key: 'actor-ts.projection.retry-backoff', kind: 'duration', constant: DEFAULT_PROJECTION_RETRY_BACKOFF_MS },
  { key: 'actor-ts.projection.max-retry-backoff', kind: 'duration', constant: DEFAULT_PROJECTION_MAX_RETRY_BACKOFF_MS },
  { key: 'actor-ts.projection.poll-interval', kind: 'duration', constant: DEFAULT_LIVE_QUERY_POLL_INTERVAL_MS },

  /* --- logging: pipeline --- */
  { key: 'actor-ts.logger.close-timeout', kind: 'duration', constant: DEFAULT_SINK_CLOSE_TIMEOUT_MS },
  ...deliveryDefaults,
  { key: 'actor-ts.logger.sinks.file.delivery.queue-capacity', kind: 'int', constant: DEFAULT_DELIVERY_QUEUE_CAPACITY },
  { key: 'actor-ts.logger.sinks.file.delivery.overflow', kind: 'string', constant: DEFAULT_DELIVERY_OVERFLOW },

  /* --- logging: console + file sinks --- */
  { key: 'actor-ts.logger.sinks.console.format', kind: 'string', constant: DEFAULT_CONSOLE_SINK_FORMAT },
  { key: 'actor-ts.logger.sinks.console.stream', kind: 'string', constant: DEFAULT_CONSOLE_SINK_STREAM },
  { key: 'actor-ts.logger.sinks.file.directory', kind: 'string', constant: DEFAULT_FILE_SINK_DIRECTORY },
  { key: 'actor-ts.logger.sinks.file.prefix', kind: 'string', constant: DEFAULT_FILE_SINK_PREFIX },
  { key: 'actor-ts.logger.sinks.file.extension', kind: 'string', constant: DEFAULT_FILE_SINK_EXTENSION },
  { key: 'actor-ts.logger.sinks.file.format', kind: 'string', constant: DEFAULT_FILE_SINK_FORMAT },
  { key: 'actor-ts.logger.sinks.file.rotate-interval', kind: 'string', constant: DEFAULT_FILE_SINK_ROTATE_INTERVAL },
  { key: 'actor-ts.logger.sinks.file.max-file-bytes', kind: 'bytes', constant: DEFAULT_FILE_SINK_MAX_FILE_BYTES },
  { key: 'actor-ts.logger.sinks.file.max-files', kind: 'int', constant: DEFAULT_FILE_SINK_MAX_FILES },
  { key: 'actor-ts.logger.sinks.file.max-age', kind: 'duration', constant: DEFAULT_FILE_SINK_MAX_AGE_MS },

  /* --- logging: network sinks --- */
  { key: 'actor-ts.logger.sinks.gelf.protocol', kind: 'string', constant: DEFAULT_GELF_PROTOCOL },
  { key: 'actor-ts.logger.sinks.gelf.host', kind: 'string', constant: DEFAULT_GELF_HOST },
  { key: 'actor-ts.logger.sinks.gelf.port', kind: 'int', constant: DEFAULT_GELF_PORT },
  { key: 'actor-ts.logger.sinks.gelf.compression', kind: 'string', constant: DEFAULT_GELF_COMPRESSION },
  { key: 'actor-ts.logger.sinks.gelf.max-chunk-bytes', kind: 'int', constant: DEFAULT_GELF_MAX_CHUNK_BYTES },
  { key: 'actor-ts.logger.sinks.gelf.request-timeout', kind: 'duration', constant: DEFAULT_GELF_REQUEST_TIMEOUT_MS },
  { key: 'actor-ts.logger.sinks.loki.request-timeout', kind: 'duration', constant: DEFAULT_LOKI_REQUEST_TIMEOUT_MS },
  { key: 'actor-ts.logger.sinks.otlp.url', kind: 'string', constant: DEFAULT_OTLP_URL },
  { key: 'actor-ts.logger.sinks.otlp.scope-name', kind: 'string', constant: DEFAULT_OTLP_SCOPE_NAME },
  { key: 'actor-ts.logger.sinks.otlp.request-timeout', kind: 'duration', constant: DEFAULT_OTLP_REQUEST_TIMEOUT_MS },
  { key: 'actor-ts.logger.sinks.parseable.request-timeout', kind: 'duration', constant: DEFAULT_PARSEABLE_REQUEST_TIMEOUT_MS },
  { key: 'actor-ts.logger.sinks.seq.request-timeout', kind: 'duration', constant: DEFAULT_SEQ_REQUEST_TIMEOUT_MS },
  { key: 'actor-ts.logger.sinks.splunk.request-timeout', kind: 'duration', constant: DEFAULT_SPLUNK_REQUEST_TIMEOUT_MS },
  { key: 'actor-ts.logger.sinks.splunk.source', kind: 'string', constant: DEFAULT_SPLUNK_SOURCE },
  { key: 'actor-ts.logger.sinks.splunk.sourcetype', kind: 'string', constant: DEFAULT_SPLUNK_SOURCETYPE },
  { key: 'actor-ts.logger.sinks.syslog.transport', kind: 'string', constant: DEFAULT_SYSLOG_TRANSPORT },
  { key: 'actor-ts.logger.sinks.syslog.host', kind: 'string', constant: DEFAULT_SYSLOG_HOST },
  { key: 'actor-ts.logger.sinks.syslog.port', kind: 'int', constant: DEFAULT_SYSLOG_PORT },
  { key: 'actor-ts.logger.sinks.syslog.framing', kind: 'string', constant: DEFAULT_SYSLOG_FRAMING },
  { key: 'actor-ts.logger.sinks.syslog.facility', kind: 'int', constant: DEFAULT_SYSLOG_FACILITY },
];

/**
 * Keys whose reference value intentionally differs from the constant behind
 * them, recorded so the absence of an entry above reads as a decision rather
 * than an oversight.
 *
 * The file sink batches to local disk, where a bigger batch costs nothing and
 * a shorter flush bounds how much a crash loses; `reference.conf` therefore
 * overrides `DeliveryOptions`' network-shaped defaults for it alone.  Because
 * `reference.conf` is a *layer above* the built-in constants rather than a
 * copy of them, that override is what actually takes effect — which is also
 * why "the constant and the HOCON literal must be equal" is the wrong
 * assertion to make blindly, and why this list exists instead of a fudge
 * factor inside the comparison.
 */
const DELIBERATE_DIVERGENCES: readonly string[] = [
  'actor-ts.logger.sinks.file.delivery.max-batch-size', // 500, vs DEFAULT_DELIVERY_MAX_BATCH_SIZE = 100
  'actor-ts.logger.sinks.file.delivery.flush-interval', // 1s, vs DEFAULT_DELIVERY_FLUSH_INTERVAL_MS = 2000
];

/**
 * Level names, spelled `"info"` in HOCON while the `DEFAULT_*_MIN_LEVEL`
 * constants hold `LogLevel.Info` — a *numeric* enum member (`1`).  Comparing
 * them needs the name↔ordinal mapping, which is a different assertion about a
 * different piece of code, and a test that silently coerced one to the other
 * would pass for a mismatched pair.
 */
const LOG_LEVEL_NAMES: readonly string[] = [
  'actor-ts.logger.level',
  'actor-ts.logger.sinks.console.min-level',
  'actor-ts.logger.sinks.file.min-level',
  'actor-ts.logger.sinks.gelf.min-level',
  'actor-ts.logger.sinks.otlp.min-level',
  'actor-ts.logger.sinks.loki.min-level',
  'actor-ts.logger.sinks.parseable.min-level',
  'actor-ts.logger.sinks.seq.min-level',
  'actor-ts.logger.sinks.splunk.min-level',
  'actor-ts.logger.sinks.syslog.min-level',
];

/**
 * Empty-string placeholders.  `""` is not a default anyone ships with — it is
 * the shape of the key, published so an operator can see the name and the
 * nesting.  The value is either required at the point of use or derived from
 * something the process only knows at runtime (the system name, the host
 * name), so there is no constant it could be compared against.
 */
const PLACEHOLDERS: readonly string[] = [
  'actor-ts.dead-letters.persistence-id',
  'actor-ts.logger.sinks.gelf.url',
  'actor-ts.logger.sinks.gelf.host-name',
  'actor-ts.logger.sinks.otlp.service-name',
  'actor-ts.logger.sinks.loki.url',
  'actor-ts.logger.sinks.loki.tenant-id',
  'actor-ts.logger.sinks.loki.labels.service',
  'actor-ts.logger.sinks.parseable.url',
  'actor-ts.logger.sinks.parseable.stream',
  'actor-ts.logger.sinks.parseable.username',
  'actor-ts.logger.sinks.parseable.password',
  'actor-ts.logger.sinks.parseable.api-key',
  'actor-ts.logger.sinks.seq.url',
  'actor-ts.logger.sinks.seq.api-key',
  'actor-ts.logger.sinks.splunk.url',
  'actor-ts.logger.sinks.splunk.token',
  'actor-ts.logger.sinks.splunk.index',
  'actor-ts.logger.sinks.splunk.host-name',
  'actor-ts.logger.sinks.syslog.app-name',
  'actor-ts.logger.sinks.syslog.host-name',
];

/**
 * Feature switches, and the sentinel durations and counts that mean "off".
 * The published value is a statement about whether the feature is on, not a
 * tuned number, and none of them has a `DEFAULT_*` constant to disagree with —
 * the off state is the field being absent at the read site.
 *
 * Listed key by key rather than matched by suffix: a `.enabled` predicate
 * would silently swallow the next switch that *does* grow a constant, which is
 * exactly the drift the partition exists to catch.
 */
const FEATURE_SWITCHES: readonly string[] = [
  'actor-ts.logger.sinks.console.enabled',
  'actor-ts.logger.sinks.file.enabled',
  'actor-ts.logger.sinks.file.compress-rotated',
  'actor-ts.logger.sinks.gelf.enabled',
  'actor-ts.logger.sinks.otlp.enabled',
  'actor-ts.logger.sinks.otlp.gzip',
  'actor-ts.logger.sinks.loki.enabled',
  'actor-ts.logger.sinks.loki.structured-metadata',
  'actor-ts.logger.sinks.parseable.enabled',
  'actor-ts.logger.sinks.seq.enabled',
  'actor-ts.logger.sinks.splunk.enabled',
  'actor-ts.logger.sinks.syslog.enabled',
  'actor-ts.cluster.weakly-up-after', // 0s = no auto weakly-up promotion
  'actor-ts.cluster.tombstone.min-retention', // 0s = derive from down-after
  'actor-ts.cluster.pub-sub.send-to-dead-letters-when-no-subscribers',
  'actor-ts.remote.tls.enabled',
  'actor-ts.http.shutdown-grace-period', // 0ms = close listeners at once
  'actor-ts.sharding.remember-entities',
  'actor-ts.sharding.max-entities', // 0 = unbounded
  'actor-ts.coordinated-shutdown.terminate-actor-system',
  'actor-ts.coordinated-shutdown.exit-process',
  'actor-ts.coordinated-shutdown.auto-register-tasks',
];

/**
 * Keys whose default is a literal at the read site rather than a named
 * constant, so `REFERENCE_CONF` is the only written-down copy and there is
 * nothing to compare it *to*.  An entry here is a standing invitation to give
 * the value a `DEFAULT_*` constant and move it up into the table — that is a
 * change to `src/`, not to this test, which is why they are recorded rather
 * than quietly skipped.
 */
const LITERAL_AT_THE_READ_SITE: readonly string[] = [
  'actor-ts.system.name', // 'default' — ActorSystem.ts
  'actor-ts.dispatcher.default', // 'immediate' — ActorSystem.ts
  'actor-ts.logger.sinks.loki.format', // 'text' — LokiSink.ts
  'actor-ts.remote.tcp.host', // '0.0.0.0' — ActorSystem.ts
  'actor-ts.http.backend', // 'fastify' — HttpExtension.ts
  'actor-ts.persistence.journal.plugin', // the in-memory journal id — PersistenceExtension.ts
  'actor-ts.persistence.snapshot-store.plugin', // the in-memory store id — PersistenceExtension.ts
  'actor-ts.worker-cluster.workers', // 'auto' — WorkerCluster.ts
];

/** The four unasserted groups, flattened — the rest of the partition. */
const UNASSERTED_LEAVES: readonly string[] = [
  ...LOG_LEVEL_NAMES,
  ...PLACEHOLDERS,
  ...FEATURE_SWITCHES,
  ...LITERAL_AT_THE_READ_SITE,
];

/** Every dotted leaf path in a parsed HOCON tree, in declaration order. */
function leafPaths(tree: ConfigObject, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) out.push(...leafPaths(value, path));
    else out.push(path);
  }
  return out;
}

const referenceLeaves = leafPaths(parseHocon(REFERENCE_CONF));
const assertedKeys = new Set<string>([
  ...DOCUMENTED_DEFAULTS.map((entry) => entry.key),
  ...DELIBERATE_DIVERGENCES,
]);
const unassertedKeys = new Set<string>(UNASSERTED_LEAVES);

const reference = Config.parseString(REFERENCE_CONF);

const readers = {
  duration: (key: string) => reference.getDuration(key),
  bytes: (key: string) => reference.getBytes(key),
  int: (key: string) => reference.getInt(key),
  number: (key: string) => reference.getNumber(key),
  string: (key: string) => reference.getString(key),
  bool: (key: string) => reference.getBoolean(key),
} as const satisfies Record<DefaultKind, (key: string) => number | string | boolean>;

describe('documented defaults match the constants they are published from', () => {
  test('the table actually covers the reference configuration', () => {
    // Guards the guard: an import that silently resolved to `undefined`, or a
    // table gutted by a bad merge, would make every assertion below vacuous.
    expect(referenceLeaves.length).toBeGreaterThan(100);
    expect(referenceLeaves).toContain('actor-ts.sharding.passivation-idle');
    expect(new Set(DOCUMENTED_DEFAULTS.map((entry) => entry.key)).size).toBe(DOCUMENTED_DEFAULTS.length);
    for (const { key, constant } of DOCUMENTED_DEFAULTS) {
      expect(constant, `${key} is linked to a constant that is undefined`).toBeDefined();
    }
  });

  test.each(referenceLeaves)('%s is either asserted or explicitly unasserted', (leaf) => {
    expect(
      assertedKeys.has(leaf) || unassertedKeys.has(leaf),
      `${leaf} ships in reference.conf — and therefore on both reference-conf.mdx `
      + 'pages — but this test says nothing about its value. Add it to '
      + 'DOCUMENTED_DEFAULTS with the DEFAULT_* constant it is published from; if '
      + 'it has no constant, or is a level name, a placeholder or a feature '
      + 'switch, put it in the matching unasserted group and say why there. '
      + 'A new block landing with no entry at all is how the dead-letters keys '
      + 'went unasserted for a day.',
    ).toBe(true);
  });

  test('no leaf is both asserted and unasserted', () => {
    // Otherwise a key could be moved into the table and left behind in a group,
    // and the next person reading the group would trust a stale reason.
    const both = [...assertedKeys].filter((key) => unassertedKeys.has(key));
    expect(both, `${both.join(', ')} appears in the table and in an unasserted group`).toEqual([]);
  });

  test('every unasserted key is still a real reference.conf leaf', () => {
    // Same reasoning as NoDeadConfigKeys' KNOWN_DEAD_KEYS check: an exemption
    // that outlives its key silently excuses nothing and reads as coverage.
    for (const key of UNASSERTED_LEAVES) {
      expect(referenceLeaves, `${key} is listed as unasserted but is no longer in reference.conf`)
        .toContain(key);
    }
    expect(new Set(UNASSERTED_LEAVES).size).toBe(UNASSERTED_LEAVES.length);
  });

  // Spread into a mutable array: bun's `test.each` types its parameter as
  // `T[]`, so a `readonly` table is rejected outright (TS2769).
  test.each([...DOCUMENTED_DEFAULTS])('$key is published as $constant', ({ key, kind, constant }) => {
    expect(reference.hasPath(key), `${key} is not in REFERENCE_CONF at all`).toBe(true);
    expect(
      readers[kind](key),
      `reference.conf publishes a different default for ${key} than the constant it is `
      + 'documented from. Both language reference-conf.mdx pages are byte-pinned to '
      + 'REFERENCE_CONF, so this value is already on the docs site — change whichever '
      + 'of the two is wrong, not just the one that made this test red.',
    ).toBe(constant);
  });

  test.each([...DELIBERATE_DIVERGENCES])('%s is still a deliberate divergence', (key) => {
    // If one of these ever comes back into line with its constant, the entry
    // is stale and belongs in the table above instead.
    expect(reference.hasPath(key)).toBe(true);
  });
});
