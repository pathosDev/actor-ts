import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { RetiredLeaves } from '../../config/RetiredKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { AMQP_DRAIN_TIMEOUT_MS } from '../Constants.js';
import {
  BrokerAcknowledgmentTracker,
  type BrokerDeliveryReply,
} from './BrokerAcknowledgment.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import {
  DEFAULT_BROKER_ACKNOWLEDGMENT_MODE,
  DEFAULT_BROKER_ACKNOWLEDGMENT_TIMEOUT_MS,
  readBrokerAcknowledgmentOptionsFromConfig,
} from './BrokerOptions.js';
import { toBrokerDriverTls } from './BrokerTls.js';
import type { BrokerDriverTlsOptions } from './BrokerTls.js';
import { AmqpOptionsValidator } from './AmqpOptions.js';
import type { AmqpOptions, AmqpOptionsType } from './AmqpOptions.js';

/** Inbound AMQP delivery handed to subscribers. */
export type AmqpDelivery = {
  readonly queue: string;
  readonly content: Uint8Array;
  readonly properties: Readonly<Record<string, unknown>>;
  /**
   * Acknowledgment token — with `autoAcknowledge: false`, forward the delivery
   * to the actor as `{ kind: 'acknowledgment', delivery }` to ack it.
   */
  readonly ackToken: number;
  /**
   * Where the target replies `{ kind: 'acknowledgment' }` once it has
   * processed the delivery — present only under the default
   * `acknowledgment: 'on-reply'`.  See `acknowledgeDelivery`.
   */
  readonly replyTo?: ActorRef<BrokerDeliveryReply>;
};

/** Outbound publish — routed through `exchange` with `routingKey`. */
export type AmqpPublish = {
  readonly exchange: string;
  readonly routingKey: string;
  readonly content: Uint8Array | string;
  readonly persistent?: boolean;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly contentType?: string;
};

export type AmqpQueueBinding = {
  readonly queue: string;
  readonly exchange?: string;
  readonly routingKey?: string;
  readonly target: ActorRef<AmqpDelivery>;
  /**
   * Queue-assertion options applied at connect time.  Defaults to
   * `{ durable: true }` for safety (matches amqplib's own defaults).
   * Override when the queue was pre-declared with different
   * properties — RabbitMQ rejects a re-assert with mismatched
   * params (PRECONDITION_FAILED) and closes the channel, which
   * masks every subsequent consume/publish as a silent timeout.
   */
  readonly queueOptions?: {
    readonly durable?: boolean;
    readonly autoDelete?: boolean;
    readonly exclusive?: boolean;
  };
};

type PublishCommand = { readonly kind: 'publish'; readonly publish: AmqpPublish };
type AcknowledgmentCommand = { readonly kind: 'acknowledgment'; readonly delivery: AmqpDelivery };
/** `requeue` defaults to `true` — redeliver rather than drop unless told otherwise. */
type NegativeAcknowledgmentCommand = {
  readonly kind: 'negativeAcknowledgment';
  readonly delivery: AmqpDelivery;
  readonly requeue?: boolean;
};

export type AmqpCommand = PublishCommand | AcknowledgmentCommand | NegativeAcknowledgmentCommand;

