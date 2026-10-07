import { describe, expect, test } from 'bun:test';
import { Config } from '../../../src/config/Config.js';
import { REFERENCE_CONF } from '../../../src/config/Reference.js';
import { LogLevel } from '../../../src/Logger.js';
import {
  DEFAULT_CONSOLE_SINK_FORMAT,
  DEFAULT_CONSOLE_SINK_MIN_LEVEL,
  DEFAULT_CONSOLE_SINK_STREAM,
  isConsoleSinkEnabled,
  readConsoleSinkOptionsFromConfig,
  type ConsoleSinkOptionsType,
} from '../../../src/logging/ConsoleSinkOptions.js';
import {
  DEFAULT_DELIVERY_FLUSH_INTERVAL_MS,
  DEFAULT_DELIVERY_MAX_BATCH_SIZE,
  DEFAULT_DELIVERY_OVERFLOW,
  DEFAULT_DELIVERY_QUEUE_CAPACITY,
  type DeliveryOptionsType,
} from '../../../src/logging/DeliveryOptions.js';
import {
  DEFAULT_FILE_SINK_DIRECTORY,
  DEFAULT_FILE_SINK_EXTENSION,
  DEFAULT_FILE_SINK_FORMAT,
  DEFAULT_FILE_SINK_MAX_AGE_MS,
  DEFAULT_FILE_SINK_MAX_FILE_BYTES,
  DEFAULT_FILE_SINK_MAX_FILES,
  DEFAULT_FILE_SINK_MIN_LEVEL,
  DEFAULT_FILE_SINK_PREFIX,
  DEFAULT_FILE_SINK_ROTATE_INTERVAL,
  isFileSinkEnabled,
  readFileSinkOptionsFromConfig,
  type FileSinkOptionsType,
} from '../../../src/logging/FileSinkOptions.js';
import { DEFAULT_GELF_MAX_CHUNK_BYTES } from '../../../src/logging/GelfChunking.js';
import {
  DEFAULT_GELF_COMPRESSION,
  DEFAULT_GELF_HOST,
  DEFAULT_GELF_MIN_LEVEL,
  DEFAULT_GELF_PORT,
  DEFAULT_GELF_PROTOCOL,
  DEFAULT_GELF_REQUEST_TIMEOUT_MS,
  isGelfSinkEnabled,
  readGelfSinkOptionsFromConfig,
  type GelfSinkOptionsType,
} from '../../../src/logging/GelfSinkOptions.js';
import {
  DEFAULT_LOKI_MIN_LEVEL,
  DEFAULT_LOKI_REQUEST_TIMEOUT_MS,
  isLokiSinkEnabled,
  readLokiSinkOptionsFromConfig,
  type LokiSinkOptionsType,
} from '../../../src/logging/LokiSinkOptions.js';
import {
  DEFAULT_OTLP_MIN_LEVEL,
  DEFAULT_OTLP_REQUEST_TIMEOUT_MS,
  DEFAULT_OTLP_SCOPE_NAME,
  DEFAULT_OTLP_URL,
  isOtlpSinkEnabled,
  readOtlpSinkOptionsFromConfig,
  type OtlpHttpSinkOptionsType,
} from '../../../src/logging/OtlpHttpSinkOptions.js';
import {
  DEFAULT_PARSEABLE_MIN_LEVEL,
  DEFAULT_PARSEABLE_REQUEST_TIMEOUT_MS,
  isParseableSinkEnabled,
  readParseableSinkOptionsFromConfig,
  type ParseableSinkOptionsType,
} from '../../../src/logging/ParseableSinkOptions.js';
import {
  DEFAULT_SEQ_MIN_LEVEL,
  DEFAULT_SEQ_REQUEST_TIMEOUT_MS,
  isSeqSinkEnabled,
  readSeqSinkOptionsFromConfig,
  type SeqSinkOptionsType,
} from '../../../src/logging/SeqSinkOptions.js';
import {
  DEFAULT_SPLUNK_MIN_LEVEL,
  DEFAULT_SPLUNK_REQUEST_TIMEOUT_MS,
  DEFAULT_SPLUNK_SOURCE,
  DEFAULT_SPLUNK_SOURCETYPE,
  isSplunkSinkEnabled,
  readSplunkSinkOptionsFromConfig,
  type SplunkSinkOptionsType,
} from '../../../src/logging/SplunkSinkOptions.js';
import {
  DEFAULT_SYSLOG_FACILITY,
  DEFAULT_SYSLOG_FRAMING,
  DEFAULT_SYSLOG_HOST,
  DEFAULT_SYSLOG_MIN_LEVEL,
  DEFAULT_SYSLOG_PORT,
  DEFAULT_SYSLOG_TRANSPORT,
  isSyslogSinkEnabled,
  readSyslogSinkOptionsFromConfig,
  type SyslogSinkOptionsType,
} from '../../../src/logging/SyslogSinkOptions.js';
import { expectExactOptions } from '../../util/ExactOptions.js';

