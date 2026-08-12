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

/** How a {@link LokiSink} renders each log line. */
export type LokiLineFormat = 'text' | 'json';

/** Built-in default for {@link LokiSinkOptionsType.minLevel}. */
export const DEFAULT_LOKI_MIN_LEVEL = LogLevel.Info;
/** Built-in default for {@link LokiSinkOptionsType.requestTimeoutMs}. */
export const DEFAULT_LOKI_REQUEST_TIMEOUT_MS = 10_000;
/** Loki label names must match this — letters, digits and underscores. */
export const LOKI_LABEL_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Plain options-object shape accepted by {@link LokiSink}. */
export type LokiSinkOptionsType = {
  /** Records below this level are not sent.  Default `info`. */
  readonly minLevel?: LogLevel;
  /** Loki base URL, e.g. `http://loki:3100`. */
  readonly url?: string;
  /**
   * **Static** stream labels.  Deliberately not derived from the record.
   *
   * Loki's labels are its index, and every distinct combination creates a
   * separate stream.  Putting an actor path — or any per-record value — in
   * here multiplies streams without bound and is the standard way to make
   * a Loki cluster unusable.  Everything variable belongs in structured
   * metadata, which is where this sink puts it.
   *
   * `service` defaults to the actor system's name.
   */
  readonly labels?: Readonly<Record<string, string>>;
  /** `X-Scope-OrgID` — Loki's multi-tenancy header. */
  readonly tenantId?: string;
  /** Attach source, display name and fields as structured metadata.  Default `true`. */
  readonly structuredMetadata?: boolean;
  /** `text` for a human-readable line, `json` for NDJSON.  Default `text`. */
  readonly format?: LokiLineFormat;
  /** Per-request timeout in milliseconds.  Default 10 000. */
  readonly requestTimeoutMs?: number;
  /**
   * Extra request headers — a Grafana Cloud basic-auth value, say.
   *
   * Code-only, with no HOCON leaf: these carry credentials.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /** Queue, batching and retry settings — see `DeliveryOptionsType`. */
  readonly delivery?: DeliveryOptionsType;
  /** Test seam: replaces the global `fetch`. */
  readonly fetchFn?: FetchLike;
};

/** Fluent builder for {@link LokiSinkOptionsType}. */
export class LokiSinkOptionsBuilder extends OptionsBuilder<LokiSinkOptionsType> {
  /** Start a fresh builder.  Equivalent to `new LokiSinkOptionsBuilder()`. */
  static create(): LokiSinkOptionsBuilder {
    return new LokiSinkOptionsBuilder();
  }

  /** Lowest level this sink sends. */
  withMinLevel(minLevel: LogLevel): this {
    return this.set('minLevel', minLevel);
  }

  /** Loki base URL. */
  withUrl(url: string): this {
    return this.set('url', url);
  }

  /** Static stream labels — never per-record values. */
  withLabels(labels: Readonly<Record<string, string>>): this {
    return this.set('labels', labels);
  }

  /** `X-Scope-OrgID` tenant header. */
  withTenantId(tenantId: string): this {
    return this.set('tenantId', tenantId);
  }

  /** Attach source, display name and fields as structured metadata. */
  withStructuredMetadata(structuredMetadata: boolean): this {
    return this.set('structuredMetadata', structuredMetadata);
  }

  /** Line format: `text` or `json`. */
  withFormat(format: LokiLineFormat): this {
    return this.set('format', format);
  }

  /** Per-request timeout in milliseconds. */
  withRequestTimeoutMs(requestTimeoutMs: number): this {
    return this.set('requestTimeoutMs', requestTimeoutMs);
  }

  /** Extra request headers — credentials belong here, not in HOCON. */
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

/** Validates resolved {@link LokiSinkOptionsType} settings. */
export class LokiSinkOptionsValidator extends OptionsValidator<LokiSinkOptionsType> {
  constructor() {
    super('LokiSinkOptions');
  }

  protected rules(s: Partial<LokiSinkOptionsType>): void {
    if (s.minLevel !== undefined && !isLogLevel(s.minLevel)) {
      this.fail('minLevel', LOG_LEVEL_REASON, s.minLevel);
    }
    if (s.url === undefined) this.fail('url', 'is required');
    this.url('url', ['http', 'https']);
    this.oneOf('format', ['text', 'json']);
    this.nonEmptyString('tenantId');
    this.positiveInt('requestTimeoutMs');
    for (const [name, value] of Object.entries(s.labels ?? {})) {
      if (!LOKI_LABEL_PATTERN.test(name)) {
        this.fail(`labels.${name}`, 'must match [a-zA-Z_][a-zA-Z0-9_]*', name);
      }
      if (typeof value !== 'string' || value === '') {
        this.fail(`labels.${name}`, 'must be a non-empty string', value);
      }
    }
    validateDeliveryOptions('LokiSinkOptions', s.delivery);
  }
}

/** Whether `actor-ts.logger.sinks.loki.enabled` asks for this sink. */
export function isLokiSinkEnabled(config: Config): boolean {
  return isSinkEnabled(config, ConfigKeys.logger.sinks.loki);
}

/**
 * Read `actor-ts.logger.sinks.loki.*`.  An empty string counts as unset,
 * since the reference block ships empty placeholders so the keys are
 * discoverable.
 */
export function readLokiSinkOptionsFromConfig(config: Config): Partial<LokiSinkOptionsType> {
  const root = ConfigKeys.logger.sinks.loki;
  const out: { -readonly [K in keyof LokiSinkOptionsType]?: LokiSinkOptionsType[K] } = {};
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
  const tenantId = text('tenant-id');
  if (tenantId !== undefined) out.tenantId = tenantId;
  if (config.hasPath(path('format'))) out.format = config.getString(path('format')) as LokiLineFormat;
  if (config.hasPath(path('structured-metadata'))) {
    out.structuredMetadata = config.getBoolean(path('structured-metadata'));
  }
  if (config.hasPath(path('request-timeout'))) {
    out.requestTimeoutMs = config.getDuration(path('request-timeout'));
  }
  const service = text('labels.service');
  if (service !== undefined) out.labels = { service };
  const delivery = readDeliveryOptionsFromConfig(config, root);
  if (delivery !== undefined) out.delivery = delivery;
  return out;
}

/**
 * Accepted input for the {@link LokiSink} constructor: the fluent
 * {@link LokiSinkOptionsBuilder} OR a plain {@link LokiSinkOptionsType}
 * object.
 */
export type LokiSinkOptions = LokiSinkOptionsBuilder | LokiSinkOptionsType;
/** Value alias so `LokiSinkOptions.create()` resolves to the builder. */
export const LokiSinkOptions = LokiSinkOptionsBuilder;