/**
 * AMQP 0.9.1 actor backed by `amqplib`.  One connection, one channel
 * shared by producer + consumers.  Bindings (queue↔exchange↔routingKey)
 * are configured up-front in options; runtime additions go through
 * `tell({ kind: 'subscribe', ... })` (currently out-of-scope — add when
 * needed).
 *
 * **Acknowledgment** (#976).  With `autoAcknowledge: true` (default) the actor
 * settles each delivery itself, when `acknowledgment` says:
 *
 *   - `'on-reply'` (default) — the actor `ask`s the binding's target with the
 *     delivery and acks it only once the target replied
 *     `{ kind: 'acknowledgment' }`; a `negativeAcknowledgment` reply, any
 *     other reply, or none within `acknowledgmentTimeoutMs` nacks it with
 *     requeue, so RabbitMQ redelivers it → **at-least-once**.  `prefetch`
 *     bounds the deliveries a target has not finished.
 *   - `'on-delivery'` — the actor acks as it hands the delivery to the
 *     target's mailbox → **at-most-once**.  An ack that fails is not followed
 *     by the hand-over: RabbitMQ redelivers that one anyway.
 *
 * A broker that refuses an ack is never silent: a warn line naming the queue,
 * and a `BrokerAcknowledgmentFailed` event.  With `autoAcknowledge: false`
 * the target settles each delivery by telling the actor
 * `{ kind: 'acknowledgment' | 'negativeAcknowledgment', delivery }`.
 */
export class AmqpActor extends BrokerActor<AmqpOptionsType, AmqpCommand, AmqpPublish> {
  private connection: AmqpConnectionLike | null = null;
  private channel: AmqpChannelLike | null = null;
  /** Map ackToken → underlying amqplib message object (we never expose amqplib types upward). */
  private readonly pendingAcks = new Map<number, AmqpRawMessage>();
  private nextAcknowledgmentToken = 1;
  /**
   * The `acknowledgment`-mode replies outstanding on the current channel.
   * Replaced per connection; teardown gives up on every one, since a delivery
   * tag is only valid on the channel it arrived on.
   */
  private acknowledgments: BrokerAcknowledgmentTracker | null = null;

  constructor(options: AmqpOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.amqp.root; }
  protected builtInDefaultOptions(): Partial<AmqpOptionsType> {
    return {
      prefetch: 1,
      autoAcknowledge: true,
      acknowledgment: DEFAULT_BROKER_ACKNOWLEDGMENT_MODE,
      acknowledgmentTimeoutMs: DEFAULT_BROKER_ACKNOWLEDGMENT_TIMEOUT_MS,
    };
  }
  protected readOptionsFromConfig(config: Config): Partial<AmqpOptionsType> {
    return readAmqpOptionsFromConfig(config);
  }
  protected override retiredLeaves(): RetiredLeaves { return RETIRED_AMQP_LEAVES; }
  protected requiredOptions(): ReadonlyArray<keyof AmqpOptionsType> { return ['url']; }
  protected override optionsValidator(): AmqpOptionsValidator { return new AmqpOptionsValidator(); }
  protected endpointLabel(): string { return this.options.url ?? '<unknown>'; }

  /** @internal Test seam — override to inject a fake amqplib module. */
  protected amqpModule(): Promise<AmqpModuleLike> { return amqpLazy.get(); }

  protected async connectImplementation(): Promise<void> {
    const amqp = await this.amqpModule();
    // `socketOptions` is amqplib's own second argument and is where ca / cert
    // / key belong; `undefined` reproduces the one-argument call exactly.
    this.connection = await amqp.connect(this.options.url!, toBrokerDriverTls(this.options.tls));
    const channel = await this.connection.createChannel();
    this.channel = channel;
    this.acknowledgments = new BrokerAcknowledgmentTracker(
      this.options.acknowledgment ?? DEFAULT_BROKER_ACKNOWLEDGMENT_MODE,
      this.options.acknowledgmentTimeoutMs ?? DEFAULT_BROKER_ACKNOWLEDGMENT_TIMEOUT_MS,
    );
    await channel.prefetch(this.options.prefetch ?? 1);
    this.connection.on('error', (e: Error) => this.handleConnectionLost(e));
    this.connection.on('close', () => this.handleConnectionLost(new Error('amqp connection closed')));

    for (const binding of this.options.bindings ?? []) {
      await channel.assertQueue(binding.queue, binding.queueOptions ?? { durable: true });
      if (binding.exchange) {
        await channel.bindQueue(binding.queue, binding.exchange, binding.routingKey ?? '');
      }
      const target = binding.target;
      const queueName = binding.queue;
      await channel.consume(queueName, (message) => {
        if (!message) return;
        this.onDelivery(channel, queueName, target, message);
      }, { noAck: false });
    }
  }

