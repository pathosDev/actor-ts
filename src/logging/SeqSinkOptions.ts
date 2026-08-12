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

/** Built-in default for {@link SeqSinkOptionsType.minLevel}. */
export const DEFAULT_SEQ_MIN_LEVEL = LogLevel.Info;
/** Built-in default for {@link SeqSinkOptionsType.requestTimeoutMs}. */
export const DEFAULT_SEQ_REQUEST_TIMEOUT_MS = 10_000;
/** The content type Seq expects for a newline-delimited CLEF batch. */
export const SEQ_CLEF_CONTENT_TYPE = 'application/vnd.serilog.clef';

/** Plain options-object shape accepted by {@link SeqSink}. */
export type SeqSinkOptionsType = {
  /** Records below this level are not sent.  Default `info`. */
  readonly minLevel?: LogLevel;
  /** Seq base URL, e.g. `http://seq:5341`. */
  readonly url?: string;
  /** `X-Seq-ApiKey` value.  Optional — a Seq instance may accept anonymous writes. */
  readonly apiKey?: string;
  /** Per-request timeout in milliseconds.  Default 10 000. */
  readonly requestTimeoutMs?: number;
  /** Queue, batching and retry settings — see `DeliveryOptionsType`. */
  readonly delivery?: DeliveryOptionsType;
  /** Test seam: replaces the global `fetch`. */
  readonly fetchFn?: FetchLike;
};

/** Fluent builder for {@link SeqSinkOptionsType}. */
export class SeqSinkOptionsBuilder extends OptionsBuilder<SeqSinkOptionsType> {
  /** Start a fresh builder.  Equivalent to `new SeqSinkOptionsBuilder()`. */
  static create(): SeqSinkOptionsBuilder {
    return new SeqSinkOptionsBuilder();
  }

  /** Lowest level this sink sends. */
  withMinLevel(minLevel: LogLevel): this {
    return this.set('minLevel', minLevel);
  }

  /** Seq base URL. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** `X-Seq-ApiKey` value. */
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

/** Validates resolved {@link SeqSinkOptionsType} settings. */
export class SeqSinkOptionsValidator extends OptionsValidator<SeqSinkOptionsType> {
  constructor() {
    super('SeqSinkOptions');
  }

  protected rules(s: Partial<SeqSinkOptionsType>): void {
    if (s.minLevel !== undefined && !isLogLevel(s.minLevel)) {
      this.fail('minLevel', LOG_LEVEL_REASON, s.minLevel);
    }
    if (s.url === undefined) this.fail('url', 'is required');
    this.url('url', ['http', 'https']);
    this.nonEmptyString('apiKey');
    this.positiveInt('requestTimeoutMs');
    validateDeliveryOptions('SeqSinkOptions', s.delivery);
  }
}

/** Whether `actor-ts.logger.sinks.seq.enabled` asks for this sink. */
export function isSeqSinkEnabled(config: Config): boolean {
  return isSinkEnabled(config, ConfigKeys.logger.sinks.seq);
}

/** Read `actor-ts.logger.sinks.seq.*`.  An empty string counts as unset. */
export function readSeqSinkOptionsFromConfig(config: Config): Partial<SeqSinkOptionsType> {
  const root = ConfigKeys.logger.sinks.seq;
  const out: { -readonly [K in keyof SeqSinkOptionsType]?: SeqSinkOptionsType[K] } = {};
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
 * Accepted input for the {@link SeqSink} constructor: the fluent
 * {@link SeqSinkOptionsBuilder} OR a plain {@link SeqSinkOptionsType}
 * object.
 */
export type SeqSinkOptions = SeqSinkOptionsBuilder | SeqSinkOptionsType;
/** Value alias so `SeqSinkOptions.create()` resolves to the builder. */
export const SeqSinkOptions = SeqSinkOptionsBuilder;
