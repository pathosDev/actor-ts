import { LogLevel } from '../Logger.js';
import { OptionsBuilder } from '../util/OptionsBuilder.js';
import { OptionsValidator } from '../util/OptionsValidator.js';
import { jsonSafeReplacer, normaliseArg } from './JsonSafe.js';
import { isLogLevel, logLevelName, LOG_LEVEL_REASON } from './LogLevelName.js';
import type { LogRecord } from './LogRecord.js';
import type { LogSink } from './LogSink.js';
import { SinkReporter } from './SinkReporter.js';

/**
 * Built-in default for {@link SentrySinkOptionsType.minLevel}.
 *
 * `Warn`, not `Info`, and deliberately stricter than every other sink.
 * Sentry is an error tracker priced per event; pointing a debug firehose
 * at it is a billing incident rather than a configuration preference, and
 * the signal an on-call engineer relies on drowns either way.
 */
export const DEFAULT_SENTRY_MIN_LEVEL = LogLevel.Warn;

/**
 * The part of a Sentry SDK this adapter uses.
 *
 * Structural, and never imported: the user passes their own
 * `@sentry/node` (or `@sentry/bun`, or a browser build), exactly as the
 * OpenTelemetry adapters take the user's `@opentelemetry/api`.  That keeps
 * the framework free of the dependency, free of its version churn, and —
 * most importantly — using the *same* client the application already
 * configured, so releases, environments, breadcrumbs and any existing
 * instrumentation all line up.
 */
export type SentrySdkLike = {
  captureException(error: unknown, hint?: { extra?: Record<string, unknown> }): unknown;
  captureMessage(message: string, level?: string): unknown;
  /**
   * Sentry's structured-logs product.  Absent on older SDKs and when the
   * feature is off, which is why every call site checks.
   */
  readonly logger?: {
    debug(message: string, attributes?: Record<string, unknown>): void;
    info(message: string, attributes?: Record<string, unknown>): void;
    warn(message: string, attributes?: Record<string, unknown>): void;
    error(message: string, attributes?: Record<string, unknown>): void;
  };
};

/** Plain options-object shape accepted by {@link sentrySink}. */
export type SentrySinkOptionsType = {
  /** Your `@sentry/node` (or equivalent) import, already initialised. */
  readonly sdk: SentrySdkLike;
  /** Records below this level are not sent.  Default `warn`. */
  readonly minLevel?: LogLevel;
  /**
   * Also forward records to Sentry's structured-logs product when the SDK
   * exposes it.  Default `true`.
   */
  readonly sendLogs?: boolean;
};

/** Fluent builder for {@link SentrySinkOptionsType}. */
export class SentrySinkOptionsBuilder extends OptionsBuilder<SentrySinkOptionsType> {
  /** Start a fresh builder.  Equivalent to `new SentrySinkOptionsBuilder()`. */
  static create(): SentrySinkOptionsBuilder {
    return new SentrySinkOptionsBuilder();
  }

  /** The Sentry SDK namespace to delegate to. */
  withSdk(sdk: SentrySdkLike): this {
    return this.set('sdk', sdk);
  }

  /** Lowest level this sink forwards. */
  withMinLevel(minLevel: LogLevel): this {
    return this.set('minLevel', minLevel);
  }

  /** Forward records to Sentry's structured-logs product as well. */
  withSendLogs(sendLogs: boolean): this {
    return this.set('sendLogs', sendLogs);
  }
}

/** Validates resolved {@link SentrySinkOptionsType} settings. */
export class SentrySinkOptionsValidator extends OptionsValidator<SentrySinkOptionsType> {
  constructor() {
    super('SentrySinkOptions');
  }

  protected rules(s: Partial<SentrySinkOptionsType>): void {
    if (s.minLevel !== undefined && !isLogLevel(s.minLevel)) {
      this.fail('minLevel', LOG_LEVEL_REASON, s.minLevel);
    }
    if (typeof s.sdk?.captureException !== 'function' || typeof s.sdk?.captureMessage !== 'function') {
      this.fail('sdk', 'must be a Sentry SDK with captureException and captureMessage', s.sdk);
    }
  }
}

/**
 * Accepted input for {@link sentrySink}: the fluent
 * {@link SentrySinkOptionsBuilder} OR a plain
 * {@link SentrySinkOptionsType} object.
 */
export type SentrySinkOptions = SentrySinkOptionsBuilder | SentrySinkOptionsType;
/** Value alias so `SentrySinkOptions.create()` resolves to the builder. */
export const SentrySinkOptions = SentrySinkOptionsBuilder;