  /**
   * Hand one delivery to its binding's target and settle it as the options
   * say.  Runs on amqplib's callback, not the actor thread — it touches only
   * the channel it was handed and the tracker of that connection.
   */
  private onDelivery(
    channel: AmqpChannelLike,
    queue: string,
    target: ActorRef<AmqpDelivery>,
    message: AmqpRawMessage,
  ): void {
    const ackToken = this.nextAcknowledgmentToken++;
    const delivery: AmqpDelivery = {
      queue,
      content: message.content,
      properties: message.properties ?? {},
      ackToken,
    };
    if (!this.options.autoAcknowledge) {
      this.pendingAcks.set(ackToken, message);
      target.tell(delivery);
      return;
    }
    const acknowledgments = this.acknowledgments;
    if (acknowledgments === null || !acknowledgments.awaitsReply) {
      // `'on-delivery'`: acknowledged as it is handed over.  An ack the broker
      // refused means it will redeliver this one, so it is not handed over as
      // well — that is the path that used to produce a silent duplicate.
      if (this.acknowledgeOn(channel, queue, message)) target.tell(delivery);
      return;
    }
    void acknowledgments.deliver(target, delivery).then(
      () => { this.acknowledgeOn(channel, queue, message); },
      (error: unknown) => { this.requeueOn(channel, queue, message, error as Error); },
    );
  }