/**
 * The nine `actor-ts.logger.sinks.*` blocks, bound leaf by leaf (#1425).
 *
 * `ConfigKeys` names each sink by its block root only, and every reader builds
 * its leaf paths from that root at runtime, so nothing that reads source text
 * can tell a leaf a reader still reads from one it dropped.  Deleting the otlp
 * `gzip` read was caught by nothing that ran — the dead-key guard, the sink's
 * own suite and the documented-defaults check all stayed green — and until
 * this file no test named a single one of these readers.
 *
 * What binds a leaf here is the read itself, observed: each published leaf is
 * set, one at a time and on top of the bundled reference, to a value of its
 * kind that the reference does not ship, and the switch and options of all
 * nine blocks are compared as one exact object.  The value has to land in its
 * own field, and nothing else may move.
 *
 * Exact objects come from `expectExactOptions`, because `toEqual` ignores an
 * own `undefined`: a reader rewritten to `out.x = hasPath ? read() : undefined`
 * passes it, while the `undefined` it writes shadows the built-in default the
 * moment the result is spread.  And `Config.parseString` throughout, never
 * `Config.fromObject` with a dotted key, which keeps the dotted string as one
 * literal top-level key — the reader would then resolve the nested reference
 * value and the assertion would say nothing.
 */
const reference = Config.parseString(REFERENCE_CONF);

/** What the seven network sinks' `delivery` blocks ship: `DeliveryOptions`' own defaults. */
const BATCHING_DELIVERY_REFERENCE: DeliveryOptionsType = {
  maxBatchSize: DEFAULT_DELIVERY_MAX_BATCH_SIZE,
  flushIntervalMs: DEFAULT_DELIVERY_FLUSH_INTERVAL_MS,
  queueCapacity: DEFAULT_DELIVERY_QUEUE_CAPACITY,
};

/**
 * The file sink's block diverges on purpose: it batches to local disk, where a
 * bigger batch costs nothing and a shorter flush bounds what a crash loses.
 * Literals rather than constants because no constant holds them — the
 * reference layer *is* the override.
 */
const FILE_DELIVERY_REFERENCE: DeliveryOptionsType = {
  maxBatchSize: 500,
  flushIntervalMs: 1_000,
  queueCapacity: DEFAULT_DELIVERY_QUEUE_CAPACITY,
  overflow: DEFAULT_DELIVERY_OVERFLOW,
};

/*
 * What each reader resolves the bundled reference to.  An empty-string
 * placeholder (`url = ""`, `host-name = ""`, …) is the shape of a key rather
 * than a value, so it is absent here — with one exception, noted on the otlp
 * block.
 */

const CONSOLE_REFERENCE: Partial<ConsoleSinkOptionsType> = {
  minLevel: DEFAULT_CONSOLE_SINK_MIN_LEVEL,
  format: DEFAULT_CONSOLE_SINK_FORMAT,
  stream: DEFAULT_CONSOLE_SINK_STREAM,
};

const FILE_REFERENCE: Partial<FileSinkOptionsType> = {
  minLevel: DEFAULT_FILE_SINK_MIN_LEVEL,
  format: DEFAULT_FILE_SINK_FORMAT,
  directory: DEFAULT_FILE_SINK_DIRECTORY,
  prefix: DEFAULT_FILE_SINK_PREFIX,
  extension: DEFAULT_FILE_SINK_EXTENSION,
  maxFileBytes: DEFAULT_FILE_SINK_MAX_FILE_BYTES,
  rotateInterval: DEFAULT_FILE_SINK_ROTATE_INTERVAL,
  maxFiles: DEFAULT_FILE_SINK_MAX_FILES,
  maxAgeMs: DEFAULT_FILE_SINK_MAX_AGE_MS,
  compressRotated: false,
  delivery: FILE_DELIVERY_REFERENCE,
};

