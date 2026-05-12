import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import type { BrokerCommonSettings } from './BrokerSettings.js';

/** Inbound AMQP delivery handed to subscribers. */
export interface AmqpDelivery {
  readonly queue: string;
  readonly content: Uint8Array;
  readonly properties: Readonly<Record<string, unknown>>;
  /** Acknowledgement token — forward to the actor as `{ kind: 'ack', delivery }` to ack. */
  readonly ackToken: number;
}

/** Outbound publish — routed through `exchange` with `routingKey`. */
export interface AmqpPublish {
  readonly exchange: string;
  readonly routingKey: string;
  readonly content: Uint8Array | string;
  readonly persistent?: boolean;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly contentType?: string;
}

export interface AmqpQueueBinding {
  readonly queue: string;
  readonly exchange?: string;
  readonly routingKey?: string;
  readonly target: ActorRef<AmqpDelivery>;
}

export interface AmqpActorSettings extends BrokerCommonSettings {
  /** AMQP URL (`amqp://user:pass@host:5672/vhost`). */
  readonly url?: string;
  /** Number of unacked messages a consumer holds at once.  Default: 1. */
  readonly prefetch?: number;
  /** Queues + bindings + targets to set up after connect. */
  readonly bindings?: ReadonlyArray<AmqpQueueBinding>;
  /** Whether to auto-ack consumed deliveries.  Default: true. */
  readonly autoAck?: boolean;
}

export type AmqpCmd =
  | { readonly kind: 'publish'; readonly publish: AmqpPublish }
  | { readonly kind: 'ack'; readonly delivery: AmqpDelivery }
  | { readonly kind: 'nack'; readonly delivery: AmqpDelivery; readonly requeue?: boolean };

/**
 * AMQP 0.9.1 actor backed by `amqplib`.  One connection, one channel
 * shared by producer + consumers.  Bindings (queue↔exchange↔routingKey)
 * are configured up-front in settings; runtime additions go through
 * `tell({ kind: 'subscribe', ... })` (currently out-of-scope — add when
 * needed).
 *
 * autoAck=true (default) means the consumer acks the message when it
 * was *delivered* to the actor, not when the actor finished
 * processing.  For at-least-once-with-processing, set autoAck=false
 * and have your handler tell back `{ kind: 'ack' / 'nack', delivery }`.
 */
export class AmqpActor extends BrokerActor<AmqpActorSettings, AmqpCmd, AmqpPublish> {
  private connection: AmqpConnectionLike | null = null;
  private channel: AmqpChannelLike | null = null;
  /** Map ackToken → underlying amqplib message object (we never expose amqplib types upward). */
  private readonly pendingAcks = new Map<number, AmqpRawMessage>();
  private nextAckToken = 1;

  constructor(settings: Partial<AmqpActorSettings> = {}) { super(settings); }

  protected configKey(): string { return ConfigKeys.io.broker.amqp; }
  protected builtInDefaults(): Partial<AmqpActorSettings> {
    return { prefetch: 1, autoAck: true };
  }
  protected readSettingsFromConfig(c: Config): Partial<AmqpActorSettings> {
    const out: { -readonly [K in keyof AmqpActorSettings]?: AmqpActorSettings[K] } = {};
    if (c.hasPath('url')) out.url = c.getString('url');
    if (c.hasPath('prefetch')) out.prefetch = c.getInt('prefetch');
    if (c.hasPath('autoAck')) out.autoAck = c.getBoolean('autoAck');
    return out;
  }
  protected requiredSettings(): ReadonlyArray<keyof AmqpActorSettings> { return ['url']; }
  protected endpointLabel(): string { return this.settings.url ?? '<unknown>'; }

