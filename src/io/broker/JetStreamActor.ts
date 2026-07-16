import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { JetStreamOptionsValidator } from './JetStreamOptions.js';
import type { JetStreamOptions, JetStreamOptionsType } from './JetStreamOptions.js';

/**
 * JetStream durable-streaming actor (#3).  Sister to {@link NatsActor}
 * — same `nats` peer-dep, same broker scaffold, but the consumer
 * binds a **push consumer** to a durable JetStream subscription so
 * recovery, replay, and explicit acks all work.  Where NatsActor is
 * fire-and-forget pub/sub, JetStreamActor is durable streaming with
 * Kafka-style "exactly-once-with-processing" semantics via the
 * `ack` / `nak` / `term` command handshake.
 *
 * **What this actor does (v1).**
 *
 *   - Connects to NATS, opens a JetStream context.
 *   - Optionally **creates or updates** a stream (`stream.name`,
 *     `subjects`, retention, etc.) at connect time.
 *   - Optionally **creates or updates** a durable consumer
 *     (`consumer.durable`) and binds a push subscription delivering
 *     to `target`.
 *   - Forwards every consumed message to `target` and waits for an
 *     explicit `ack` / `nak` / `term` command before the consumer's
 *     ack-window expires (`ackWaitMs`).  Same shape as KafkaActor's
 *     `commitMode: 'manual'` (#2).
 *   - Publishing supports JetStream idempotent publish via the
 *     `messageId` field (sent as the `Nats-Msg-Id` header — server
 *     dedupes a message-id within the stream's deduplication window).
 *
 * **Out of scope for v1.**
 *
 *   - **Pull consumers**.  Push is the natural fit for actor-style
 *     fan-out; pull consumers introduce a separate async loop and a
 *     batch-fetch API.  File a follow-up if needed.
 *   - **KV / Object Store**.  Different JetStream sub-APIs; warrant
 *     their own actors.
 *   - **Stream / consumer deletion**.  Actor only ever creates or
 *     updates — destroying a stream is an operator concern, not a
 *     runtime one.
 *
 * **Example.**
 *
 *   const js = system.spawnAnonymous(Props.create(() => new JetStreamActor(
 *     JetStreamOptions.create()
 *       .withServers(['nats://localhost:4222'])
 *       .withStream({ name: 'ORDERS', subjects: ['orders.*'] })
 *       .withConsumer({ durable: 'order-processor', ackWaitMs: 30_000 })
 *       .withTarget(orderProcessor),
 *   )));
 *
 *   class OrderProcessor extends Actor<JetStreamMessage> {
 *     constructor(private readonly js: ActorRef<JetStreamCommand>) { super(); }
 *     async onReceive(message: JetStreamMessage) {
 *       try {
 *         await db.insertOrder(JSON.parse(new TextDecoder().decode(message.payload)));
 *         this.js.tell({ kind: 'ack', streamSeq: message.streamSeq });
 *       } catch (e) {
 *         this.js.tell({ kind: 'nak', streamSeq: message.streamSeq, delayMs: 5_000 });
 *       }
 *     }
 *   }
 */

/** Inbound JetStream message handed to subscribers. */
export interface JetStreamMessage {
  readonly subject: string;
  readonly payload: Uint8Array;
  /** Reply subject (for request/reply patterns); empty when not set. */
  readonly replyTo: string;
  /** Stream sequence — unique within the stream, monotonic per stream. */
  readonly streamSeq: number;
  /** Consumer delivery sequence — bumps on every (re-)delivery. */
  readonly consumerSeq: number;
  /** Number of times this message has been delivered (1 = first try). */
  readonly deliveries: number;
  /** Server-assigned timestamp in ms since epoch. */
  readonly timestamp: number;
  /** Optional per-message headers (e.g. `Nats-Msg-Id`). */
  readonly headers: Readonly<Record<string, string>>;
}