const GELF_REFERENCE: Partial<GelfSinkOptionsType> = {
  minLevel: DEFAULT_GELF_MIN_LEVEL,
  protocol: DEFAULT_GELF_PROTOCOL,
  host: DEFAULT_GELF_HOST,
  port: DEFAULT_GELF_PORT,
  compression: DEFAULT_GELF_COMPRESSION,
  maxChunkBytes: DEFAULT_GELF_MAX_CHUNK_BYTES,
  requestTimeoutMs: DEFAULT_GELF_REQUEST_TIMEOUT_MS,
  delivery: BATCHING_DELIVERY_REFERENCE,
};

const OTLP_REFERENCE: Partial<OtlpHttpSinkOptionsType> = {
  minLevel: DEFAULT_OTLP_MIN_LEVEL,
  url: DEFAULT_OTLP_URL,
  // The one placeholder that is NOT treated as unset: this reader is the only
  // one of the nine without the empty-string check, so the shipped
  // `service-name = ""` arrives as a value, and the sink's validator refuses
  // an empty `serviceName`.  Pinned as the reader behaves today; when it
  // learns that "" means unset, this line goes and the field is absent.
  serviceName: '',
  scopeName: DEFAULT_OTLP_SCOPE_NAME,
  gzip: false,
  requestTimeoutMs: DEFAULT_OTLP_REQUEST_TIMEOUT_MS,
  delivery: BATCHING_DELIVERY_REFERENCE,
};

const LOKI_REFERENCE: Partial<LokiSinkOptionsType> = {
  minLevel: DEFAULT_LOKI_MIN_LEVEL,
  format: 'text',
  structuredMetadata: true,
  requestTimeoutMs: DEFAULT_LOKI_REQUEST_TIMEOUT_MS,
  delivery: BATCHING_DELIVERY_REFERENCE,
};

const PARSEABLE_REFERENCE: Partial<ParseableSinkOptionsType> = {
  minLevel: DEFAULT_PARSEABLE_MIN_LEVEL,
  requestTimeoutMs: DEFAULT_PARSEABLE_REQUEST_TIMEOUT_MS,
  delivery: BATCHING_DELIVERY_REFERENCE,
};

const SEQ_REFERENCE: Partial<SeqSinkOptionsType> = {
  minLevel: DEFAULT_SEQ_MIN_LEVEL,
  requestTimeoutMs: DEFAULT_SEQ_REQUEST_TIMEOUT_MS,
  delivery: BATCHING_DELIVERY_REFERENCE,
};

const SPLUNK_REFERENCE: Partial<SplunkSinkOptionsType> = {
  minLevel: DEFAULT_SPLUNK_MIN_LEVEL,
  source: DEFAULT_SPLUNK_SOURCE,
  sourcetype: DEFAULT_SPLUNK_SOURCETYPE,
  requestTimeoutMs: DEFAULT_SPLUNK_REQUEST_TIMEOUT_MS,
  delivery: BATCHING_DELIVERY_REFERENCE,
};

const SYSLOG_REFERENCE: Partial<SyslogSinkOptionsType> = {
  minLevel: DEFAULT_SYSLOG_MIN_LEVEL,
  transport: DEFAULT_SYSLOG_TRANSPORT,
  host: DEFAULT_SYSLOG_HOST,
  port: DEFAULT_SYSLOG_PORT,
  facility: DEFAULT_SYSLOG_FACILITY,
  framing: DEFAULT_SYSLOG_FRAMING,
  delivery: BATCHING_DELIVERY_REFERENCE,
};

type SinkName = 'console' | 'file' | 'gelf' | 'loki' | 'otlp' | 'parseable' | 'seq' | 'splunk' | 'syslog';

