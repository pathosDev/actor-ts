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
import { isLogLevel, LOG_LEVEL_REASON } from './LogLevelName.js';
import { isSinkEnabled, readSinkMinLevel, sinkLeaf } from './SinkConfig.js';
import { DEFAULT_SYSLOG_FACILITY, type SyslogFraming } from './SyslogFrame.js';

/** How a {@link SyslogSink} reaches the collector. */
export type SyslogTransport = 'udp' | 'tcp' | 'tls';

/** Built-in default for {@link SyslogSinkOptionsType.minLevel}. */
export const DEFAULT_SYSLOG_MIN_LEVEL = LogLevel.Info;
/** Built-in default for {@link SyslogSinkOptionsType.transport}. */
export const DEFAULT_SYSLOG_TRANSPORT: SyslogTransport = 'udp';
/** Built-in default for {@link SyslogSinkOptionsType.host}. */
export const DEFAULT_SYSLOG_HOST = '127.0.0.1';
/** Built-in default for {@link SyslogSinkOptionsType.port} — the syslog port. */
export const DEFAULT_SYSLOG_PORT = 514;
/** Built-in default for {@link SyslogSinkOptionsType.framing}. */
export const DEFAULT_SYSLOG_FRAMING: SyslogFraming = 'octet-counting';

export { DEFAULT_SYSLOG_FACILITY };

/** Plain options-object shape accepted by {@link SyslogSink}. */
export type SyslogSinkOptionsType = {
  /** Records below this level are not sent.  Default `info`. */
  readonly minLevel?: LogLevel;
  /** `udp`, `tcp` or `tls`.  Default `udp`. */
  readonly transport?: SyslogTransport;
  /** Collector host.  Default `127.0.0.1`. */
  readonly host?: string;
  /** Collector port.  Default `514`. */
  readonly port?: number;
  /**
   * Syslog facility, `0`–`23`.  Default 16 (`local0`) — the range reserved
   * for applications.
   */
  readonly facility?: number;
  /** `APP-NAME` in the frame.  Defaults to the actor system's name. */
  readonly appName?: string;
  /** `HOSTNAME` in the frame.  Defaults to the OS hostname. */
  readonly hostName?: string;
  /** Stream framing for `tcp`/`tls`.  Default `octet-counting` (RFC 6587). */
  readonly framing?: SyslogFraming;
  /**
   * TLS material for the `tls` transport.
   *
   * Code-only, with no HOCON leaf — these fields carry the certificate and
   * key themselves, not paths to them.
   */
  readonly tls?: TlsTransportOptionsType;
  /** Queue, batching and retry settings — see `DeliveryOptionsType`. */
  readonly delivery?: DeliveryOptionsType;
};

/** Fluent builder for {@link SyslogSinkOptionsType}. */
export class SyslogSinkOptionsBuilder extends OptionsBuilder<SyslogSinkOptionsType> {
  /** Start a fresh builder.  Equivalent to `new SyslogSinkOptionsBuilder()`. */
  static create(): SyslogSinkOptionsBuilder {
    return new SyslogSinkOptionsBuilder();
  }

  /** Lowest level this sink sends. */
  withMinLevel(minLevel: LogLevel): this {
    return this.set('minLevel', minLevel);
  }

  /** `udp`, `tcp` or `tls`. */
  withTransport(transport: SyslogTransport): this {
    return this.set('transport', transport);
  }

  /** Collector host. */
  withHost(host: string): this {
    return this.set('host', host);
  }

  /** Collector port. */
  withPort(port: number): this {
    return this.set('port', port);
  }

  /** Syslog facility, `0`–`23`. */
  withFacility(facility: number): this {
    return this.set('facility', facility);
  }

  /** `APP-NAME` in the frame. */
  withAppName(appName: string): this {
    return this.set('appName', appName);
  }

  /** `HOSTNAME` in the frame. */
  withHostName(hostName: string): this {
    return this.set('hostName', hostName);
  }