  protected async connectImpl(): Promise<void> {
    const amqp = await amqpLazy.get();
    this.connection = await amqp.connect(this.settings.url!);
    this.channel = await this.connection.createChannel();
    await this.channel.prefetch(this.settings.prefetch ?? 1);
    this.connection.on('error', (e: Error) => this.handleConnectionLost(e));
    this.connection.on('close', () => this.handleConnectionLost(new Error('amqp connection closed')));

    for (const b of this.settings.bindings ?? []) {
      await this.channel.assertQueue(b.queue, { durable: true });
      if (b.exchange) {
        await this.channel.bindQueue(b.queue, b.exchange, b.routingKey ?? '');
      }
      const target = b.target;
      const queueName = b.queue;
      await this.channel.consume(queueName, (msg) => {
        if (!msg) return;
        const ackToken = this.nextAckToken++;
        if (this.settings.autoAck) {
          try { this.channel?.ack(msg); } catch { /* ignore */ }
        } else {
          this.pendingAcks.set(ackToken, msg);
        }
        target.tell({
          queue: queueName,
          content: msg.content,
          properties: msg.properties ?? {},
          ackToken,
        });
      }, { noAck: false });
    }
  }

  protected async disconnectImpl(): Promise<void> {
    this.pendingAcks.clear();
    try { await this.channel?.close(); } catch { /* ignore */ }
    this.channel = null;
    try { await this.connection?.close(); } catch { /* ignore */ }
    this.connection = null;
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<AmqpPublish>): Promise<void> {
    if (!this.channel) throw new Error('AmqpActor: channel not open');
    const p = env.payload;
    const content = p.content instanceof Uint8Array
      ? p.content
      : new TextEncoder().encode(p.content);
    const ok = this.channel.publish(p.exchange, p.routingKey, content, {
      persistent: p.persistent ?? true,
      headers: p.headers,
      contentType: p.contentType,
    });
    if (!ok) {
      // Channel-side backpressure — the buffer in amqplib is full.
      // Wait for `drain` then resolve.  amqplib emits drain on the channel.
      await new Promise<void>((resolve) => {
        this.channel?.once('drain', () => resolve());
      });
    }
  }

  override onReceive(cmd: AmqpCmd): void {
    if (cmd.kind === 'publish') {
      this.enqueueOutbound(cmd.publish);
      return;
    }
    if (cmd.kind === 'ack') {
      const raw = this.pendingAcks.get(cmd.delivery.ackToken);
      if (raw && this.channel) {
        try { this.channel.ack(raw); } catch { /* ignore */ }
        this.pendingAcks.delete(cmd.delivery.ackToken);
      }
      return;
    }
    // nack
    const raw = this.pendingAcks.get(cmd.delivery.ackToken);
    if (raw && this.channel) {
      try { this.channel.nack(raw, false, cmd.requeue ?? true); } catch { /* ignore */ }
      this.pendingAcks.delete(cmd.delivery.ackToken);
    }
  }
}

/* ----------------------------- internals -------------------------------- */

interface AmqpRawMessage {
  content: Uint8Array;
  properties?: Record<string, unknown>;
}

interface AmqpChannelLike {
  prefetch(count: number): Promise<void>;
  assertQueue(queue: string, opts: { durable?: boolean }): Promise<unknown>;
  bindQueue(queue: string, exchange: string, routingKey: string): Promise<unknown>;
  consume(
    queue: string, cb: (msg: AmqpRawMessage | null) => void,
    opts: { noAck?: boolean },
  ): Promise<unknown>;
  publish(
    exchange: string, routingKey: string, content: Uint8Array,
    opts: { persistent?: boolean; headers?: Readonly<Record<string, unknown>>; contentType?: string },
  ): boolean;
  ack(msg: AmqpRawMessage): void;
  nack(msg: AmqpRawMessage, allUpTo: boolean, requeue: boolean): void;
  once(event: 'drain', cb: () => void): void;
  close(): Promise<void>;
}

interface AmqpConnectionLike {
  createChannel(): Promise<AmqpChannelLike>;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: () => void): void;
  close(): Promise<void>;
}

interface AmqpLibModule {
  connect(url: string): Promise<AmqpConnectionLike>;
}

const amqpLazy: Lazy<Promise<AmqpLibModule>> = Lazy.of(
  () => lazyImportModule<AmqpLibModule>('amqplib', { context: 'AmqpActor' }),
);