/** One sink block: its published root, its two readers, and what they make of the reference. */
type SinkBlock = {
  readonly name: SinkName;
  /** Spelled out rather than taken from `ConfigKeys`: the published path is the contract. */
  readonly root: string;
  readonly isEnabled: (config: Config) => boolean;
  readonly read: (config: Config) => object;
  readonly reference: object;
};

const SINKS: readonly SinkBlock[] = [
  {
    name: 'console',
    root: 'actor-ts.logger.sinks.console',
    isEnabled: isConsoleSinkEnabled,
    read: readConsoleSinkOptionsFromConfig,
    reference: CONSOLE_REFERENCE,
  },
  {
    name: 'file',
    root: 'actor-ts.logger.sinks.file',
    isEnabled: isFileSinkEnabled,
    read: readFileSinkOptionsFromConfig,
    reference: FILE_REFERENCE,
  },
  {
    name: 'gelf',
    root: 'actor-ts.logger.sinks.gelf',
    isEnabled: isGelfSinkEnabled,
    read: readGelfSinkOptionsFromConfig,
    reference: GELF_REFERENCE,
  },
  {
    name: 'loki',
    root: 'actor-ts.logger.sinks.loki',
    isEnabled: isLokiSinkEnabled,
    read: readLokiSinkOptionsFromConfig,
    reference: LOKI_REFERENCE,
  },
  {
    name: 'otlp',
    root: 'actor-ts.logger.sinks.otlp',
    isEnabled: isOtlpSinkEnabled,
    read: readOtlpSinkOptionsFromConfig,
    reference: OTLP_REFERENCE,
  },
  {
    name: 'parseable',
    root: 'actor-ts.logger.sinks.parseable',
    isEnabled: isParseableSinkEnabled,
    read: readParseableSinkOptionsFromConfig,
    reference: PARSEABLE_REFERENCE,
  },
  {
    name: 'seq',
    root: 'actor-ts.logger.sinks.seq',
    isEnabled: isSeqSinkEnabled,
    read: readSeqSinkOptionsFromConfig,
    reference: SEQ_REFERENCE,
  },
  {
    name: 'splunk',
    root: 'actor-ts.logger.sinks.splunk',
    isEnabled: isSplunkSinkEnabled,
    read: readSplunkSinkOptionsFromConfig,
    reference: SPLUNK_REFERENCE,
  },
  {
    name: 'syslog',
    root: 'actor-ts.logger.sinks.syslog',
    isEnabled: isSyslogSinkEnabled,
    read: readSyslogSinkOptionsFromConfig,
    reference: SYSLOG_REFERENCE,
  },
];

const SINK_BY_NAME = new Map(SINKS.map((sink) => [sink.name, sink]));

function sinkNamed(name: SinkName): SinkBlock {
  const sink = SINK_BY_NAME.get(name);
  if (sink === undefined) throw new Error(`no sink block named ${name}`);
  return sink;
}

/** Everything a config tells one sink: whether to build it, and with what. */
type SinkSnapshot = { readonly enabled: boolean; readonly options: object };
type SinkSnapshots = Record<SinkName, SinkSnapshot>;

function snapshotOfSink(sink: SinkBlock, config: Config): SinkSnapshot {
  return { enabled: sink.isEnabled(config), options: sink.read(config) };
}

/** Both readers of all nine sinks, side by side — the whole observable surface of the blocks. */
function snapshotOf(config: Config): SinkSnapshots {
  return Object.fromEntries(SINKS.map((sink) => [sink.name, snapshotOfSink(sink, config)])) as SinkSnapshots;
}

/** What {@link snapshotOf} must return for the bundled reference — a fresh copy, free to mutate. */
function referenceSnapshots(): SinkSnapshots {
  return Object.fromEntries(
    SINKS.map((sink) => [sink.name, { enabled: false, options: structuredClone(sink.reference) }]),
  ) as SinkSnapshots;
}

