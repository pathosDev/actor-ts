import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import type { NatsOptions, NatsOptionsType } from './NatsOptions.js';

/** Inbound NATS message handed to subscribers. */
export interface NatsMessage {
  readonly subject: string;
  readonly payload: Uint8Array;
  /** Reply subject (for request/reply patterns).  Empty when not set. */
  readonly replyTo: string;
}

/** Outbound publish — one NATS message. */
export interface NatsPublish {
  readonly subject: string;
  readonly payload: Uint8Array | string;
  readonly replyTo?: string;
}

export type NatsCommand =
  | { readonly kind: 'publish'; readonly publish: NatsPublish }
  | { readonly kind: 'subscribe'; readonly subject: string; readonly target: ActorRef<NatsMessage> }
  | { readonly kind: 'unsubscribe'; readonly subject: string };

/**
 * NATS-Core (no JetStream) actor backed by the official `nats` peer-dep.
 * Plain pub/sub with optional request/reply via `replyTo`.  JetStream
 * (durable streams + consumers) is out-of-scope for v1 — would warrant
 * its own actor with very different semantics.
 */
export class NatsActor extends BrokerActor<NatsOptionsType, NatsCommand, NatsPublish> {
  private nc: NatsConnectionLike | null = null;
  private readonly subs = new Map<string, NatsSubscriptionLike>();

  constructor(options: NatsOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.nats; }
  protected builtInDefaultOptions(): Partial<NatsOptionsType> { return {}; }
  protected readOptionsFromConfig(c: Config): Partial<NatsOptionsType> {
    const out: { -readonly [K in keyof NatsOptionsType]?: NatsOptionsType[K] } = {};
    if (c.hasPath('servers')) out.servers = c.getStringList('servers');
    if (c.hasPath('token')) out.token = c.getString('token');
    if (c.hasPath('user')) out.user = c.getString('user');
    if (c.hasPath('password')) out.password = c.getString('password');
    if (c.hasPath('name')) out.name = c.getString('name');
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof NatsOptionsType> { return ['servers']; }
  protected endpointLabel(): string {
    const s = this.options.servers;
    if (Array.isArray(s)) return s.join(',');
    return typeof s === 'string' ? s : '';
  }

  protected async connectImplementation(): Promise<void> {
    const nats = await natsLazy.get();
    const servers = Array.isArray(this.options.servers)
      ? [...this.options.servers]
      : [this.options.servers as string];
    this.nc = await nats.connect({
      servers,
      token: this.options.token,
      user: this.options.user,
      pass: this.options.password,
      name: this.options.name,
    });

    for (const s of this.options.subscriptions ?? []) {
      this.subscribeOnConnection(s.subject, s.target);
    }

    // The connection emits a closed-promise we await loosely.
    void this.nc.closed().then((err) => {
      this.handleConnectionLost(err ?? new Error('nats connection closed'));
    });
  }

  protected async disconnectImplementation(): Promise<void> {
    for (const sub of this.subs.values()) {
      try { sub.unsubscribe(); } catch { /* ignore */ }
    }
    this.subs.clear();
    if (this.nc) {
      try { await this.nc.drain(); } catch { /* ignore */ }
      this.nc = null;
    }
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<NatsPublish>): Promise<void> {
    if (!this.nc) throw new Error('NatsActor: not connected');
    const p = env.payload;
    const bytes = typeof p.payload === 'string'
      ? new TextEncoder().encode(p.payload)
      : p.payload;
    this.nc.publish(p.subject, bytes, p.replyTo ? { reply: p.replyTo } : undefined);
  }

  override onReceive(cmd: NatsCommand): void {
    if (cmd.kind === 'publish') {
      this.enqueueOutbound(cmd.publish);
    } else if (cmd.kind === 'subscribe') {
      if (this.connectionState === 'connected' && this.nc) {
        this.subscribeOnConnection(cmd.subject, cmd.target);
      }
    } else {
      const existing = this.subs.get(cmd.subject);
      if (existing) {
        try { existing.unsubscribe(); } catch { /* ignore */ }
        this.subs.delete(cmd.subject);
      }
    }
  }

  /* ----------------------------- internals ----------------------------- */

  private subscribeOnConnection(subject: string, target: ActorRef<NatsMessage>): void {
    if (!this.nc) return;
    if (this.subs.has(subject)) return;
    const sub = this.nc.subscribe(subject, {
      callback: (err, msg) => {
        if (err) {
          this.log.warn(`NatsActor: subscription error on '${subject}': ${err.message}`);
          return;
        }
        target.tell({
          subject: msg.subject,
          payload: msg.data,
          replyTo: msg.reply ?? '',
        });
      },
    });
    this.subs.set(subject, sub);
  }
}

/* ----------------------------- internals -------------------------------- */

interface NatsSubscriptionLike {
  unsubscribe(): void;
}

interface NatsRawMessage {
  subject: string;
  data: Uint8Array;
  reply?: string;
}

interface NatsConnectionLike {
  publish(subject: string, payload: Uint8Array, opts?: { reply?: string }): void;
  subscribe(subject: string, opts: { callback: (err: Error | null, msg: NatsRawMessage) => void }): NatsSubscriptionLike;
  drain(): Promise<void>;
  closed(): Promise<Error | undefined>;
}

interface NatsModule {
  connect(opts: {
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