/** Outbound JetStream publish — payload + optional dedupe headers. */
export interface JetStreamPublish {
  readonly subject: string;
  readonly payload: Uint8Array | string;
  /**
   * Optional dedupe id — sent as `Nats-Msg-Id` header so a re-publish
   * within the stream's deduplication window is idempotent.
   */
  readonly messageId?: string;
  /**
   * Optional expected last sequence — server rejects the publish if
   * the stream's last seq doesn't match (optimistic concurrency).
   */
  readonly expectedLastSeq?: number;
  /** Extra headers (free-form). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Stream lifecycle policy at connect time. */
export interface JetStreamStreamConfig {
  readonly name: string;
  readonly subjects: ReadonlyArray<string>;
  readonly retention?: 'limits' | 'interest' | 'workqueue';
  readonly storage?: 'memory' | 'file';
  readonly maxMsgs?: number;
  readonly maxBytes?: number;
  readonly maxAge?: number;     // ns; pass through verbatim
  /** Auto-create or update at connect time.  Default true. */
  readonly create?: boolean;
}

/** Push or pull consumer config (#62). */
export interface JetStreamConsumerConfig {
  /** Durable name — required so the consumer survives restarts. */
  readonly durable: string;
  /**
   * Consumer mode (#62).  `'push'` *(default)* — server pushes
   * messages; the actor's internal pump iterates the subscription
   * and waits per-message for ack/nak/term.  `'pull'` — caller
   * drives fetches with `{ kind: 'fetch', batch, expiresMs }`
   * commands; messages within a fetch still go through the same
   * ack handshake.  Pull mode lets the application self-pace,
   * which fits slow/bursty consumers better than push fan-out.
   */
  readonly mode?: 'push' | 'pull';
  /** Where in the stream to start the new consumer.  Default `'all'`. */
  readonly deliverPolicy?:
    | 'all' | 'last' | 'new'
    | { readonly kind: 'byStartSeq'; readonly startSeq: number }
    | { readonly kind: 'byStartTime'; readonly startTimeMs: number };
  /** `'explicit'` (default — ack/nak/term required), `'none'`, or `'all'`. */
  readonly ackPolicy?: 'explicit' | 'none' | 'all';
  /** Max time before the consumer redelivers without an ack.  Default 30s. */
  readonly ackWaitMs?: number;
  /** Subject filter — defaults to all subjects in the stream. */
  readonly filterSubject?: string;
  /** Max in-flight unacked messages.  Default 1024 (server default). */
  readonly maxAckPending?: number;
  /** Auto-create or update at connect time.  Default true. */
  readonly create?: boolean;
}

/** Publish a message via the actor's JetStream client. */
type PublishCommand = { readonly kind: 'publish'; readonly publish: JetStreamPublish };

/** Acknowledge a delivered message — server marks consumed. */
type AckCommand = { readonly kind: 'ack'; readonly streamSeq: number };

/** Negative-ack — server redelivers (after optional `delayMs`). */
type NakCommand = { readonly kind: 'nak'; readonly streamSeq: number; readonly delayMs?: number };

/** Terminal failure — server drops the message permanently. */
type TermCommand = { readonly kind: 'term'; readonly streamSeq: number; readonly reason?: string };

/** Heartbeat — extend the ack-wait window for a long-running handler. */
type InProgressCommand = { readonly kind: 'inProgress'; readonly streamSeq: number };

/**
 * Pull-mode (#62) — fetch up to `batch` messages, returning early
 * after `expiresMs` (default 5 s) if fewer are available.  Each
 * fetched message still goes through the same ack/nak/term
 * handshake as push-mode.  Sending `fetch` to a push-mode
 * consumer is a silent no-op with a warn log.
 */
type FetchCommand = { readonly kind: 'fetch'; readonly batch: number; readonly expiresMs?: number };

export type JetStreamCommand =
  | PublishCommand
  | AckCommand
  | NakCommand
  | TermCommand
  | InProgressCommand
  | FetchCommand;

export class JetStreamActor extends BrokerActor<
  JetStreamOptionsType, JetStreamCommand, JetStreamPublish
> {
  private nc: NatsConnectionLike | null = null;
  private js: JetStreamClientLike | null = null;
  private subscription: JetStreamSubscriptionLike | null = null;
  /** Pull-consumer handle (#62).  Non-null when consumer.mode === 'pull'. */
  private pullConsumer: PullConsumerLike | null = null;
  /** Map of streamSeq → in-flight ack handle for the manual-ack pump. */
  private readonly pending = new Map<number, PendingAcknowledgment>();

  constructor(options: JetStreamOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.jetstream; }
  protected builtInDefaultOptions(): Partial<JetStreamOptionsType> { return {}; }
  protected readOptionsFromConfig(config: Config): Partial<JetStreamOptionsType> {
    const out: { -readonly [K in keyof JetStreamOptionsType]?: JetStreamOptionsType[K] } = {};
    if (config.hasPath('servers')) out.servers = config.getStringList('servers');
    if (config.hasPath('token')) out.token = config.getString('token');
    if (config.hasPath('user')) out.user = config.getString('user');
    if (config.hasPath('password')) out.password = config.getString('password');
    if (config.hasPath('name')) out.name = config.getString('name');
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof JetStreamOptionsType> { return ['servers']; }
  protected override optionsValidator(): JetStreamOptionsValidator { return new JetStreamOptionsValidator(); }
  protected endpointLabel(): string {
    const servers = this.options.servers;
    if (Array.isArray(servers)) return `nats://${servers.join(',')}`;
    return `nats://${typeof servers === 'string' ? servers : ''}`;
  }

  /**
   * Build a `NatsConnectionLike`.  Override in a test subclass to
   * inject a mock connection (the `nats` peer-dep is heavy and not
   * necessary for unit tests).
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
    this.js = this.nc.jetstream();

    // Stream lifecycle: create-or-update if asked.
    if (this.options.stream && (this.options.stream.create ?? true)) {
      const jsm = await this.nc.jetstreamManager();
      await upsertStream(jsm, this.options.stream);
    }

    // Consumer + subscription (push) or pull handle.
    if (this.options.consumer) {
      if (this.options.consumer.create ?? true) {
        if (!this.options.stream?.name) {
          throw new Error('JetStreamActor: consumer.create requires stream.name');
        }
        const jsm = await this.nc.jetstreamManager();
        await upsertConsumer(jsm, this.options.stream.name, this.options.consumer);
      }
      if (!this.options.stream?.name) {
        throw new Error('JetStreamActor: consumer requires stream.name');
      }
      const mode = this.options.consumer.mode ?? 'push';
      if (mode === 'push') {
        this.subscription = await this.js.subscribe(
          this.options.consumer.filterSubject ?? `${this.options.stream.name}.>`,
          {
            stream: this.options.stream.name,
            consumer: this.options.consumer.durable,
          },
        );
        void this.runPump();
      } else {
        // Pull mode (#62) — grab the consumer handle but DON'T start
        // a pump.  Messages flow only when the caller sends `fetch`.
        this.pullConsumer = await this.js.consumers.get(
          this.options.stream.name,
          this.options.consumer.durable,
        );
      }
    }

    void this.nc.closed().then((err) => {
      this.handleConnectionLost(err ?? new Error('nats connection closed'));
    });
  }

  protected async disconnectImplementation(): Promise<void> {
    // Reject every still-pending ack so the consumer pump unwinds.
    if (this.pending.size > 0) {
      for (const pendingAck of this.pending.values()) {
        try { pendingAck.handle.nak(); } catch { /* best-effort */ }
      }
      this.pending.clear();
    }
    if (this.subscription) {
      try { await this.subscription.destroy(); } catch { /* */ }
      this.subscription = null;
    }
    // Pull consumer doesn't own a long-lived subscription — drop the
    // reference and the underlying nats client cleans up on drain.
    this.pullConsumer = null;
    if (this.nc) {
      try { await this.nc.drain(); } catch { /* */ }
      this.nc = null;
    }
    this.js = null;
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<JetStreamPublish>): Promise<void> {
    if (!this.js) throw new Error('JetStreamActor: not connected');
    const publish = env.payload;
    const bytes = typeof publish.payload === 'string'
      ? new TextEncoder().encode(publish.payload)
      : publish.payload;
    await this.js.publish(publish.subject, bytes, {
      msgID: publish.messageId,
      expect: publish.expectedLastSeq !== undefined
        ? { lastSequence: publish.expectedLastSeq }
        : undefined,
      headers: publish.headers,
    });
  }

  override onReceive(cmd: JetStreamCommand): void {
    // Compile-time exhaustiveness: adding a new JetStreamCommand variant
    // forces this site to handle it explicitly (TS error otherwise).
    match(cmd)
      .with({ kind: 'publish' },    (m) => this.onPublish(m))
      .with({ kind: 'ack' },        (m) => this.onAck(m))
      .with({ kind: 'nak' },        (m) => this.onNak(m))
      .with({ kind: 'term' },       (m) => this.onTerm(m))
      .with({ kind: 'inProgress' }, (m) => this.onInProgress(m))
      .with({ kind: 'fetch' },      (m) => void this.onFetch(m))
      .exhaustive();
  }

  /* ----------------------------- internals ----------------------------- */

  private onPublish(cmd: PublishCommand): void {
    this.enqueueOutbound(cmd.publish);
  }

  private async runPump(): Promise<void> {
    if (!this.subscription) return;
    for await (const message of this.subscription) {
      await this.deliverAndAwaitAcknowledgment(message);
    }
  }

  /**
   * Pull-mode fetch (#62) — request up to `batch` messages, fan them
   * to `target`, and wait per-message for ack/nak/term using the same
   * `deliverAndAwaitAcknowledgment` helper as the push pump.  Returns once every
   * message in the batch has been acked or its ack-timeout has
   * fired; subsequent `fetch` cmds are processed serially by the
   * mailbox.
   */
  private async onFetch(cmd: FetchCommand): Promise<void> {
    const { batch, expiresMs } = cmd;
    if (!this.pullConsumer) {
      this.log.warn('JetStreamActor: fetch on push-mode (or disconnected) consumer — ignored');
      return;
    }
    if (!Number.isInteger(batch) || batch <= 0) {
      this.log.warn(`JetStreamActor: fetch batch must be a positive integer, got ${batch} — ignored`);
      return;
    }
    let messages: AsyncIterable<JetStreamMsgHandleLike>;
    try {
      messages = await this.pullConsumer.fetch({
        max_messages: batch,
        expires: expiresMs ?? 5_000,
      });
    } catch (err) {
      this.log.warn(`JetStreamActor: fetch failed: ${(err as Error).message}`);
      return;
    }
    // Drain the fetch result.  The iterator completes either when the
    // batch is full or when `expires` ms elapses — empty-batch is
    // therefore a normal end condition, NOT an error.
    const handles: JetStreamMsgHandleLike[] = [];
    for await (const message of messages) handles.push(message);
    // Deliver everything to target first (typical pull-consumer
    // semantics: the application sees the whole batch at once), then
    // wait in parallel for the per-message acks.  Serial-await within
    // a batch would deadlock if the target processes them out of
    // order, which is the natural actor pattern.
    await Promise.all(handles.map((handle) => this.deliverAndAwaitAcknowledgment(handle)));
  }

  /**
   * Shared per-message delivery path used by both the push pump and
   * `onFetch`.  Tells the message to `target`, then awaits an
   * external ack / nak / term (unless `ackPolicy === 'none'`).
   */
  private async deliverAndAwaitAcknowledgment(messageHandle: JetStreamMsgHandleLike): Promise<void> {
    const target = this.options.target;
    const ackTimeoutMs = this.options.ackTimeout
      ?? this.options.consumer?.ackWaitMs
      ?? 30_000;
    const handle: JetStreamMsgHandleLike = messageHandle;
    const info = handle.info;
    if (target) {
      target.tell({
        subject: handle.subject,
        payload: handle.data,
        replyTo: handle.reply ?? '',
        streamSeq: info.streamSequence,
        consumerSeq: info.deliverySequence,
        deliveries: info.deliveryCount,
        timestamp: info.timestampNanos !== undefined
          ? Math.floor(info.timestampNanos / 1_000_000)
          : Date.now(),
        headers: extractHeaders(handle.headers),
      });
    }

    if (this.options.consumer?.ackPolicy === 'none') return;

    const seq = info.streamSequence;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(seq);
          reject(new Error(`JetStreamActor: no ack/nak/term for streamSeq=${seq} within ${ackTimeoutMs}ms`));
        }, ackTimeoutMs);
        this.pending.set(seq, {
          streamSeq: seq,
          handle,
          done: () => { clearTimeout(timer); resolve(); },
          fail: (err) => { clearTimeout(timer); reject(err); },
        });
      });
    } catch (err) {
      this.log.warn(`JetStreamActor: pump ${(err as Error).message} — letting consumer redeliver`);
      try { handle.nak(); } catch { /* best-effort */ }
    }
  }

  private onAck(cmd: AckCommand): void {
    const { streamSeq } = cmd;
    const pendingAck = this.pending.get(streamSeq);
    if (!pendingAck) {
      this.log.debug(`JetStreamActor: ack for unknown streamSeq=${streamSeq} — ignored`);
      return;
    }
    try { pendingAck.handle.ack(); }
    catch (err) {
      pendingAck.fail(err instanceof Error ? err : new Error(String(err)));
      this.pending.delete(streamSeq);
      return;
    }
    pendingAck.done();
    this.pending.delete(streamSeq);
  }

  private onNak(cmd: NakCommand): void {
    const { streamSeq, delayMs } = cmd;
    const pendingAck = this.pending.get(streamSeq);
    if (!pendingAck) return;
    try {
      if (typeof delayMs === 'number' && delayMs > 0) {
        pendingAck.handle.nak(delayMs);
      } else {
        pendingAck.handle.nak();
      }
    } catch { /* best-effort — nakWithDelay may be missing on older clients */ }
    pendingAck.done();
    this.pending.delete(streamSeq);
  }

  private onTerm(cmd: TermCommand): void {
    const { streamSeq, reason } = cmd;
    const pendingAck = this.pending.get(streamSeq);
    if (!pendingAck) return;
    this.log.warn(
      `JetStreamActor: term for streamSeq=${streamSeq}${reason ? ` (${reason})` : ''} — `
      + `message dropped permanently`,
    );
    try { pendingAck.handle.term(); } catch { /* */ }
    pendingAck.done();
    this.pending.delete(streamSeq);
  }

  private onInProgress(cmd: InProgressCommand): void {
    const { streamSeq } = cmd;
    const pendingAck = this.pending.get(streamSeq);
    if (!pendingAck) return;
    try { pendingAck.handle.working(); } catch { /* */ }
  }
}

