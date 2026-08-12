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

/** Built-in default for {@link ParseableSinkOptionsType.minLevel}. */
export const DEFAULT_PARSEABLE_MIN_LEVEL = LogLevel.Info;
/** Built-in default for {@link ParseableSinkOptionsType.requestTimeoutMs}. */
export const DEFAULT_PARSEABLE_REQUEST_TIMEOUT_MS = 10_000;
/**
 * Parseable's documented cap on one ingestion request, in bytes.
 *
 * The sink splits a batch that would exceed it rather than letting the
 * server reject the whole thing — a rejection here is not retryable, so an
 * oversized batch would simply be lost.
 */
export const PARSEABLE_MAX_REQUEST_BYTES = 10 * 1024 * 1024;

/** Plain options-object shape accepted by {@link ParseableSink}. */
export type ParseableSinkOptionsType = {
  /** Records below this level are not sent.  Default `info`. */
  readonly minLevel?: LogLevel;
  /** Parseable base URL, e.g. `https://parseable.example.com`. */
  readonly url?: string;
  /** Target dataset.  Parseable creates it on first use. */
  readonly stream?: string;
  /** Basic-auth user.  Mutually exclusive with {@link apiKey}. */
  readonly username?: string;
  /** Basic-auth password. */
  readonly password?: string;
  /** `X-API-Key` value.  Mutually exclusive with {@link username}. */
  readonly apiKey?: string;
  /** Per-request timeout in milliseconds.  Default 10 000. */
  readonly requestTimeoutMs?: number;
  /** Queue, batching and retry settings — see `DeliveryOptionsType`. */
  readonly delivery?: DeliveryOptionsType;
  /** Test seam: replaces the global `fetch`. */
  readonly fetchFn?: FetchLike;
};

/** Fluent builder for {@link ParseableSinkOptionsType}. */
export class ParseableSinkOptionsBuilder extends OptionsBuilder<ParseableSinkOptionsType> {
  /** Start a fresh builder.  Equivalent to `new ParseableSinkOptionsBuilder()`. */
  static create(): ParseableSinkOptionsBuilder {
    return new ParseableSinkOptionsBuilder();
  }

  /** Lowest level this sink sends. */
  withMinLevel(minLevel: LogLevel): this {
    return this.set('minLevel', minLevel);
  }

  /** Parseable base URL. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Target dataset name. */
  withStream(stream: string): this {
    return this.set('stream', stream);
  }

  /** Basic-auth credentials. */
  withCredentials(username: string, password: string): this {
    return this.set('username', username).set('password', password);
  }

  /** `X-API-Key` value. */
  withApiKey(apiKey: string): this {
    return this.set('apiKey', apiKey);
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

/** Validates resolved {@link ParseableSinkOptionsType} settings. */
export class ParseableSinkOptionsValidator extends OptionsValidator<ParseableSinkOptionsType> {
  constructor() {
    super('ParseableSinkOptions');
  }

  protected rules(s: Partial<ParseableSinkOptionsType>): void {
    if (s.minLevel !== undefined && !isLogLevel(s.minLevel)) {
      this.fail('minLevel', LOG_LEVEL_REASON, s.minLevel);
    }
    // Required: there is no sensible default host for someone else's
    // Parseable, and without one every flush would fail identically.
    if (s.url === undefined) this.fail('url', 'is required');
    this.url('url', ['http', 'https']);
    this.nonEmptyString('stream');
    this.nonEmptyString('username');
    this.nonEmptyString('apiKey');
    this.positiveInt('requestTimeoutMs');

    // Both credentials go on every request, so half a pair is a request
    // that will be rejected — and worth catching at construction rather
    // than once per flush.
    if ((s.username === undefined) !== (s.password === undefined)) {
      this.fail('username', 'and password must be set together', s.username ?? s.password);
    }
    if (s.username !== undefined && s.apiKey !== undefined) {
      this.fail('apiKey', 'cannot be combined with basic-auth credentials', s.apiKey);
    }
    validateDeliveryOptions('ParseableSinkOptions', s.delivery);
  }
}

/** Whether `actor-ts.logger.sinks.parseable.enabled` asks for this sink. */
export function isParseableSinkEnabled(config: Config): boolean {
  return isSinkEnabled(config, ConfigKeys.logger.sinks.parseable);
}

/**
 * Read `actor-ts.logger.sinks.parseable.*`.  Only keys actually present
 * are returned; an empty string counts as unset, since the reference block
 * ships empty placeholders so the keys are discoverable.
 */
export function readParseableSinkOptionsFromConfig(config: Config): Partial<ParseableSinkOptionsType> {
  const root = ConfigKeys.logger.sinks.parseable;
  const out: { -readonly [K in keyof ParseableSinkOptionsType]?: ParseableSinkOptionsType[K] } = {};
  const path = (leaf: string): string => sinkLeaf(root, leaf);
  const text = (leaf: string): string | undefined => {
    if (!config.hasPath(path(leaf))) return undefined;
    const value = config.getString(path(leaf));
    return value === '' ? undefined : value;
  };
  const minLevel = readSinkMinLevel(config, root);
  if (minLevel !== undefined) out.minLevel = minLevel;
  const url = text('url');
  if (url !== undefined) out.url = url;
  const stream = text('stream');
  if (stream !== undefined) out.stream = stream;
  const username = text('username');
  if (username !== undefined) out.username = username;
  const password = text('password');
  if (password !== undefined) out.password = password;
  const apiKey = text('api-key');
  if (apiKey !== undefined) out.apiKey = apiKey;
  if (config.hasPath(path('request-timeout'))) {
    out.requestTimeoutMs = config.getDuration(path('request-timeout'));
  }
  const delivery = readDeliveryOptionsFromConfig(config, root);
  if (delivery !== undefined) out.delivery = delivery;
  return out;
}

/**
 * Accepted input for the {@link ParseableSink} constructor: the fluent
 * {@link ParseableSinkOptionsBuilder} OR a plain
 * {@link ParseableSinkOptionsType} object.
 */
export type ParseableSinkOptions = ParseableSinkOptionsBuilder | ParseableSinkOptionsType;
/** Value alias so `ParseableSinkOptions.create()` resolves to the builder. */
export const ParseableSinkOptions = ParseableSinkOptionsBuilder;
