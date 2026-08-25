import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { NatsOptionsValidator } from './NatsOptions.js';
import type { NatsOptions, NatsOptionsType } from './NatsOptions.js';

/** Inbound NATS message handed to subscribers. */
export type NatsMessage = {
  readonly subject: string;
  readonly payload: Uint8Array;
  /** Reply subject (for request/reply patterns).  Empty when not set. */
  readonly replyTo: string;
};

/** Outbound publish — one NATS message. */
export type NatsPublish = {
  readonly subject: string;
  readonly payload: Uint8Array | string;
  readonly replyTo?: string;
};

/** Publish one message on a subject. */
type PublishCommand = { readonly kind: 'publish'; readonly publish: NatsPublish };

/**
 * Subscribe `target` to `subject`.  The subscription is *desired* state:
 * it is re-established on every reconnect, and one sent while the actor
 * is disconnected lands on the next connect instead of being dropped.
 * Re-subscribing a live subject swaps the target.
 */
type SubscribeCommand = {
  readonly kind: 'subscribe';
  readonly subject: string;
  readonly target: ActorRef<NatsMessage>;
};

/** Drop the subscription for `subject`, on the broker and from the desired set. */
type UnsubscribeCommand = { readonly kind: 'unsubscribe'; readonly subject: string };

export type NatsCommand = PublishCommand | SubscribeCommand | UnsubscribeCommand;

/**
 * NATS-Core (no JetStream) actor backed by the official `nats` peer-dep.
 * Plain pub/sub with optional request/reply via `replyTo`.  For durable
 * streams + consumers, use the sister `JetStreamActor`.
 *
 * Subscriptions — configured via `subscriptions` or added at runtime with
 * `{ kind: 'subscribe', … }` — are held as desired state by
 * {@link BrokerActor} and re-applied on every reconnect, so a connection
 * drop cannot silently leave the actor deaf.
 */
