import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import {
  DEFAULT_ACTOR_THROUGHPUT,
  DEFAULT_DISPATCHER_THROUGHPUT,
  DEFAULT_PHASE_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
} from '../../../src/Constants.js';
import { DEFAULT_GOSSIP_INTERVAL_MS } from '../../../src/util/Constants.js';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from '../../../src/cluster/Constants.js';
import {
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REQUIRED_CONTACT_POINTS,
  DEFAULT_SELF_ELECTION_GRACE_MS,
  DEFAULT_STABLE_MARGIN_MS,
} from '../../../src/cluster/bootstrap/StableObservationOptions.js';
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
} from '../../../src/cluster/sharding/ShardingOptions.js';
import {
  DEFAULT_HAND_OFF_TIMEOUT_MS,
  DEFAULT_REBALANCE_INTERVAL_MS,
} from '../../../src/cluster/sharding/ShardCoordinatorOptions.js';
import {
  DEFAULT_MAX_GOSSIP_BYTES,
  DEFAULT_MAX_PENDING_QUORUM_REQUESTS,
  DEFAULT_MAX_QUORUM_TIMEOUT_MS,
} from '../../../src/crdt/DistributedDataOptions.js';
import { DEFAULT_WEBSOCKET_MAX_FRAME_BYTES } from '../../../src/http/Constants.js';
import {
  DEFAULT_HTTP_CLIENT_MAX_REDIRECTS,
  DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_CLIENT_REDIRECT_MODE,
  DEFAULT_HTTP_CLIENT_TIMEOUT_MS,
} from '../../../src/http/HttpClientOptions.js';
import { DEFAULT_CLEANUP_MS, DEFAULT_MAX_ENTRIES } from '../../../src/cache/InMemoryCacheOptions.js';
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
 */

/** How to read a key — picks the `Config` accessor that matches its literal. */
type DefaultKind = 'duration' | 'bytes' | 'int' | 'string';

type DocumentedDefault = {
  /** Full dotted HOCON path as it appears in `REFERENCE_CONF`. */
  readonly key: string;
  readonly kind: DefaultKind;
  /** The `DEFAULT_*` constant, imported so a rename is a compile error. */
  readonly constant: number | string;
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

  /* --- distributed data --- */
  { key: 'actor-ts.distributed-data.max-pending-quorum-requests', kind: 'int', constant: DEFAULT_MAX_PENDING_QUORUM_REQUESTS },
  { key: 'actor-ts.distributed-data.max-quorum-timeout', kind: 'duration', constant: DEFAULT_MAX_QUORUM_TIMEOUT_MS },
  { key: 'actor-ts.distributed-data.max-gossip-bytes', kind: 'bytes', constant: DEFAULT_MAX_GOSSIP_BYTES },

  /* --- http --- */
  { key: 'actor-ts.http.websocket.maxFrameBytes', kind: 'bytes', constant: DEFAULT_WEBSOCKET_MAX_FRAME_BYTES },
  { key: 'actor-ts.http.client.defaultTimeoutMs', kind: 'duration', constant: DEFAULT_HTTP_CLIENT_TIMEOUT_MS },
  { key: 'actor-ts.http.client.maxRedirects', kind: 'int', constant: DEFAULT_HTTP_CLIENT_MAX_REDIRECTS },
  { key: 'actor-ts.http.client.maxResponseBytes', kind: 'bytes', constant: DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES },
  { key: 'actor-ts.http.client.redirect', kind: 'string', constant: DEFAULT_HTTP_CLIENT_REDIRECT_MODE },

  /* --- cache --- */
  { key: 'actor-ts.cache.in-memory.maxEntries', kind: 'int', constant: DEFAULT_MAX_ENTRIES },
  { key: 'actor-ts.cache.in-memory.cleanupMs', kind: 'int', constant: DEFAULT_CLEANUP_MS },

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
 * `min-level` keys are excluded on purpose: they are spelled `"info"` in HOCON
 * but the `DEFAULT_*_MIN_LEVEL` constants hold `LogLevel.Info`, a *numeric*
 * enum member (`1`).  Comparing them needs the name↔ordinal mapping, which is
 * a different assertion about a different piece of code — and a test that
 * silently coerced one to the other would pass for a mismatched pair.
 */

const reference = Config.parseString(REFERENCE_CONF);

const readers = {
  duration: (key: string) => reference.getDuration(key),
  bytes: (key: string) => reference.getBytes(key),
  int: (key: string) => reference.getInt(key),
  string: (key: string) => reference.getString(key),
} as const satisfies Record<DefaultKind, (key: string) => number | string>;

describe('documented defaults match the constants they are published from', () => {
  test('the table actually covers the reference configuration', () => {
    // Guards the guard: an import that silently resolved to `undefined`, or a
    // table gutted by a bad merge, would make every assertion below vacuous.
    expect(DOCUMENTED_DEFAULTS.length).toBeGreaterThanOrEqual(70);
    expect(new Set(DOCUMENTED_DEFAULTS.map((entry) => entry.key)).size).toBe(DOCUMENTED_DEFAULTS.length);
    for (const { key, constant } of DOCUMENTED_DEFAULTS) {
      expect(constant, `${key} is linked to a constant that is undefined`).toBeDefined();
    }
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
