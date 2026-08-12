import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { LogLevel } from '../Logger.js';
import type { TlsTransportOptionsType } from '../runtime/tcp/TcpBackend.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import {
  readDeliveryOptionsFromConfig,
  validateDeliveryOptions,
  type DeliveryOptionsType,
} from './DeliveryOptions.js';
import { DEFAULT_GELF_MAX_CHUNK_BYTES } from './GelfChunking.js';
import type { FetchLike } from './HttpDelivery.js';
import { isLogLevel, LOG_LEVEL_REASON } from './LogLevelName.js';
import { isSinkEnabled, readSinkMinLevel, sinkLeaf } from './SinkConfig.js';

/** How a {@link GelfSink} reaches Graylog. */
export type GelfProtocol = 'udp' | 'tcp' | 'http';

/** Whether UDP datagrams are compressed.  TCP and HTTP never are. */
export type GelfCompression = 'none' | 'gzip';

/** Built-in default for {@link GelfSinkOptionsType.minLevel}. */
export const DEFAULT_GELF_MIN_LEVEL = LogLevel.Info;
/** Built-in default for {@link GelfSinkOptionsType.protocol}. */
export const DEFAULT_GELF_PROTOCOL: GelfProtocol = 'udp';
/** Built-in default for {@link GelfSinkOptionsType.host}. */
export const DEFAULT_GELF_HOST = '127.0.0.1';
/** Built-in default for {@link GelfSinkOptionsType.port} — Graylog's GELF input. */
export const DEFAULT_GELF_PORT = 12201;
/** Built-in default for {@link GelfSinkOptionsType.compression}. */
export const DEFAULT_GELF_COMPRESSION: GelfCompression = 'gzip';
/** Built-in default for {@link GelfSinkOptionsType.requestTimeoutMs}. */
export const DEFAULT_GELF_REQUEST_TIMEOUT_MS = 10_000;

/** Plain options-object shape accepted by {@link GelfSink}. */
export type GelfSinkOptionsType = {
  /** Records below this level are not sent.  Default `info`. */
  readonly minLevel?: LogLevel;
  /** Transport.  Default `udp`, which is what a stock Graylog input listens on. */
  readonly protocol?: GelfProtocol;
  /** Graylog host for `udp` and `tcp`.  Default `127.0.0.1`. */
  readonly host?: string;
  /** Graylog port for `udp` and `tcp`.  Default `12201`. */
  readonly port?: number;
  /** Full input URL for `http`, e.g. `http://graylog:12201/gelf`. */
  readonly url?: string;
  /**
   * The GELF `host` field — the name records are attributed to.  Defaults
   * to the OS hostname, falling back to the actor system's name.
   */
  readonly hostName?: string;
  /** UDP only: compress each datagram.  The server auto-detects it. */
  readonly compression?: GelfCompression;
  /** UDP only: datagram size above which a message is chunked. */
  readonly maxChunkBytes?: number;
  /**
   * TCP only: TLS material.
   *
   * Code-only, with no HOCON leaf — these fields carry the certificate and
   * key *themselves*, not paths, which is not something a config file
   * should hold.
   */
  readonly tls?: TlsTransportOptionsType;
  /** HTTP only: per-request timeout in milliseconds.  Default 10 000. */
  readonly requestTimeoutMs?: number;
  /** Queue, batching and retry settings — see `DeliveryOptionsType`. */
  readonly delivery?: DeliveryOptionsType;
  /** Test seam for the `http` protocol: replaces the global `fetch`. */
  readonly fetchFn?: FetchLike;
};

/** Fluent builder for {@link GelfSinkOptionsType}. */
export class GelfSinkOptionsBuilder extends OptionsBuilder<GelfSinkOptionsType> {
  /** Start a fresh builder.  Equivalent to `new GelfSinkOptionsBuilder()`. */
  static create(): GelfSinkOptionsBuilder {
    return new GelfSinkOptionsBuilder();
  }

  /** Lowest level this sink sends. */
  withMinLevel(minLevel: LogLevel): this {
    return this.set('minLevel', minLevel);
  }

  /** `udp`, `tcp` or `http`. */
  withProtocol(protocol: GelfProtocol): this {
    return this.set('protocol', protocol);
  }

  /** Graylog host, for `udp` and `tcp`. */
  withHost(host: string): this {
    return this.set('host', host);
  }

  /** Graylog port, for `udp` and `tcp`. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Full GELF HTTP input URL, for `http`. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** The GELF `host` field records are attributed to. */
  withHostName(hostName: string): this {
    return this.set('hostName', hostName);
  }

  /** UDP datagram compression. */
  withCompression(compression: GelfCompression): this {
    return this.set('compression', compression);
  }

