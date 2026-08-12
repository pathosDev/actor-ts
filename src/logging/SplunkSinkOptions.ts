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

/** Built-in default for {@link SplunkSinkOptionsType.minLevel}. */
export const DEFAULT_SPLUNK_MIN_LEVEL = LogLevel.Info;
/** Built-in default for {@link SplunkSinkOptionsType.source}. */
export const DEFAULT_SPLUNK_SOURCE = 'actor-ts';
/** Built-in default for {@link SplunkSinkOptionsType.sourcetype}. */
export const DEFAULT_SPLUNK_SOURCETYPE = '_json';
/** Built-in default for {@link SplunkSinkOptionsType.requestTimeoutMs}. */
export const DEFAULT_SPLUNK_REQUEST_TIMEOUT_MS = 10_000;

/** Plain options-object shape accepted by {@link SplunkSink}. */
export type SplunkSinkOptionsType = {
  /** Records below this level are not sent.  Default `info`. */
  readonly minLevel?: LogLevel;
  /** HEC base URL, e.g. `https://splunk.internal:8088`. */
  readonly url?: string;
  /** HEC token — the GUID from the collector's data input. */
  readonly token?: string;
  /** Target index.  Omitted to use the token's default. */
  readonly index?: string;
  /** `source` field on every event.  Default `actor-ts`. */
  readonly source?: string;
  /** `sourcetype` field on every event.  Default `_json`. */
  readonly sourcetype?: string;
  /** `host` field on every event.  Defaults to the actor system's name. */
  readonly hostName?: string;
  /** Per-request timeout in milliseconds.  Default 10 000. */
  readonly requestTimeoutMs?: number;
  /** Queue, batching and retry settings — see `DeliveryOptionsType`. */
  readonly delivery?: DeliveryOptionsType;
  /** Test seam: replaces the global `fetch`. */
  readonly fetchFn?: FetchLike;
};

/** Fluent builder for {@link SplunkSinkOptionsType}. */
export class SplunkSinkOptionsBuilder extends OptionsBuilder<SplunkSinkOptionsType> {
  /** Start a fresh builder.  Equivalent to `new SplunkSinkOptionsBuilder()`. */
  static create(): SplunkSinkOptionsBuilder {
    return new SplunkSinkOptionsBuilder();
  }

  /** Lowest level this sink sends. */
  withMinLevel(minLevel: LogLevel): this {
    return this.set('minLevel', minLevel);
  }

  /** HEC base URL. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** HEC token. */
  withToken(token: string): this {
    return this.set('token', token);
  }

  /** Target index. */
  withIndex(index: string): this {
    return this.set('index', index);
  }

  /** `source` field on every event. */
  withSource(source: string): this {
    return this.set('source', source);
  }

  /** `sourcetype` field on every event. */
  withSourcetype(sourcetype: string): this {
    return this.set('sourcetype', sourcetype);
  }

  /** `host` field on every event. */
  withHostName(hostName: string): this {
    return this.set('hostName', hostName);
  }

  /** Per-request timeout in milliseconds. */
  withRequestTimeoutMs(requestTimeoutMs: number): this {
    return this.set('requestTimeoutMs', requestTimeoutMs);
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

/** Validates resolved {@link SplunkSinkOptionsType} settings. */
export class SplunkSinkOptionsValidator extends OptionsValidator<SplunkSinkOptionsType> {
  constructor() {
    super('SplunkSinkOptions');
  }

  protected rules(s: Partial<SplunkSinkOptionsType>): void {
    if (s.minLevel !== undefined && !isLogLevel(s.minLevel)) {
      this.fail('minLevel', LOG_LEVEL_REASON, s.minLevel);
    }
    if (s.url === undefined) this.fail('url', 'is required');
    if (s.token === undefined) this.fail('token', 'is required');
    this.url('url', ['http', 'https']);
    this.nonEmptyString('token');
    this.nonEmptyString('index');
    this.nonEmptyString('source');
    this.nonEmptyString('sourcetype');
    this.nonEmptyString('hostName');
    this.positiveInt('requestTimeoutMs');
    validateDeliveryOptions('SplunkSinkOptions', s.delivery);
  }
}

/** Whether `actor-ts.logger.sinks.splunk.enabled` asks for this sink. */
export function isSplunkSinkEnabled(config: Config): boolean {
  return isSinkEnabled(config, ConfigKeys.logger.sinks.splunk);
}

/** Read `actor-ts.logger.sinks.splunk.*`.  An empty string counts as unset. */
export function readSplunkSinkOptionsFromConfig(config: Config): Partial<SplunkSinkOptionsType> {
  const root = ConfigKeys.logger.sinks.splunk;
  const out: { -readonly [K in keyof SplunkSinkOptionsType]?: SplunkSinkOptionsType[K] } = {};
  const path = (leaf: string): string => sinkLeaf(root, leaf);
  const text = (leaf: string): string | undefined => {
    if (!config.hasPath(path(leaf))) return undefined;
    const value = config.getString(path(leaf));
    return value === '' ? undefined : value;
  };
  const minLevel = readSinkMinLevel(config, root);
  if (minLevel !== undefined) out.minLevel = minLevel;
  for (const [field, leaf] of [
    ['url', 'url'], ['token', 'token'], ['index', 'index'],
    ['source', 'source'], ['sourcetype', 'sourcetype'], ['hostName', 'host-name'],
  ] as const) {
    const value = text(leaf);
    if (value !== undefined) out[field] = value;
  }
  if (config.hasPath(path('request-timeout'))) {
    out.requestTimeoutMs = config.getDuration(path('request-timeout'));
  }
  const delivery = readDeliveryOptionsFromConfig(config, root);
  if (delivery !== undefined) out.delivery = delivery;
  return out;
}

/**
 * Accepted input for the {@link SplunkSink} constructor: the fluent
 * {@link SplunkSinkOptionsBuilder} OR a plain
 * {@link SplunkSinkOptionsType} object.
 */
export type SplunkSinkOptions = SplunkSinkOptionsBuilder | SplunkSinkOptionsType;
/** Value alias so `SplunkSinkOptions.create()` resolves to the builder. */
export const SplunkSinkOptions = SplunkSinkOptionsBuilder;