/* ----------------------------- internals -------------------------------- */

interface PendingAcknowledgment {
  readonly streamSeq: number;
  readonly handle: JetStreamMsgHandleLike;
  readonly done: () => void;
  readonly fail: (err: Error) => void;
}

async function upsertStream(
  jsm: JetStreamManagerLike, cfg: JetStreamStreamConfig,
): Promise<void> {
  try {
    await jsm.streams.add({
      name: cfg.name,
      subjects: [...cfg.subjects],
      retention: cfg.retention,
      storage: cfg.storage,
      max_msgs: cfg.maxMsgs,
      max_bytes: cfg.maxBytes,
      max_age: cfg.maxAge,
    });
  } catch (e) {
    // If the stream exists, update it; the nats client raises a
    // 10058 ("stream name in use") error code we treat as benign.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/in use|already exists|10058/i.test(msg)) throw e;
    await jsm.streams.update(cfg.name, {
      subjects: [...cfg.subjects],
      retention: cfg.retention,
      storage: cfg.storage,
      max_msgs: cfg.maxMsgs,
      max_bytes: cfg.maxBytes,
      max_age: cfg.maxAge,
    });
  }
}

async function upsertConsumer(
  jsm: JetStreamManagerLike, streamName: string, cfg: JetStreamConsumerConfig,
): Promise<void> {
  const ackWaitNs = (cfg.ackWaitMs ?? 30_000) * 1_000_000;
  const consumerCfg: ConsumerAddConfig = {
    durable_name: cfg.durable,
    ack_policy: cfg.ackPolicy ?? 'explicit',
    ack_wait: ackWaitNs,
    filter_subject: cfg.filterSubject,
    max_ack_pending: cfg.maxAckPending,
    deliver_policy: 'all',
  };
  if (cfg.deliverPolicy === 'last') consumerCfg.deliver_policy = 'last';
  else if (cfg.deliverPolicy === 'new') consumerCfg.deliver_policy = 'new';
  else if (typeof cfg.deliverPolicy === 'object' && 'kind' in cfg.deliverPolicy) {
    if (cfg.deliverPolicy.kind === 'byStartSeq') {
      consumerCfg.deliver_policy = 'by_start_sequence';
      consumerCfg.opt_start_seq = cfg.deliverPolicy.startSeq;
    } else if (cfg.deliverPolicy.kind === 'byStartTime') {
      consumerCfg.deliver_policy = 'by_start_time';
      consumerCfg.opt_start_time = new Date(cfg.deliverPolicy.startTimeMs).toISOString();
    }
  }

  try {
    await jsm.consumers.add(streamName, consumerCfg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already exists|in use|10148/i.test(msg)) throw e;
    await jsm.consumers.update(streamName, cfg.durable, consumerCfg);
  }
}