  /** UDP datagram size above which a message is chunked. */
  withMaxChunkBytes(maxChunkBytes: number): this {
    return this.set('maxChunkBytes', maxChunkBytes);
  }

  /** TLS material for `tcp`. */
  withTls(tls: TlsTransportOptionsType): this {
    return this.set('tls', tls);
  }

  /** Per-request timeout for `http`, in milliseconds. */
  withRequestTimeoutMs(requestTimeoutMs: number): this {
    return this.set('requestTimeoutMs', requestTimeoutMs);
  }

  /** Queue, batching and retry settings. */
  withDelivery(delivery: DeliveryOptionsType): this {
    return this.set('delivery', delivery);
  }

  /** Replace the global `fetch` for the `http` protocol — for tests. */
  withFetchFn(fetchFn: FetchLike): this {
    return this.set('fetchFn', fetchFn);
  }
}

/** Validates resolved {@link GelfSinkOptionsType} settings. */
export class GelfSinkOptionsValidator extends OptionsValidator<GelfSinkOptionsType> {
  constructor() {
    super('GelfSinkOptions');
  }

  protected rules(s: Partial<GelfSinkOptionsType>): void {
    if (s.minLevel !== undefined && !isLogLevel(s.minLevel)) {
      this.fail('minLevel', LOG_LEVEL_REASON, s.minLevel);
    }
    this.oneOf('protocol', ['udp', 'tcp', 'http']);
    this.nonEmptyString('host');
    this.port('port');
    this.url('url', ['http', 'https']);
    this.nonEmptyString('hostName');
    this.oneOf('compression', ['none', 'gzip']);
    this.positiveInt('requestTimeoutMs');
    // Below 512 a chunk is more header than payload; above 65467 the
    // datagram cannot carry the UDP and IP headers as well.
    if (s.maxChunkBytes !== undefined) {
      this.numberInRange('maxChunkBytes', 512, 65_467);
    }
    if (s.protocol === 'http' && s.url === undefined) {
      this.fail('url', 'is required when protocol is http');
    }
    if (s.protocol !== undefined && s.protocol !== 'tcp' && s.tls !== undefined) {
      this.fail('tls', 'is only supported when protocol is tcp', s.protocol);
    }
    validateDeliveryOptions('GelfSinkOptions', s.delivery);
  }
}

/** Whether `actor-ts.logger.sinks.gelf.enabled` asks for this sink. */
export function isGelfSinkEnabled(config: Config): boolean {
  return isSinkEnabled(config, ConfigKeys.logger.sinks.gelf);
}

/**
 * Read `actor-ts.logger.sinks.gelf.*`.  Only keys actually present are
 * returned.  `tls` has no leaf on purpose — see the field's docs.
 */
export function readGelfSinkOptionsFromConfig(config: Config): Partial<GelfSinkOptionsType> {
  const root = ConfigKeys.logger.sinks.gelf;
  const out: { -readonly [K in keyof GelfSinkOptionsType]?: GelfSinkOptionsType[K] } = {};
  const path = (leaf: string): string => sinkLeaf(root, leaf);
  const minLevel = readSinkMinLevel(config, root);
  if (minLevel !== undefined) out.minLevel = minLevel;
  if (config.hasPath(path('protocol'))) out.protocol = config.getString(path('protocol')) as GelfProtocol;
  if (config.hasPath(path('host'))) out.host = config.getString(path('host'));
  if (config.hasPath(path('port'))) out.port = config.getInt(path('port'));
  // An empty url means "unset" — the reference block ships one so the key
  // is discoverable, and an empty string is not a URL.
  if (config.hasPath(path('url')) && config.getString(path('url')) !== '') {
    out.url = config.getString(path('url'));
  }
  if (config.hasPath(path('host-name')) && config.getString(path('host-name')) !== '') {
    out.hostName = config.getString(path('host-name'));
  }
  if (config.hasPath(path('compression'))) {
    out.compression = config.getString(path('compression')) as GelfCompression;
  }
  if (config.hasPath(path('max-chunk-bytes'))) out.maxChunkBytes = config.getInt(path('max-chunk-bytes'));
  if (config.hasPath(path('request-timeout'))) {
    out.requestTimeoutMs = config.getDuration(path('request-timeout'));
  }
  const delivery = readDeliveryOptionsFromConfig(config, root);
  if (delivery !== undefined) out.delivery = delivery;
  return out;
}

/**
 * Accepted input for the {@link GelfSink} constructor: the fluent
 * {@link GelfSinkOptionsBuilder} OR a plain {@link GelfSinkOptionsType}
 * object.
 */
export type GelfSinkOptions = GelfSinkOptionsBuilder | GelfSinkOptionsType;
/** Value alias so `GelfSinkOptions.create()` resolves to the builder. */
export const GelfSinkOptions = GelfSinkOptionsBuilder;