/** Follow a dotted path through nested plain objects. */
function readPath(root: object, dotted: string): unknown {
  let current: unknown = root;
  for (const key of dotted.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Set a dotted path, creating any plain object along it that is missing. */
function writePath(root: object, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  let current = root as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const next = current[key];
    if (typeof next !== 'object' || next === null) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

/**
 * One published leaf: the HOCON value it is set to, and where in its sink's
 * {@link SinkSnapshot} that value must land — `enabled`, or a path into
 * `options`.
 *
 * Every value differs from what the reference ships (the table checks that of
 * itself), durations and sizes carry a unit so a reader that switched getters
 * throws instead of agreeing by accident, and every `min-level` row says
 * `debug`: `LogLevel.Debug` is `0`, the one level a truthiness guard drops.
 */
type LeafCase = {
  readonly sink: SinkName;
  readonly leaf: string;
  readonly hocon: string;
  readonly lands: string;
  readonly value: unknown;
};

type LeafRow = readonly [leaf: string, hocon: string, lands: string, value: unknown];

function leavesOf(sink: SinkName, rows: readonly LeafRow[]): LeafCase[] {
  return rows.map(([leaf, hocon, lands, value]) => ({ sink, leaf, hocon, lands, value }));
}

const LEAVES: readonly LeafCase[] = [
  ...leavesOf('console', [
    ['enabled', 'true', 'enabled', true],
    ['min-level', '"debug"', 'options.minLevel', LogLevel.Debug],
    ['format', '"json"', 'options.format', 'json'],
    ['stream', '"stderr"', 'options.stream', 'stderr'],
  ]),
  ...leavesOf('file', [
    ['enabled', 'true', 'enabled', true],
    ['min-level', '"debug"', 'options.minLevel', LogLevel.Debug],
    ['format', '"json"', 'options.format', 'json'],
    ['directory', '"var/log/orders"', 'options.directory', 'var/log/orders'],
    ['prefix', '"orders"', 'options.prefix', 'orders'],
    ['extension', '"ndjson"', 'options.extension', 'ndjson'],
    ['max-file-bytes', '2M', 'options.maxFileBytes', 2 * 1024 * 1024],
    ['rotate-interval', '"hourly"', 'options.rotateInterval', 'hourly'],
    ['max-files', '3', 'options.maxFiles', 3],
    ['max-age', '36h', 'options.maxAgeMs', 36 * 60 * 60 * 1_000],
    ['compress-rotated', 'true', 'options.compressRotated', true],
    ['delivery.max-batch-size', '250', 'options.delivery.maxBatchSize', 250],
    ['delivery.flush-interval', '750ms', 'options.delivery.flushIntervalMs', 750],
    ['delivery.queue-capacity', '4000', 'options.delivery.queueCapacity', 4_000],
    ['delivery.overflow', '"drop-head"', 'options.delivery.overflow', 'drop-head'],
  ]),
  ...leavesOf('gelf', [
    ['enabled', 'true', 'enabled', true],
    ['min-level', '"debug"', 'options.minLevel', LogLevel.Debug],
    ['protocol', '"http"', 'options.protocol', 'http'],
    ['host', '"graylog.internal"', 'options.host', 'graylog.internal'],
    ['port', '12202', 'options.port', 12_202],
    ['url', '"http://graylog:12201/gelf"', 'options.url', 'http://graylog:12201/gelf'],
    ['host-name', '"orders-1"', 'options.hostName', 'orders-1'],
    ['compression', '"none"', 'options.compression', 'none'],
    ['max-chunk-bytes', '8192', 'options.maxChunkBytes', 8_192],
    ['request-timeout', '4s', 'options.requestTimeoutMs', 4_000],
    ['delivery.max-batch-size', '50', 'options.delivery.maxBatchSize', 50],
    ['delivery.flush-interval', '3s', 'options.delivery.flushIntervalMs', 3_000],
    ['delivery.queue-capacity', '2000', 'options.delivery.queueCapacity', 2_000],
  ]),
  ...leavesOf('otlp', [
    ['enabled', 'true', 'enabled', true],
    ['min-level', '"debug"', 'options.minLevel', LogLevel.Debug],
    ['url', '"https://collector.internal:4318/v1/logs"', 'options.url', 'https://collector.internal:4318/v1/logs'],
    ['service-name', '"orders"', 'options.serviceName', 'orders'],
    ['scope-name', '"orders-scope"', 'options.scopeName', 'orders-scope'],
    ['gzip', 'true', 'options.gzip', true],
    ['request-timeout', '7s', 'options.requestTimeoutMs', 7_000],
    ['delivery.max-batch-size', '60', 'options.delivery.maxBatchSize', 60],
    ['delivery.flush-interval', '5s', 'options.delivery.flushIntervalMs', 5_000],
    ['delivery.queue-capacity', '3000', 'options.delivery.queueCapacity', 3_000],
  ]),
  ...leavesOf('loki', [
    ['enabled', 'true', 'enabled', true],
    ['min-level', '"debug"', 'options.minLevel', LogLevel.Debug],
    ['url', '"http://loki:3100"', 'options.url', 'http://loki:3100'],
    ['tenant-id', '"team-a"', 'options.tenantId', 'team-a'],
    ['format', '"json"', 'options.format', 'json'],
    ['labels.service', '"orders"', 'options.labels.service', 'orders'],
    ['structured-metadata', 'false', 'options.structuredMetadata', false],
    ['request-timeout', '6s', 'options.requestTimeoutMs', 6_000],
    ['delivery.max-batch-size', '70', 'options.delivery.maxBatchSize', 70],
    ['delivery.flush-interval', '1500ms', 'options.delivery.flushIntervalMs', 1_500],
    ['delivery.queue-capacity', '5000', 'options.delivery.queueCapacity', 5_000],
  ]),
  ...leavesOf('parseable', [
    ['enabled', 'true', 'enabled', true],
    ['min-level', '"debug"', 'options.minLevel', LogLevel.Debug],
    ['url', '"https://parseable.internal"', 'options.url', 'https://parseable.internal'],
    ['stream', '"orders"', 'options.stream', 'orders'],
    ['username', '"ingest"', 'options.username', 'ingest'],
    ['password', '"example-password"', 'options.password', 'example-password'],
    ['api-key', '"example-api-key"', 'options.apiKey', 'example-api-key'],
    ['request-timeout', '5s', 'options.requestTimeoutMs', 5_000],
    ['delivery.max-batch-size', '80', 'options.delivery.maxBatchSize', 80],
    ['delivery.flush-interval', '2500ms', 'options.delivery.flushIntervalMs', 2_500],
    ['delivery.queue-capacity', '6000', 'options.delivery.queueCapacity', 6_000],
  ]),
  ...leavesOf('seq', [
    ['enabled', 'true', 'enabled', true],
    ['min-level', '"debug"', 'options.minLevel', LogLevel.Debug],
    ['url', '"http://seq:5341"', 'options.url', 'http://seq:5341'],
    ['api-key', '"example-seq-key"', 'options.apiKey', 'example-seq-key'],
    ['request-timeout', '3s', 'options.requestTimeoutMs', 3_000],
    ['delivery.max-batch-size', '90', 'options.delivery.maxBatchSize', 90],
    ['delivery.flush-interval', '4s', 'options.delivery.flushIntervalMs', 4_000],
    ['delivery.queue-capacity', '7000', 'options.delivery.queueCapacity', 7_000],
  ]),
  ...leavesOf('splunk', [
    ['enabled', 'true', 'enabled', true],
    ['min-level', '"debug"', 'options.minLevel', LogLevel.Debug],
    ['url', '"https://splunk.internal:8088"', 'options.url', 'https://splunk.internal:8088'],
    ['token', '"example-hec-token"', 'options.token', 'example-hec-token'],
    ['index', '"orders"', 'options.index', 'orders'],
    ['source', '"orders-service"', 'options.source', 'orders-service'],
    ['sourcetype', '"orders:json"', 'options.sourcetype', 'orders:json'],
    ['host-name', '"orders-1"', 'options.hostName', 'orders-1'],
    ['request-timeout', '8s', 'options.requestTimeoutMs', 8_000],
    ['delivery.max-batch-size', '40', 'options.delivery.maxBatchSize', 40],
    ['delivery.flush-interval', '6s', 'options.delivery.flushIntervalMs', 6_000],
    ['delivery.queue-capacity', '8000', 'options.delivery.queueCapacity', 8_000],
  ]),
  ...leavesOf('syslog', [
    ['enabled', 'true', 'enabled', true],
    ['min-level', '"debug"', 'options.minLevel', LogLevel.Debug],
    ['transport', '"tls"', 'options.transport', 'tls'],
    ['host', '"syslog.internal"', 'options.host', 'syslog.internal'],
    ['port', '6514', 'options.port', 6_514],
    ['facility', '3', 'options.facility', 3],
    ['app-name', '"orders"', 'options.appName', 'orders'],
    ['host-name', '"orders-1"', 'options.hostName', 'orders-1'],
    ['framing', '"lf"', 'options.framing', 'lf'],
    ['delivery.max-batch-size', '30', 'options.delivery.maxBatchSize', 30],
    ['delivery.flush-interval', '8s', 'options.delivery.flushIntervalMs', 8_000],
    ['delivery.queue-capacity', '9000', 'options.delivery.queueCapacity', 9_000],
  ]),
];

function pathOf(leafCase: LeafCase): string {
  return `${sinkNamed(leafCase.sink).root}.${leafCase.leaf}`;
}

/** Every leaf the bundled reference publishes under `root`, as full dotted paths, sorted. */
function referenceLeavesUnder(root: string): string[] {
  const leaves: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
      return;
    }
    leaves.push(path);
  };
  walk(reference.getObject(root), root);
  return leaves.sort();
}

const LEVEL_NAMES: ReadonlyArray<readonly [name: string, level: LogLevel]> = [
  ['debug', LogLevel.Debug],
  ['info', LogLevel.Info],
  ['warn', LogLevel.Warn],
  ['error', LogLevel.Error],
  ['off', LogLevel.Off],
];

for (const sink of SINKS) {
  describe(`${sink.root}: ${sink.read.name} and ${sink.isEnabled.name}`, () => {
    test('the bundled reference resolves to exactly the shipped values, with the sink switched off', () => {
      expectExactOptions(snapshotOfSink(sink, reference), { enabled: false, options: sink.reference });
    });

    test('an empty block yields no settings at all, not a bag of undefined', () => {
      expectExactOptions(
        snapshotOfSink(sink, Config.parseString(`${sink.root} {}`)),
        { enabled: false, options: {} },
      );
    });

    test('the switch is on for enabled = true, and off for false or absent', () => {
      expectExactOptions(
        snapshotOfSink(sink, Config.parseString(`${sink.root}.enabled = true`)),
        { enabled: true, options: {} },
      );
      expectExactOptions(
        snapshotOfSink(sink, Config.parseString(`${sink.root}.enabled = false`)),
        { enabled: false, options: {} },
      );
      expectExactOptions(snapshotOfSink(sink, Config.empty()), { enabled: false, options: {} });
    });

    test('min-level takes every level name, and hands an unknown one on unparsed', () => {
      for (const [name, level] of LEVEL_NAMES) {
        expectExactOptions(
          sink.read(Config.parseString(`${sink.root}.min-level = "${name}"`)),
          { minLevel: level },
        );
      }
      // Not defaulted: the sink's validator then refuses it naming the field,
      // which says more than records quietly arriving at the wrong level.
      expectExactOptions(
        sink.read(Config.parseString(`${sink.root}.min-level = "warning"`)),
        { minLevel: 'warning' },
      );
    });
  });
}

describe('every published sink leaf reaches its own field, and nothing else moves', () => {
  test('the table names exactly the leaves the reference publishes under actor-ts.logger.sinks', () => {
    expect(LEAVES.map(pathOf).sort()).toEqual(referenceLeavesUnder('actor-ts.logger.sinks'));
  });

  test('every row moves its field off the shipped value', () => {
    // A row whose value equals the shipped one would pass whether or not the
    // reader ever looked at its leaf.
    const shipped = referenceSnapshots();
    const inert = LEAVES
      .filter((leafCase) => Object.is(readPath(shipped[leafCase.sink], leafCase.lands), leafCase.value))
      .map(pathOf);
    expect(inert).toEqual([]);
  });

  for (const leafCase of LEAVES) {
    test(`${pathOf(leafCase)} = ${leafCase.hocon} lands in ${leafCase.sink}.${leafCase.lands}`, () => {
      const config = Config.parseString(`${pathOf(leafCase)} = ${leafCase.hocon}`).withFallback(reference);
      const expected = referenceSnapshots();
      writePath(expected[leafCase.sink], leafCase.lands, leafCase.value);
      expectExactOptions(snapshotOf(config), expected);
    });
  }
});
