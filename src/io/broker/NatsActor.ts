import type { Config } from '../../config/Config.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import type { BrokerCommonSettings } from './BrokerSettings.js';

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

export interface NatsActorSettings extends BrokerCommonSettings {
  /** NATS server URLs (`'nats://localhost:4222'`). */
  readonly servers?: ReadonlyArray<string> | string;
  /** Optional credentials (token / user-password). */
  readonly token?: string;
  readonly user?: string;
  readonly password?: string;
  /** Subscriptions wired up at connect time.  Subjects support `*` and `>` wildcards (NATS-side). */
  readonly subscriptions?: ReadonlyArray<{ readonly subject: string; readonly target: ActorRef<NatsMessage> }>;
  /** Optional client name reported to the server. */
  readonly name?: string;
}

export type NatsCmd =
  | { readonly kind: 'publish'; readonly publish: NatsPublish }
  | { readonly kind: 'subscribe'; readonly subject: string; readonly target: ActorRef<NatsMessage> }
  | { readonly kind: 'unsubscribe'; readonly subject: string };

/**
 * NATS-Core (no JetStream) actor backed by the official `nats` peer-dep.
 * Plain pub/sub with optional request/reply via `replyTo`.  JetStream
 * (durable streams + consumers) is out-of-scope for v1 — would warrant
 * its own actor with very different semantics.
 */
export class NatsActor extends BrokerActor<NatsActorSettings, NatsCmd, NatsPublish> {
  private nc: NatsConnectionLike | null = null;
  private readonly subs = new Map<string, NatsSubscriptionLike>();

  constructor(settings: Partial<NatsActorSettings> = {}) { super(settings); }

  protected configKey(): string { return 'actor-ts.io.broker.nats'; }
  protected builtInDefaults(): Partial<NatsActorSettings> { return {}; }
  protected readSettingsFromConfig(c: Config): Partial<NatsActorSettings> {
    const out: { -readonly [K in keyof NatsActorSettings]?: NatsActorSettings[K] } = {};
    if (c.hasPath('servers')) out.servers = c.getStringList('servers');
    if (c.hasPath('token')) out.token = c.getString('token');
    if (c.hasPath('user')) out.user = c.getString('user');
    if (c.hasPath('password')) out.password = c.getString('password');
    if (c.hasPath('name')) out.name = c.getString('name');
    return out;
  }
  protected requiredSettings(): ReadonlyArray<keyof NatsActorSettings> { return ['servers']; }
  protected endpointLabel(): string {
    const s = this.settings.servers;
    if (Array.isArray(s)) return s.join(',');
    return typeof s === 'string' ? s : '';
  }

  protected async connectImpl(): Promise<void> {
    const nats = await natsLazy.get();
    const servers = Array.isArray(this.settings.servers)
      ? [...this.settings.servers]
      : [this.settings.servers as string];
    this.nc = await nats.connect({
      servers,
      token: this.settings.token,
      user: this.settings.user,
      pass: this.settings.password,
      name: this.settings.name,
    });

    for (const s of this.settings.subscriptions ?? []) {
      this.subscribeOnConnection(s.subject, s.target);
    }

    // The connection emits a closed-promise we await loosely.
    void this.nc.closed().then((err) => {
      this.handleConnectionLost(err ?? new Error('nats connection closed'));
    });
  }

  protected async disconnectImpl(): Promise<void> {
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

  override onReceive(cmd: NatsCmd): void {
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

const natsLazy: Lazy<Promise<NatsModule>> = Lazy.of(async () => {
  try {
    const name = 'nats';
    return (await import(name)) as unknown as NatsModule;
  } catch (e) {
    throw new Error(
      'NatsActor requires the "nats" package.  Install it with: npm install nats\n'
      + 'Original error: ' + (e instanceof Error ? e.message : String(e)),
    );
  }
});
