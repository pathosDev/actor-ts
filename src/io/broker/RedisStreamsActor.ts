import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import {
  REDIS_STREAMS_COMMAND_RETRY_DELAY_MS,
  REDIS_STREAMS_WARN_DEDUPLICATION_WINDOW_MS,
} from '../Constants.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { toBrokerDriverTls } from './BrokerTls.js';
import type { BrokerDriverTlsOptions } from './BrokerTls.js';
import { RedisStreamsOptionsValidator } from './RedisStreamsOptions.js';
import type { RedisStreamsOptions, RedisStreamsOptionsType } from './RedisStreamsOptions.js';

/** Inbound entry from a Redis stream. */
export type RedisStreamEntry = {
  readonly stream: string;
  readonly id: string;          // e.g. '1689000000000-0'
  readonly fields: Readonly<Record<string, string>>;
};

/** Outbound publish — adds an entry to a Redis stream via XADD. */
export type RedisStreamPublish = {
  readonly stream: string;
  readonly fields: Readonly<Record<string, string>>;
  /** Optional `MAXLEN ~ N` cap.  Drops oldest when set. */
  readonly maxLenApprox?: number;
};

type PublishCommand = { readonly kind: 'publish'; readonly publish: RedisStreamPublish };
type AcknowledgmentCommand = {
  readonly kind: 'acknowledgment';
  readonly stream: string;
  readonly id: string;
};

export type RedisStreamsCommand = PublishCommand | AcknowledgmentCommand;

/**
 * Redis-Streams actor.  Wraps `ioredis` (already a peer-dep used by
 * the cache layer).  Producer + optional consumer in one actor.
 *
 * Consumer mode uses `XREADGROUP` with a stable consumer name; entries
 * are delivered to `target` and are NOT auto-acked — the caller must
 * `tell({ kind: 'acknowledgment', stream, id })` after processing for at-least-
 * once semantics with crash-recovery.  For at-most-once, ack
 * immediately on delivery.
 */