/**
 * Forward records to Sentry through the SDK the application already runs.
 *
 *     const sentry = await import('@sentry/node');
 *     sentry.init({ dsn: process.env['SENTRY_DSN'] });
 *
 *     const sentrySinkOptions = SentrySinkOptions.create().withSdk(sentry);
 *     const systemOptions = ActorSystemOptions.create()
 *       .withLogSinks([new ConsoleSink(), sentrySink(sentrySinkOptions)]);
 *
 * **A factory, not a class**, mirroring `otelLogger` — the same
 * passthrough shape, for the same reason: the SDK is the user's, the
 * framework never imports it, and there is no peer dependency to declare.
 *
 * **Why delegate instead of speaking the envelope protocol.**  Sentry's
 * wire format is documented and could be hand-rolled, but what makes
 * Sentry useful is not transport — it is grouping, stack-trace processing,
 * release and environment detection, breadcrumbs, and interop with the
 * instrumentation an application already has.  A hand-rolled sink would
 * produce visibly worse issues while duplicating a transport that is
 * already running in the process.
 *
 * **Not a batching sink.**  The SDK owns its own queue and transport, and
 * holding a `captureException` behind a two-second flush timer is exactly
 * wrong for the one record most likely to precede a crash.
 */
export function sentrySink(options: SentrySinkOptions): LogSink {
  const settings = { ...(options as Partial<SentrySinkOptionsType>) };
  new SentrySinkOptionsValidator().validate(settings);
  return new SentryLogSink(
    settings.sdk!,
    settings.minLevel ?? DEFAULT_SENTRY_MIN_LEVEL,
    settings.sendLogs ?? true,
  );
}

class SentryLogSink implements LogSink {
  readonly name = 'sentry';
  private readonly reporter = new SinkReporter('sentry');

  constructor(
    private readonly sdk: SentrySdkLike,
    readonly minLevel: LogLevel,
    private readonly sendLogs: boolean,
  ) {}

  /**
   * Errors become Sentry **issues**; everything else that passes the level
   * gate goes to the **logs** product, when the SDK has one.
   *
   * A warning is not an issue — turning one into a tracked, assignable,
   * alert-firing event is how a Sentry project becomes noise nobody reads.
   */
  write(record: LogRecord): void {
    // The two calls are guarded separately: a broken or half-initialised
    // client must not take the logging pipeline with it, and one failing
    // says nothing about the other.
    if (record.level >= LogLevel.Error) this.captureError(record);
    if (this.sendLogs) this.forwardToLogs(record);
  }

  /**
   * Error-level records become Sentry issues.
   *
   * An `Error` argument goes through `captureException`, which is what
   * gives Sentry a real stack to group on.  Without one there is nothing to
   * group *by*, so the message itself is captured instead — a worse issue,
   * but a visible one.
   */
  private captureError(record: LogRecord): void {
    const error = record.args?.find((argument): argument is Error => argument instanceof Error);
    try {
      if (error !== undefined) {
        this.sdk.captureException(error, { extra: this.extraFor(record) });
      } else {
        this.sdk.captureMessage(record.message, 'error');
      }
    } catch (failure) {
      this.reporter.report('captureException/captureMessage threw', failure);
    }
  }

  private forwardToLogs(record: LogRecord): void {
    const logger = this.sdk.logger;
    if (logger === undefined) return;
    const method = logger[logLevelName(record.level) as 'debug' | 'info' | 'warn' | 'error'];
    if (typeof method !== 'function') return;
    try {
      method.call(logger, record.message, this.extraFor(record));
    } catch (failure) {
      this.reporter.report('logger call threw', failure);
    }
  }

  /**
   * What Sentry shows alongside the event.  The actor path is the single
   * most useful thing here — it is what turns "something threw" into
   * "the order entity for tenant acme threw".
   */
  private extraFor(record: LogRecord): Record<string, unknown> {
    const extra: Record<string, unknown> = { ...record.fields };
    if (record.source !== undefined) extra['actor.path'] = record.source;
    if (record.displayName !== undefined) extra['actor.name'] = record.displayName;
    if (record.args !== undefined && record.args.length > 0) {
      const rest = record.args.filter((argument) => !(argument instanceof Error));
      if (rest.length > 0) extra['args'] = safeJson(rest.map(normaliseArg));
    }
    return extra;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, jsonSafeReplacer()) ?? '[]';
  } catch {
    return '[]';
  }
}