  /**
   * Ack `message` on the channel it arrived on.  Returns whether the broker
   * took it.  A channel that has been replaced or closed since is skipped: a
   * delivery tag means nothing on another channel — acking it there would
   * fail the new channel — and RabbitMQ has already requeued every delivery
   * the old one left unacknowledged.
   */
  private acknowledgeOn(channel: AmqpChannelLike, queue: string, message: AmqpRawMessage): boolean {
    if (channel !== this.channel) return false;
    try {
      channel.ack(message);
      return true;
    } catch (error) {
      this.reportAcknowledgmentFailure(queue, error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  /** Nack `message` with requeue, because its target did not acknowledge it. */
  private requeueOn(channel: AmqpChannelLike, queue: string, message: AmqpRawMessage, cause: Error): void {
    if (channel !== this.channel) return;
    this.log.warn(`AmqpActor: delivery from '${queue}' not acknowledged — requeueing it: ${cause.message}`);
    try {
      channel.nack(message, false, true);
    } catch (error) {
      this.reportAcknowledgmentFailure(queue, error instanceof Error ? error : new Error(String(error)));
    }
  }

  protected async disconnectImplementation(): Promise<void> {
    // Every outstanding reply is moot: its delivery tag dies with the channel
    // and RabbitMQ requeues the delivery on its own.
    this.acknowledgments?.cancelAll('AmqpActor: disconnecting before the target replied');
    this.acknowledgments = null;
    this.pendingAcks.clear();
    try { await this.channel?.close(); } catch { /* ignore */ }
    this.channel = null;
    try { await this.connection?.close(); } catch { /* ignore */ }
    this.connection = null;
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<AmqpPublish>): Promise<void> {
    // Captured once: teardown nulls the field, and a wait attached through it
    // after that would attach to nothing and never settle (#981).
    const channel = this.channel;
    if (!channel) throw new Error('AmqpActor: channel not open');
    const publish = env.payload;
    // amqplib's channel.publish needs a Buffer specifically — a
    // plain Uint8Array (which our public `AmqpPublish.content`
    // contract accepts) trips internal buffer-length checks and
    // makes the publish fail SILENTLY: amqplib emits a `channel
    // close` event (caught by handleConnectionLost → reconnect),
    // but never throws back from `publish()`.  We surface that
    // here by coercing to Buffer; Buffer IS a Uint8Array subclass
    // so the public contract still holds.
    const content = typeof publish.content === 'string'
      ? Buffer.from(publish.content)
      : Buffer.isBuffer(publish.content) ? publish.content : Buffer.from(publish.content);
    const ok = channel.publish(publish.exchange, publish.routingKey, content, {
      persistent: publish.persistent ?? true,
      headers: publish.headers,
      contentType: publish.contentType,
    });
    if (!ok) await this.awaitDrain(channel);
  }

  /**
   * How long a full channel buffer may stay full before the channel is given
   * up on.  A method so a test can shorten it; see {@link AMQP_DRAIN_TIMEOUT_MS}.
   */
  protected drainTimeoutMs(): number { return AMQP_DRAIN_TIMEOUT_MS; }

  /**
   * Wait out channel-side backpressure: resolve on `drain`, reject on the
   * channel's `close` or `error` and on {@link drainTimeoutMs} (#981).
   *
   * amqplib emits `close` and `error` on a dying channel and never `drain`, so
   * a wait that listened for `drain` alone had no way to end in exactly the
   * case that makes backpressure last.  It parked `BrokerActor`'s outbound
   * drain loop for good, and every later publish was appended behind it and
   * FIFO-evicted while the actor still read `connected`.  A rejection here is
   * what the base class already handles: the envelope goes back at the head
   * of the buffer and the reconnect cycle starts.
   */
  private awaitDrain(channel: AmqpChannelLike): Promise<void> {
    const timeoutMs = this.drainTimeoutMs();
    return new Promise<void>((resolve, reject) => {
      const settle = (error: Error | null): void => {
        clearTimeout(timer);
        channel.removeListener('drain', onDrain);
        channel.removeListener('close', onClose);
        channel.removeListener('error', onError);
        if (error === null) resolve();
        else reject(error);
      };
      const onDrain = (): void => settle(null);
      const onClose = (): void => settle(new Error('AmqpActor: channel closed while waiting for drain'));
      const onError = (cause?: unknown): void => settle(new Error(
        `AmqpActor: channel failed while waiting for drain: ${cause instanceof Error ? cause.message : String(cause)}`,
      ));
      const timer = setTimeout(
        () => settle(new Error(`AmqpActor: channel did not drain within ${timeoutMs} ms`)),
        timeoutMs,
      );
      channel.once('drain', onDrain);
      channel.once('close', onClose);
      channel.once('error', onError);
    });
  }

  protected override onCommand(command: AmqpCommand): void {
    match(command)
      .with({ kind: 'publish' }, (c) => this.onPublish(c))
      .with({ kind: 'acknowledgment' }, (c) => this.onAcknowledgment(c))
      .with({ kind: 'negativeAcknowledgment' }, (c) => this.onNegativeAcknowledgment(c))
      .exhaustive();
  }

  /* ----------------------------- internals ------------------------------ */

  private onPublish(command: PublishCommand): void {
    this.enqueueOutbound(command.publish);
  }

  /*
   * Settling on the manual path: an unknown token (already settled, or
   * delivered before a reconnect) is a no-op — the broker redelivers what we
   * never acknowledged.  A channel that throws is reported, not swallowed
   * (#976): the delivery is coming back, and a burst of these is the sign of
   * a dying channel.
   */

  private onAcknowledgment(command: AcknowledgmentCommand): void {
    const raw = this.pendingAcks.get(command.delivery.ackToken);
    if (raw && this.channel) {
      this.pendingAcks.delete(command.delivery.ackToken);
      this.acknowledgeOn(this.channel, command.delivery.queue, raw);
    }
  }

  private onNegativeAcknowledgment(command: NegativeAcknowledgmentCommand): void {
    const raw = this.pendingAcks.get(command.delivery.ackToken);
    if (raw && this.channel) {
      this.pendingAcks.delete(command.delivery.ackToken);
      try {
        this.channel.nack(raw, false, command.requeue ?? true);
      } catch (error) {
        this.reportAcknowledgmentFailure(
          command.delivery.queue, error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }
}

/* ----------------------------- HOCON reader ----------------------------- */

/**
 * The camelCase spelling AMQP's own leaf had before #1443, mapped to the leaf
 * that replaced it — see `BrokerActor.retiredLeaves`.
 */
const RETIRED_AMQP_LEAVES: RetiredLeaves = {
  autoAcknowledge: 'auto-acknowledge',
};

/**
 * Read the `actor-ts.io.broker.amqp` block's own leaves off the system config,
 * at the full paths `keys` holds; the reconnect / breaker / buffer leaves are
 * `BrokerActor`'s, and the `acknowledgment` pair is read by the shared
 * `readBrokerAcknowledgmentOptionsFromConfig`.  An unset leaf is omitted, so it falls through to the
 * built-in default.  `bindings` and `tls` have no leaf: one names actors, the
 * other is certificate material.
 */
export function readAmqpOptionsFromConfig(
  config: Config,
  keys: typeof ConfigKeys.io.broker.amqp = ConfigKeys.io.broker.amqp,
): Partial<AmqpOptionsType> {
  const out: { -readonly [K in keyof AmqpOptionsType]?: AmqpOptionsType[K] } = {};
  if (config.hasPath(keys.url)) out.url = config.getString(keys.url);
  if (config.hasPath(keys.prefetch)) out.prefetch = config.getInt(keys.prefetch);
  if (config.hasPath(keys.autoAcknowledge)) out.autoAcknowledge = config.getBoolean(keys.autoAcknowledge);
  return { ...out, ...readBrokerAcknowledgmentOptionsFromConfig(config, keys) };
}

/* ----------------------------- internals -------------------------------- */

/**
 * The amqplib shapes below are exported as test seams, so a subclass
 * overriding {@link AmqpActor.amqpModule} — the injection point the TLS
 * forwarding is asserted through (#743) — can satisfy them without the
 * `amqplib` peer-dep.  Before that seam existed the only way to reach the
 * driver call was to reimplement `connectImplementation` wholesale.
 */
export type AmqpRawMessage = {
  content: Uint8Array;
  properties?: Record<string, unknown>;
};

export interface AmqpChannelLike {
  prefetch(count: number): Promise<void>;
  assertQueue(queue: string, options: { durable?: boolean; autoDelete?: boolean; exclusive?: boolean }): Promise<unknown>;
  bindQueue(queue: string, exchange: string, routingKey: string): Promise<unknown>;
  consume(
    queue: string, onMessage: (message: AmqpRawMessage | null) => void,
    options: { noAck?: boolean },
  ): Promise<unknown>;
  publish(
    exchange: string, routingKey: string, content: Uint8Array,
    options: { persistent?: boolean; headers?: Readonly<Record<string, unknown>>; contentType?: string },
  ): boolean;
  ack(message: AmqpRawMessage): void;
  nack(message: AmqpRawMessage, allUpTo: boolean, requeue: boolean): void;
  once(event: 'drain' | 'close', listener: () => void): void;
  once(event: 'error', listener: (err: Error) => void): void;
  /** Detach a listener added with `once` — amqplib's channel is an `EventEmitter`. */
  removeListener(event: 'drain' | 'close', listener: () => void): void;
  removeListener(event: 'error', listener: (err: Error) => void): void;
  close(): Promise<void>;
}

export interface AmqpConnectionLike {
  createChannel(): Promise<AmqpChannelLike>;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: () => void): void;
  close(): Promise<void>;
}

/** The `amqplib` module surface we use.  Exported as a test seam. */
export interface AmqpModuleLike {
  connect(url: string, socketOptions?: BrokerDriverTlsOptions): Promise<AmqpConnectionLike>;
}

const amqpLazy: Lazy<Promise<AmqpModuleLike>> = Lazy.of(
  () => lazyImportModule<AmqpModuleLike>('amqplib', { context: 'AmqpActor' }),
);