export class RedisStreamsActor
  extends BrokerActor<RedisStreamsOptionsType, RedisStreamsCommand, RedisStreamPublish> {
  private redis: IoredisClientLike | null = null;
  private redisProducer: IoredisClientLike | null = null;
  private consumerLoopRunning = false;
  /**
   * The clients whose failure signals are allowed to escalate (#742).
   *
   * A client is added only once the whole connect handshake has succeeded,
   * and the set is emptied the instant one of them fails or the transport is
   * torn down.  Both halves matter, and neither is defensive coding:
   *
   * - **Before** the handshake finishes, an `error`/`close` emit is already
   *   reported — `connect()` or the bootstrap command rejects with it, and
   *   `_tryConnect` turns that into a backoff *and* circuit-breaker step.
   *   Escalating here as well would schedule a second, independent reconnect
   *   for the same failure, and the two would then race each other for the
   *   rest of the actor's life.
   * - **After** a failure, the listeners of the dead generation stay attached
   *   until ioredis releases them, and `handleConnectionLost`'s own guard
   *   admits state `'connecting'` — so a straggler emit from the old client
   *   would abort the reconnect it is being replaced by.
   */
  private readonly escalatingClients = new Set<IoredisClientLike>();
  /** Message of the last consumer-loop failure that was actually logged. */
  private lastLoggedLoopFailure = '';
  /** When that log was written, for {@link REDIS_STREAMS_WARN_DEDUPLICATION_WINDOW_MS}. */
  private lastLoggedLoopFailureAtMs = 0;
  /** Identical failures swallowed since then — reported with the next one. */
  private suppressedLoopFailures = 0;

  constructor(options: RedisStreamsOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.redisStreams; }
  protected builtInDefaultOptions(): Partial<RedisStreamsOptionsType> {
    return { blockMs: 5_000 };
  }
  protected readOptionsFromConfig(config: Config): Partial<RedisStreamsOptionsType> {
    const out: { -readonly [K in keyof RedisStreamsOptionsType]?: RedisStreamsOptionsType[K] } = {};
    if (config.hasPath('url')) out.url = config.getString('url');
    if (config.hasPath('streams')) out.streams = config.getStringList('streams');
    if (config.hasPath('blockMs')) out.blockMs = config.getDuration('blockMs');
    if (config.hasPath('consumerGroup')) {
      const consumerGroupConfig = config.getConfig('consumerGroup');
      out.consumerGroup = {
        group: consumerGroupConfig.getString('group'),
        consumer: consumerGroupConfig.getString('consumer'),
        createIfMissing: consumerGroupConfig.hasPath('createIfMissing') ? consumerGroupConfig.getBoolean('createIfMissing') : undefined,
      };
    }
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof RedisStreamsOptionsType> { return ['url']; }
  protected override optionsValidator(): RedisStreamsOptionsValidator { return new RedisStreamsOptionsValidator(); }
  protected endpointLabel(): string { return this.options.url ?? '<unknown>'; }

  /** @internal Test seam — override to inject a fake ioredis module. */
  protected ioredisModule(): Promise<IoredisModuleLike> { return ioredisLazy.get(); }

  /**
   * Build one ioredis client.  Override in a test subclass to inject a fake —
   * mirrors `NatsActor.createNatsConnection`, and keeps the `ioredis`
   * peer-dependency out of the unit tests entirely.
   *
   * `lazyConnect` is what makes {@link connectImplementation} able to *fail*
   * (#742).  Without it the constructor returns a client that is merely
   * "connecting", every command is queued behind the offline queue, and the
   * handshake reports success against a Redis nobody has reached — so the base
   * class publishes `BrokerConnected` for a dead broker and only discovers
   * otherwise if the application happens to publish something.  With it, the
   * awaited `connect()` below is the handshake, and a refused connection
   * reaches `_tryConnect`'s catch like every other broker's does.
   *
   * Overriding this replaces the constructor options, TLS included — override
   * {@link ioredisModule} instead when a test wants to *observe* them.
   */
  protected async createClient(url: string): Promise<IoredisClientLike> {
    const ioredis = await this.ioredisModule();
    const Constructor = ioredis.default ?? (ioredis as unknown as IoredisConstructor);
    const driverTls = toBrokerDriverTls(this.options.tls);
    return new Constructor(
      url,
      driverTls === undefined ? { lazyConnect: true } : { lazyConnect: true, tls: driverTls },
    );
  }

  protected async connectImplementation(): Promise<void> {
    // A fresh generation deserves a fresh warn budget: suppressing the first
    // failure after a reconnect because it matches one from before the outage
    // would hide the most informative record there is.
    this.resetLoopFailureLog();
    const producer = await this.openClient();
    this.redisProducer = producer;
    const { consumerGroup, streams, target } = this.options;
    let consumer: IoredisClientLike | null = null;
    if (consumerGroup && streams && target) {
      consumer = await this.openClient();
      this.redis = consumer;
      await this.createConsumerGroups(consumer, consumerGroup);
    }
    // Arm the failure listeners only now — see {@link escalatingClients}.
    this.escalatingClients.add(producer);
    if (consumer) {
      this.escalatingClients.add(consumer);
      this.consumerLoopRunning = true;
      void this.consumerLoop(consumer);
    }
  }

  protected async disconnectImplementation(): Promise<void> {
    this.consumerLoopRunning = false;
    // Disarm *before* awaiting `quit()`, which makes both clients emit `end`
    // and `close`.  Nothing observable depends on the order today — every
    // caller of this method has already put the base class into a state
    // (`_stopped`, or `'disconnected'`) that `handleConnectionLost` refuses —
    // so this is deliberately not relying on that.  Which of the base class's
    // guards happens to be standing is not this method's business, and the
    // failure it would let through is a teardown reported as an outage.
    this.escalatingClients.clear();
    const producer = this.redisProducer;
    const consumer = this.redis;
    this.redisProducer = null;
    this.redis = null;
    try { await producer?.quit(); } catch { /* ignore */ }
    try { await consumer?.quit(); } catch { /* ignore */ }
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<RedisStreamPublish>): Promise<void> {
    if (!this.redisProducer) throw new Error('RedisStreamsActor: producer not connected');
    const publish = env.payload;
    const args: string[] = [publish.stream];
    if (publish.maxLenApprox !== undefined) {
      args.push('MAXLEN', '~', String(publish.maxLenApprox));
    }
    args.push('*');  // auto-id
    for (const [fieldName, fieldValue] of Object.entries(publish.fields)) { args.push(fieldName, fieldValue); }
    await this.redisProducer.xadd(...args);
  }

  protected override onCommand(command: RedisStreamsCommand): void {
    match(command)
      .with({ kind: 'publish' }, (c) => this.onPublish(c))
      .with({ kind: 'acknowledgment' }, (c) => this.onAcknowledgment(c))
      .exhaustive();
  }

  /* ----------------------------- internals ----------------------------- */

  private onPublish(command: PublishCommand): void {
    this.enqueueOutbound(command.publish);
  }

  /**
   * Fire-and-forget — awaiting the `XACK` would stall the mailbox behind a
   * broker round-trip.  A failure is logged and the entry stays in the
   * group's pending list; nothing reclaims it yet (see #462).
   */
  private onAcknowledgment(command: AcknowledgmentCommand): void {
    if (this.redis && this.options.consumerGroup) {
      void this.redis.xack(command.stream, this.options.consumerGroup.group, command.id)
        .catch((e: Error) => this.log.warn(`xack failed: ${e.message}`));
    }
  }

  /**
   * Create a client, wire its failure signals, and complete its handshake.
   *
   * The listeners go on before `connect()` rather than after, for a reason
   * that has nothing to do with this actor's state machine: an ioredis client
   * with no `error` listener routes the emit to Node's unhandled-`error`
   * path, which prints `[ioredis] Unhandled error event` at best and takes
   * the process down at worst.  The window being closed is the handshake
   * itself, which is exactly when a refused connection emits.
   */
  private async openClient(): Promise<IoredisClientLike> {
    const client = await this.createClient(this.options.url!);
    client.on('error', (error) => this.onClientFailure(client, error ?? new Error('redis client error')));
    client.on('close', () => this.onClientFailure(client, new Error('redis connection closed')));
    client.on('end', () => this.onClientFailure(client, new Error('redis connection ended')));
    try {
      await client.connect();
    } catch (e) {
      // Nothing has adopted this client, so `disconnectImplementation` will
      // not find it — release its socket here or the failed attempt keeps a
      // handle (and ioredis's own retry timer) alive for the actor's lifetime.
      try { await client.quit(); } catch { /* already dead */ }
      throw e;
    }
    return client;
  }

  /**
   * Bootstrap the consumer group on `client`.
   *
   * Runs on every connect, not just the first, and that is the point: the
   * group lives in Redis, so a restart that lost the dataset takes it with
   * it, and `XREADGROUP` then fails `NOGROUP` forever.  Re-creating it here
   * is what makes {@link consumerLoop} routing a `NOGROUP` through the
   * reconnect path self-healing rather than a slower spin (#742).
   */
  private async createConsumerGroups(
    client: IoredisClientLike,
    consumerGroup: NonNullable<RedisStreamsOptionsType['consumerGroup']>,
  ): Promise<void> {
    if (!(consumerGroup.createIfMissing ?? true)) return;
    for (const stream of this.options.streams ?? []) {
      try { await client.xgroup('CREATE', stream, consumerGroup.group, '$', 'MKSTREAM'); }
      catch (e) {
        // BUSYGROUP = group already exists; ignore.  Anything else → log.
        if (!(e as Error).message.includes('BUSYGROUP')) {
          this.log.warn(`xgroup CREATE failed for '${stream}/${consumerGroup.group}': ${(e as Error).message}`);
        }
      }
    }
  }

  /**
   * A driver-level failure signal from one of the live clients (#742).
   *
   * Repeats collapse in `handleConnectionLost`, whose state guard admits only
   * `'connected'`/`'connecting'` — so ioredis emitting `error` once per
   * internal retry for the length of an outage still produces exactly one
   * reconnect cycle, and the framework's backoff (rather than ioredis's) is
   * what paces it.
   */
  private onClientFailure(client: IoredisClientLike, cause: Error): void {
    if (!this.escalatingClients.has(client)) return;
    // The whole generation is going, not just the client that spoke first:
    // `handleConnectionLost` tears down the transport as a unit.
    this.escalatingClients.clear();
    this.handleConnectionLost(cause);
  }

  /**
   * Read this connection's share of the group until the connection is gone.
   *
   * The live client is a parameter, and every guard tests it by identity
   * rather than reading `this.redis` — that is what binds the loop to the
   * generation that started it.  `consumerLoopRunning` alone cannot: a
   * reconnect clears it in `disconnectImplementation` and sets it again in
   * `connectImplementation`, so a loop suspended in `xreadgroup` across that
   * window re-reads it as `true` and carries on beside the new loop, two
   * readers sharing one consumer name (#982).  Under the old code that window
   * was rare because nothing on this path ever triggered a reconnect; now
   * that a lost connection does, closing it is part of the same change.
   */
  private async consumerLoop(client: IoredisClientLike): Promise<void> {
    const consumerGroup = this.options.consumerGroup!;
    const blockMs = this.options.blockMs ?? 5_000;
    while (this.consumerLoopRunning && this.redis === client) {
      try {
        const args: string[] = ['GROUP', consumerGroup.group, consumerGroup.consumer,
          'BLOCK', String(blockMs), 'COUNT', '32',
          'STREAMS', ...(this.options.streams ?? []),
          ...(this.options.streams ?? []).map(() => '>'),
        ];
        const result = await client.xreadgroup(...args) as XReadResult | null;
        if (!result) continue;
        for (const [stream, entries] of result) {
          for (const [id, fields] of entries) {
            const obj: Record<string, string> = {};
            for (let i = 0; i + 1 < fields.length; i += 2) {
              obj[fields[i]!] = fields[i + 1]!;
            }
            this.options.target?.tell({ stream, id, fields: obj });
          }
        }
      } catch (e) {
        if (!this.consumerLoopRunning || this.redis !== client) return;
        const error = e instanceof Error ? e : new Error(String(e));
        // The classification is the whole fix (#742).  Retrying a
        // connection-level rejection on the same dead client is what kept
        // `_state` at `'connected'` through an arbitrarily long outage, so
        // the configured `reconnect` policy, the circuit breaker and the
        // `BrokerDisconnected` health signal never saw it.
        if (isConnectionLevelRedisError(error)) {
          this.handleConnectionLost(error);
          // Leaving is not optional: `handleConnectionLost` re-enters
          // `connectImplementation`, which starts a *new* loop on a new
          // client.  Staying would leave two loops sharing one consumer name.
          return;
        }
        this.warnLoopFailure(error);
        await new Promise((resolve) => setTimeout(resolve, REDIS_STREAMS_COMMAND_RETRY_DELAY_MS));
      }
    }
  }

  /**
   * Log a command-level consumer-loop failure, at most once per
   * {@link REDIS_STREAMS_WARN_DEDUPLICATION_WINDOW_MS} per distinct message.
   *
   * A changed message is logged immediately and resets the window — the
   * failure mode being dampened is one stuck command repeating, and treating
   * a *new* failure as more of the same is how a rate limit starts hiding the
   * thing it was added to make readable.
   */
  private warnLoopFailure(error: Error): void {
    const now = Date.now();
    const repeated = error.message === this.lastLoggedLoopFailure;
    if (repeated && now - this.lastLoggedLoopFailureAtMs < REDIS_STREAMS_WARN_DEDUPLICATION_WINDOW_MS) {
      this.suppressedLoopFailures++;
      return;
    }
    const suppressed = this.suppressedLoopFailures > 0
      ? ` (${this.suppressedLoopFailures} identical failure(s) suppressed)`
      : '';
    this.log.warn(`RedisStreams consumer loop error: ${error.message}${suppressed}`);
    this.lastLoggedLoopFailure = error.message;
    this.lastLoggedLoopFailureAtMs = now;
    this.suppressedLoopFailures = 0;
  }

  private resetLoopFailureLog(): void {
    this.lastLoggedLoopFailure = '';
    this.lastLoggedLoopFailureAtMs = 0;
    this.suppressedLoopFailures = 0;
  }
}

/* ----------------------------- internals -------------------------------- */

type XReadResult = Array<[string, Array<[string, string[]]>]>;

/**
 * Message fragments that mark a rejected Redis command as one only a new
 * connection can clear (#742).
 *
 * Matching on text is a concession to the driver, not a preference: ioredis
 * reports a lost socket as a plain `Error` whose message carries the reason,
 * and Redis's own error replies are a bare `-CODE message` line — neither
 * side exposes a stable discriminant to match on instead.  The entries are
 * compared case-insensitively because the two sources disagree on case
 * (`Connection is closed.` from the driver, `NOGROUP …` from the server).
 *
 * The table is the classifier, so it stays beside it rather than moving to
 * `src/io/Constants.ts` — it is driver and protocol vocabulary, not a tuned
 * value anyone would re-tune.
 *
 * `NOGROUP` earns its place for a reason the others do not share: the
 * connection is healthy and the command is well-formed, but the consumer
 * group it names is gone, and {@link RedisStreamsActor.createConsumerGroups}
 * — the only thing that re-creates it — runs on connect.  Routing it here is
 * what turns an indefinite `NOGROUP` spin into a recovery.
 */
const CONNECTION_LEVEL_ERROR_MARKERS: readonly string[] = [
  'connection is closed',
  'connection is already closed',
  "stream isn't writeable",
  'max retries per request',
  'econnrefused',
  'econnreset',
  'epipe',
  'etimedout',
  'ehostunreach',
  'enetunreach',
  'enotfound',
  'nogroup',
  'clusterdown',
];

/** True when `error` needs a fresh connection rather than another attempt. */
function isConnectionLevelRedisError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return CONNECTION_LEVEL_ERROR_MARKERS.some((marker) => message.includes(marker));
}

