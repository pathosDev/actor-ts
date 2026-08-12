import type { Config } from '../config/Config.js';
import { ConfigKeys } from '../config/ConfigKeys.js';
import { LogLevel } from '../Logger.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import {
  readDeliveryOptionsFromConfig,
  validateDeliveryOptions,
  type DeliveryOptionsType,
} from './DeliveryOptions.js';
import type { FetchLike } from './HttpDelivery.js';
import { isLogLevel, LOG_LEVEL_REASON } from './LogLevelName.js';
import { isSinkEnabled, readSinkMinLevel, sinkLeaf } from './SinkConfig.js';

/**
 * Built-in default for {@link OtlpHttpSinkOptionsType.url} — the OTLP/HTTP
 * port and path a collector listens on out of the box.
 */
export const DEFAULT_OTLP_URL = 'http://localhost:4318/v1/logs';
/** Built-in default for {@link OtlpHttpSinkOptionsType.minLevel}. */
export const DEFAULT_OTLP_MIN_LEVEL = LogLevel.Info;
/** Built-in default for {@link OtlpHttpSinkOptionsType.requestTimeoutMs}. */
export const DEFAULT_OTLP_REQUEST_TIMEOUT_MS = 10_000;
/** Built-in default for {@link OtlpHttpSinkOptionsType.scopeName}. */
export const DEFAULT_OTLP_SCOPE_NAME = 'actor-ts';

/** Plain options-object shape accepted by {@link OtlpHttpSink}. */
export type OtlpHttpSinkOptionsType = {
  /** Records below this level are not sent.  Default `info`. */
  readonly minLevel?: LogLevel;
  /** Full endpoint URL including the path.  Default {@link DEFAULT_OTLP_URL}. */
  readonly url?: string;
  /** `service.name` on the OTLP resource.  Defaults to the actor system's name. */
  readonly serviceName?: string;
  /** Instrumentation scope name.  Default `actor-ts`. */
  readonly scopeName?: string;
  /** gzip the request body.  Collectors are required to accept it. */
  readonly gzip?: boolean;
  /** Per-request timeout in milliseconds.  Default 10 000. */
  readonly requestTimeoutMs?: number;
  /**
   * Extra request headers — an API key, a tenant id.
   *
   * Code-only, with no HOCON leaf: these carry credentials, and a config
   * file is the wrong place for those (#590, #592, #741).  Read them from
   * the environment and pass them here.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Queue, batching and retry settings — see `DeliveryOptionsType`. */
  readonly delivery?: DeliveryOptionsType;
  /** Test seam: replaces the global `fetch`. */
  readonly fetchFn?: FetchLike;
};

/** Fluent builder for {@link OtlpHttpSinkOptionsType}. */
export class OtlpHttpSinkOptionsBuilder extends OptionsBuilder<OtlpHttpSinkOptionsType> {
  /** Start a fresh builder.  Equivalent to `new OtlpHttpSinkOptionsBuilder()`. */
  static create(): OtlpHttpSinkOptionsBuilder {
    return new OtlpHttpSinkOptionsBuilder();
  }

  /** Lowest level this sink sends. */
  withMinLevel(minLevel: LogLevel): this {
    return this.set('minLevel', minLevel);
  }

  /** Full endpoint URL, including the `/v1/logs` path. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** `service.name` on the OTLP resource. */
  withServiceName(serviceName: string): this {
    return this.set('serviceName', serviceName);
  }

  /** Instrumentation scope name. */
  withScopeName(scopeName: string): this {
    return this.set('scopeName', scopeName);
  }

  /** gzip the request body. */
  withGzip(gzip: boolean): this {
    return this.set('gzip', gzip);
  }

  /** Per-request timeout in milliseconds. */
  withRequestTimeoutMs(requestTimeoutMs: number): this {
    return this.set('requestTimeoutMs', requestTimeoutMs);
  }

  /** Extra request headers — an API key, a tenant id. */
  withHeaders(headers: Readonly<Record<string, string>>): this {
    return this.set('headers', headers);
  }

  /** Queue, batching and retry settings. */
  withDelivery(delivery: DeliveryOptionsType): this {
    return this.set('delivery', delivery);
  }

  /** Replace the global `fetch` — for tests. */
  withFetchFn(fetchFn: FetchLike): this {
    return this.set('fetchFn', fetchFn);
  }
}

/** Validates resolved {@link OtlpHttpSinkOptionsType} settings. */
export class OtlpHttpSinkOptionsValidator extends OptionsValidator<OtlpHttpSinkOptionsType> {
  constructor() {
    super('OtlpHttpSinkOptions');
  }

  protected rules(s: Partial<OtlpHttpSinkOptionsType>): void {
    if (s.minLevel !== undefined && !isLogLevel(s.minLevel)) {
      this.fail('minLevel', LOG_LEVEL_REASON, s.minLevel);
    }
    this.url('url', ['http', 'https']);
    this.nonEmptyString('serviceName');
    this.nonEmptyString('scopeName');
    this.positiveInt('requestTimeoutMs');
    validateDeliveryOptions('OtlpHttpSinkOptions', s.delivery);
  }
}

/** Whether `actor-ts.logger.sinks.otlp.enabled` asks for this sink. */
export function isOtlpSinkEnabled(config: Config): boolean {
  return isSinkEnabled(config, ConfigKeys.logger.sinks.otlp);
}

/**
 * Read `actor-ts.logger.sinks.otlp.*`.  Only keys actually present are
 * returned.  `headers` has no leaf on purpose — see the field's docs.
 */
export function readOtlpSinkOptionsFromConfig(config: Config): Partial<OtlpHttpSinkOptionsType> {
  const root = ConfigKeys.logger.sinks.otlp;
  const out: { -readonly [K in keyof OtlpHttpSinkOptionsType]?: OtlpHttpSinkOptionsType[K] } = {};
  const path = (leaf: string): string => sinkLeaf(root, leaf);
  const minLevel = readSinkMinLevel(config, root);
  if (minLevel !== undefined) out.minLevel = minLevel;
  if (config.hasPath(path('url'))) out.url = config.getString(path('url'));
  if (config.hasPath(path('service-name'))) out.serviceName = config.getString(path('service-name'));
  if (config.hasPath(path('scope-name'))) out.scopeName = config.getString(path('scope-name'));
  if (config.hasPath(path('gzip'))) out.gzip = config.getBoolean(path('gzip'));
  if (config.hasPath(path('request-timeout'))) {
    out.requestTimeoutMs = config.getDuration(path('request-timeout'));
  }
  const delivery = readDeliveryOptionsFromConfig(config, root);
  if (delivery !== undefined) out.delivery = delivery;
  return out;
}

/**
 * Accepted input for the {@link OtlpHttpSink} constructor: the fluent
 * {@link OtlpHttpSinkOptionsBuilder} OR a plain
 * {@link OtlpHttpSinkOptionsType} object.
 */
export type OtlpHttpSinkOptions = OtlpHttpSinkOptionsBuilder | OtlpHttpSinkOptionsType;
/** Value alias so `OtlpHttpSinkOptions.create()` resolves to the builder. */
export const OtlpHttpSinkOptions = OtlpHttpSinkOptionsBuilder;