function extractHeaders(headers: HeadersLike | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const key of headers.keys()) out[key] = headers.get(key) ?? '';
  return out;
}

/* -------------------- nats peer-dep type stubs --------------------- */

/**
 * Minimal `NatsConnection` surface the actor depends on.  Exported so
 * test seams (subclasses of `JetStreamActor` overriding
 * `createNatsConnection`) can satisfy the same shape without pulling
 * the real `nats` peer-dep.
 */
export interface NatsConnectionLike {
  jetstream(): JetStreamClientLike;
  jetstreamManager(): Promise<JetStreamManagerLike>;
  drain(): Promise<void>;
  closed(): Promise<Error | undefined>;
}

export interface JetStreamClientLike {
  publish(subject: string, payload: Uint8Array, opts?: {
    msgID?: string;
    expect?: { lastSequence?: number };
    headers?: Readonly<Record<string, string>>;
  }): Promise<unknown>;
  subscribe(subject: string, opts: {
    stream: string;
    consumer: string;
  }): Promise<JetStreamSubscriptionLike>;
  /**
   * Pull-consumer accessor (#62).  Returns a handle that exposes
   * `fetch` for batched on-demand delivery — see the nats.js
   * `consumers.get(stream, durable)` API.
   */
  readonly consumers: {
    get(stream: string, durable: string): Promise<PullConsumerLike>;
  };
}