export class NatsActor
  extends BrokerActor<NatsOptionsType, NatsCommand, NatsPublish, ActorRef<NatsMessage>> {
  private nc: NatsConnectionLike | null = null;
  /**
   * Handles owned by the *current* connection, subject → handle.  Wiped
   * on disconnect; the desired set that repopulates it lives in the base
   * class and outlives any one connection.
   */
  private readonly liveSubscriptions = new Map<string, NatsSubscriptionLike>();

  constructor(options: NatsOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.nats; }
  protected builtInDefaultOptions(): Partial<NatsOptionsType> { return {}; }
  protected readOptionsFromConfig(config: Config): Partial<NatsOptionsType> {
    const out: { -readonly [K in keyof NatsOptionsType]?: NatsOptionsType[K] } = {};
    if (config.hasPath('servers')) out.servers = config.getStringList('servers');
    if (config.hasPath('token')) out.token = config.getString('token');
    if (config.hasPath('user')) out.user = config.getString('user');
    if (config.hasPath('password')) out.password = config.getString('password');
    if (config.hasPath('name')) out.name = config.getString('name');
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof NatsOptionsType> { return ['servers']; }
  protected override optionsValidator(): NatsOptionsValidator { return new NatsOptionsValidator(); }
  protected endpointLabel(): string {
    const servers = this.options.servers;
    if (Array.isArray(servers)) return servers.join(',');
    return typeof servers === 'string' ? servers : '';
  }

  /**
   * Build a `NatsConnectionLike`.  Override in a test subclass to inject
   * a mock connection — mirrors `JetStreamActor.createNatsConnection`,
   * and keeps the `nats` peer-dep out of the unit tests.
   */
  protected async createNatsConnection(): Promise<NatsConnectionLike> {
    const nats = await natsLazy.get();
    const servers = Array.isArray(this.options.servers)
      ? [...this.options.servers]
      : [this.options.servers as string];
    return nats.connect({
      servers,
      token: this.options.token,
      user: this.options.user,
      pass: this.options.password,
      name: this.options.name,
    });
  }

  protected async connectImplementation(): Promise<void> {
    this.nc = await this.createNatsConnection();

    // Re-establish the whole desired set (configured + runtime) on the
    // fresh connection — the previous connection's handles are gone.
    await this.applyDesiredSubscriptions();

    // The connection emits a closed-promise we await loosely.
    void this.nc.closed().then((err) => {
      this.handleConnectionLost(err ?? new Error('nats connection closed'));
    });
  }

  protected async disconnectImplementation(): Promise<void> {
    for (const live of this.liveSubscriptions.values()) {
      // The connection may already be dead — unsubscribing is best-effort.
      try { live.unsubscribe(); } catch { /* ignore */ }
    }
    // Only the live handles go; the desired set is the base class's and
    // is what `applyDesiredSubscriptions` restores on the next connect.
    this.liveSubscriptions.clear();
    if (this.nc) {
      try { await this.nc.drain(); } catch { /* ignore */ }
      this.nc = null;
    }
  }

  protected override initialSubscriptions(): Iterable<readonly [string, ActorRef<NatsMessage>]> {
    return (this.options.subscriptions ?? []).map(
      (subscription) => [subscription.subject, subscription.target] as const,
    );
  }

  protected override applySubscription(subject: string, target: ActorRef<NatsMessage>): void {
    if (!this.nc) throw new Error('NatsActor: not connected');
    if (this.liveSubscriptions.has(subject)) return;
    const live = this.nc.subscribe(subject, {
      callback: (err, message) => {
        if (err) {
          this.log.warn(`NatsActor: subscription error on '${subject}': ${err.message}`);
          return;
        }
        target.tell({
          subject: message.subject,
          payload: message.data,
          replyTo: message.reply ?? '',
        });
      },
    });
    this.liveSubscriptions.set(subject, live);
  }

  protected override revokeSubscription(subject: string): void {
    const live = this.liveSubscriptions.get(subject);
    if (!live) return;
    this.liveSubscriptions.delete(subject);
    live.unsubscribe();
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<NatsPublish>): Promise<void> {
    if (!this.nc) throw new Error('NatsActor: not connected');
    const publish = env.payload;
    const bytes = typeof publish.payload === 'string'
      ? new TextEncoder().encode(publish.payload)
      : publish.payload;
    this.nc.publish(publish.subject, bytes, publish.replyTo ? { reply: publish.replyTo } : undefined);
  }

  override onReceive(command: NatsCommand): void {
    // Compile-time exhaustiveness: adding a new NatsCommand variant
    // forces this site to handle it explicitly.
    match(command)
      .with({ kind: 'publish' },     (m) => this.onPublish(m))
      .with({ kind: 'subscribe' },   (m) => this.onSubscribe(m))
      .with({ kind: 'unsubscribe' }, (m) => this.onUnsubscribe(m))
      .exhaustive();
  }

  /* ----------------------------- internals ----------------------------- */

  private onPublish(command: PublishCommand): void {
    this.enqueueOutbound(command.publish);
  }

  private onSubscribe(command: SubscribeCommand): void {
    // Recorded as desired even while disconnected — the base class
    // applies it now if the connection is up, on the next connect if not.
    void this.rememberSubscription(command.subject, command.target);
  }

  private onUnsubscribe(command: UnsubscribeCommand): void {
    void this.forgetSubscription(command.subject);
  }
}

/* -------------------- nats peer-dep type stubs --------------------- */
/*
 * Hand-written on purpose — not a placeholder for the real `nats` types.
 * `nats` is declared only in `tests/integration/brokers/package.json`, which
 * the root install deliberately does not materialise, so the build compile
 * cannot resolve it; and these types are exported through `src/io/index.ts`,
 * so importing the module here would emit that specifier into a published
 * `.d.ts` a consumer who took the "optional" peer at its word cannot resolve
 * either. Widen the stub instead. The drift a real import would have caught
 * is covered by the live broker under `tests/integration/brokers/nats/`, and
 * `tests/unit/ci/OptionalPeerDeclarations.test.ts` asserts the boundary. #676.
 */

/**
 * Minimal subscription/connection surface the actor depends on.
 * Exported so test seams (subclasses overriding
 * `createNatsConnection`) can satisfy the shape without the real
 * `nats` peer-dep.
 */
export interface NatsSubscriptionLike {
  unsubscribe(): void;
}

export type NatsRawMessage = {
  subject: string;
  data: Uint8Array;
  reply?: string;
};

export interface NatsConnectionLike {
  publish(subject: string, payload: Uint8Array, options?: { reply?: string }): void;
  subscribe(subject: string, options: { callback: (err: Error | null, message: NatsRawMessage) => void }): NatsSubscriptionLike;
  drain(): Promise<void>;
  closed(): Promise<Error | undefined>;
}

interface NatsModule {
  connect(options: {
    servers: string[];
    token?: string;
    user?: string;
    pass?: string;
    name?: string;
  }): Promise<NatsConnectionLike>;
}

const natsLazy: Lazy<Promise<NatsModule>> = Lazy.of(
  () => lazyImportModule<NatsModule>('nats', { context: 'NatsActor' }),
);