/** The ioredis lifecycle signals the actor listens for. */
export type IoredisClientEvent = 'error' | 'close' | 'end';

/**
 * Minimal ioredis surface the actor depends on.  Exported so a test seam (a
 * subclass overriding {@link RedisStreamsActor.createClient}) can satisfy the
 * shape without the `ioredis` peer-dependency.
 */
export interface IoredisClientLike {
  connect(): Promise<void>;
  on(event: IoredisClientEvent, listener: (error?: Error) => void): void;
  xadd(...args: string[]): Promise<string>;
  xack(stream: string, group: string, id: string): Promise<number>;
  xgroup(...args: string[]): Promise<unknown>;
  xreadgroup(...args: string[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

/** The ioredis constructor options the actor sets; see {@link RedisStreamsActor.createClient}. */
export type IoredisClientOptionsLike = {
  readonly lazyConnect: boolean;
  /**
   * Certificate material for the dial (#743).  Present only when configured:
   * ioredis reads this option as "negotiate TLS", so an unconditional key
   * would turn a `redis://` dial into a TLS one against a server not serving
   * it.
   */
  readonly tls?: BrokerDriverTlsOptions;
};

export interface IoredisConstructor {
  new (url: string, options: IoredisClientOptionsLike): IoredisClientLike;
}

/** The `ioredis` module surface we use.  Exported as a test seam. */
export type IoredisModuleLike = { default?: IoredisConstructor; };

const ioredisLazy: Lazy<Promise<IoredisModuleLike>> = Lazy.of(
  () => lazyImportModule<IoredisModuleLike>('ioredis', { context: 'RedisStreamsActor' }),
);