export interface JetStreamSubscriptionLike extends AsyncIterable<JetStreamMsgHandleLike> {
  destroy(): Promise<void>;
}

/**
 * Pull-consumer handle returned by `JetStreamClient.consumers.get`.
 * `fetch` returns an async iterable that yields up to `max_messages`
 * messages before resolving (the iterator completes after `expires`
 * ms even if the batch isn't full).  Per-message ack semantics are
 * identical to push-mode.
 */
export interface PullConsumerLike {
  fetch(opts: {
    max_messages: number;
    expires: number;
  }): Promise<AsyncIterable<JetStreamMsgHandleLike>>;
}

interface HeadersLike {
  keys(): Iterable<string>;
  get(key: string): string | null;
}

export interface JetStreamMsgInfoLike {
  readonly streamSequence: number;
  readonly deliverySequence: number;
  readonly deliveryCount: number;
  readonly timestampNanos?: number;
}

export interface JetStreamMsgHandleLike {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly reply?: string;
  readonly headers?: HeadersLike;
  readonly info: JetStreamMsgInfoLike;
  ack(): void;
  nak(delayMs?: number): void;
  term(): void;
  working(): void;
}

interface ConsumerAddConfig {
  durable_name: string;
  ack_policy?: 'explicit' | 'none' | 'all';
  ack_wait?: number;
  filter_subject?: string;
  max_ack_pending?: number;
  deliver_policy?: 'all' | 'last' | 'new' | 'by_start_sequence' | 'by_start_time';
  opt_start_seq?: number;
  opt_start_time?: string;
}

export interface JetStreamManagerLike {
  readonly streams: {
    add(cfg: {
      name: string; subjects: string[]; retention?: string;
      storage?: string; max_msgs?: number; max_bytes?: number; max_age?: number;
    }): Promise<unknown>;
    update(name: string, cfg: {
      subjects: string[]; retention?: string; storage?: string;
      max_msgs?: number; max_bytes?: number; max_age?: number;
    }): Promise<unknown>;
  };
  readonly consumers: {
    add(stream: string, cfg: ConsumerAddConfig): Promise<unknown>;
    update(stream: string, durable: string, cfg: ConsumerAddConfig): Promise<unknown>;
  };
}

interface NatsModuleLike {
  connect(opts: {
    servers: string[]; token?: string; user?: string; pass?: string; name?: string;
  }): Promise<NatsConnectionLike>;
}

const natsLazy: Lazy<Promise<NatsModuleLike>> = Lazy.of(
  () => lazyImportModule<NatsModuleLike>('nats', { context: 'JetStreamActor' }),
);