  /** Stream framing for `tcp`/`tls`. */
  withFraming(framing: SyslogFraming): this {
    return this.set('framing', framing);
  }

  /** TLS material for the `tls` transport. */
  withTls(tls: TlsTransportOptionsType): this {
    return this.set('tls', tls);
  }

  /** Queue, batching and retry settings. */
  withDelivery(delivery: DeliveryOptionsType): this {
    return this.set('delivery', delivery);
  }
}

/** Validates resolved {@link SyslogSinkOptionsType} settings. */
export class SyslogSinkOptionsValidator extends OptionsValidator<SyslogSinkOptionsType> {
  constructor() {
    super('SyslogSinkOptions');
  }

  protected rules(s: Partial<SyslogSinkOptionsType>): void {
    if (s.minLevel !== undefined && !isLogLevel(s.minLevel)) {
      this.fail('minLevel', LOG_LEVEL_REASON, s.minLevel);
    }
    this.oneOf('transport', ['udp', 'tcp', 'tls']);
    this.nonEmptyString('host');
    this.port('port');
    this.nonEmptyString('appName');
    this.nonEmptyString('hostName');
    this.oneOf('framing', ['octet-counting', 'lf']);
    // RFC 5424 encodes the facility in the priority as facility·8 + severity,
    // which only stays unambiguous for 0–23.
    if (s.facility !== undefined) this.numberInRange('facility', 0, 23);
    if (s.tls !== undefined && s.transport !== undefined && s.transport !== 'tls') {
      this.fail('tls', 'is only supported when transport is tls', s.transport);
    }
    validateDeliveryOptions('SyslogSinkOptions', s.delivery);
  }
}

/** Whether `actor-ts.logger.sinks.syslog.enabled` asks for this sink. */
export function isSyslogSinkEnabled(config: Config): boolean {
  return isSinkEnabled(config, ConfigKeys.logger.sinks.syslog);
}

/** Read `actor-ts.logger.sinks.syslog.*`.  An empty string counts as unset. */
export function readSyslogSinkOptionsFromConfig(config: Config): Partial<SyslogSinkOptionsType> {
  const root = ConfigKeys.logger.sinks.syslog;
  const out: { -readonly [K in keyof SyslogSinkOptionsType]?: SyslogSinkOptionsType[K] } = {};
  const path = (leaf: string): string => sinkLeaf(root, leaf);
  const text = (leaf: string): string | undefined => {
    if (!config.hasPath(path(leaf))) return undefined;
    const value = config.getString(path(leaf));
    return value === '' ? undefined : value;
  };
  const minLevel = readSinkMinLevel(config, root);
  if (minLevel !== undefined) out.minLevel = minLevel;
  if (config.hasPath(path('transport'))) {
    out.transport = config.getString(path('transport')) as SyslogTransport;
  }
  const host = text('host');
  if (host !== undefined) out.host = host;
  if (config.hasPath(path('port'))) out.port = config.getInt(path('port'));
  if (config.hasPath(path('facility'))) out.facility = config.getInt(path('facility'));
  const appName = text('app-name');
  if (appName !== undefined) out.appName = appName;
  const hostName = text('host-name');
  if (hostName !== undefined) out.hostName = hostName;
  if (config.hasPath(path('framing'))) {
    out.framing = config.getString(path('framing')) as SyslogFraming;
  }
  const delivery = readDeliveryOptionsFromConfig(config, root);
  if (delivery !== undefined) out.delivery = delivery;
  return out;
}

/**
 * Accepted input for the {@link SyslogSink} constructor: the fluent
 * {@link SyslogSinkOptionsBuilder} OR a plain
 * {@link SyslogSinkOptionsType} object.
 */
export type SyslogSinkOptions = SyslogSinkOptionsBuilder | SyslogSinkOptionsType;
/** Value alias so `SyslogSinkOptions.create()` resolves to the builder. */
export const SyslogSinkOptions = SyslogSinkOptionsBuilder;
