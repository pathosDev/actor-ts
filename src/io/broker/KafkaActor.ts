import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { KafkaOptionsValidator } from './KafkaOptions.js';
import type { KafkaOptions, KafkaOptionsType } from './KafkaOptions.js';

/** Inbound Kafka record delivered to subscribers. */
export interface KafkaRecord {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly key: Uint8Array | null;
  readonly value: Uint8Array | null;
  readonly timestamp: string;
  readonly headers: Readonly<Record<string, Uint8Array | string | null>>;
}

/** Outbound Kafka publish envelope.  `key` / `partition` optional. */
export interface KafkaPublish {
  readonly topic: string;
  readonly value: Uint8Array | string;
  readonly key?: Uint8Array | string;
  readonly partition?: number;
  readonly headers?: Readonly<Record<string, string | Uint8Array>>;
}

/**
 * Offset-commit policy (#2):
 *
 *   - `'auto'` — kafkajs commits after the message handler returns
 *     successfully (the default).  At-least-once delivery: the actor
 *     might re-deliver a message if it crashes between handler and
 *     commit, so handlers must be idempotent.
 *   - `'manual'` — the consumer pump pauses on each message and
 *     waits for an explicit `{ kind: 'commit', topic, partition,
 *     offset }` command before resolving the kafkajs promise and
 *     advancing the partition.  Combined with idempotent producing,
 *     this gives "exactly-once-with-processing" semantics.
 */
export type KafkaCommitMode = 'auto' | 'manual';

export type KafkaCommand =
  | { readonly kind: 'publish'; readonly publish: KafkaPublish }
  | { readonly kind: 'subscribe'; readonly topic: string }
  /**
   * Commit the offset for a message that was delivered in
   * `commitMode: 'manual'` mode.  The pump's `eachMessage` promise
   * resolves; kafkajs commits `offset + 1` and reads the next message
   * on this partition.  Sending `commit` outside manual-commit mode
   * is silently ignored.
   */
  | { readonly kind: 'commit'; readonly topic: string; readonly partition: number; readonly offset: string }
  /**
   * Negative-acknowledge a manual-commit message — the offset is
   * **not** committed and the eachMessage promise rejects, so
   * kafkajs treats the partition as having failed: on rebalance /
   * restart the same offset will be re-delivered.  The optional
   * `reason` shows up in the actor's warn log.
   */
  | { readonly kind: 'nack'; readonly topic: string; readonly partition: number; readonly offset: string; readonly reason?: string }
  /**
   * Bump the consumer's session-deadline mid-processing (#78).
   * `commitMode: 'manual'` pauses the eachMessage pump until the
   * handler ack's; if the handler runs longer than the consumer's
   * `sessionTimeoutMs` (kafkajs default 30 s) the broker evicts the
   * member, the partition rebalances, and the message is
   * re-delivered after the rebalance settles.
   *
   * `heartbeat` invokes the captured kafkajs `heartbeat()` callback
   * for the still-pending record, which restarts the session clock
   * without touching the offset.  Send it periodically from any
   * handler that's likely to exceed `sessionTimeoutMs / 3`; the
   * `withAutoHeartbeat()` helper schedules it for you.  Heartbeats
   * for an unknown / already-committed record are a silent no-op.
   */
  | { readonly kind: 'heartbeat'; readonly topic: string; readonly partition: number; readonly offset: string };

/**
 * Kafka producer + consumer in one actor, backed by `kafkajs`.  When
 * `consumer.groupId` is set, a consumer is started after `connectImplementation`
 * and consumed records are delivered to `target`.  When a producer is
 * the only goal, leave `consumer` and `topics` empty.
 *
 * **Offset-commit semantics.**
 *
 *   - `commitMode: 'auto'` (default) — kafkajs commits after each
 *     handler returns successfully → **at-least-once**.  Cheap; OK
 *     for idempotent handlers.
 *   - `commitMode: 'manual'` — pump pauses on each message and waits
 *     for an explicit `commit` command from the handler (#2).  The
 *     handler is responsible for sending exactly one `commit` (or
 *     `nack`) per delivered record.  If neither arrives within
 *     `commitTimeoutMs` the pump rejects internally, kafkajs treats
 *     the partition as failed, and re-delivery happens on rebalance.
 *     Produces **exactly-once-with-processing**: a message that
 *     successfully passed through `commit` is committed; a crash or
 *     `nack` re-delivers.
 *
 *   const kafka = system.spawnAnonymous(Props.create(() => new KafkaActor(
 *     KafkaOptions.create()
 *       .withBrokers(['kafka:9092'])
 *       .withConsumer({ groupId: 'orders', commitMode: 'manual' })
 *       .withTopics(['orders'])
 *       .withTarget(orderProcessor),
 *   )));
 *
 *   class OrderProcessor extends Actor<KafkaRecord> {
 *     constructor(private readonly kafka: ActorRef<KafkaCommand>) { super(); }
 *     async onReceive(rec: KafkaRecord) {
 *       try {
 *         await db.insertOrder(JSON.parse(rec.value!.toString()));
 *         this.kafka.tell({ kind: 'commit', topic: rec.topic,
 *                            partition: rec.partition, offset: rec.offset });
 *       } catch (e) {
 *         this.kafka.tell({ kind: 'nack',   topic: rec.topic,
 *                            partition: rec.partition, offset: rec.offset });
 *       }
 *     }
 *   }
 */
export class KafkaActor extends BrokerActor<KafkaOptionsType, KafkaCommand, KafkaPublish> {
  private kafka: KafkaInstanceLike | null = null;
  private producer: KafkaProducerLike | null = null;
  private consumer: KafkaConsumerLike | null = null;
  /**
   * Map of `<topic>|<partition>|<offset>` → in-flight commit promise
   * resolver.  Only populated in `commitMode: 'manual'`; entries are
   * inserted by the eachMessage pump and removed by `commit` /
   * `nack` / the timeout.
   */
  private readonly pendingCommits = new Map<string, PendingCommit>();

  constructor(options: KafkaOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.kafka; }
  protected builtInDefaultOptions(): Partial<KafkaOptionsType> {
    return { ssl: false, producer: { idempotent: false, allowAutoTopicCreation: false } };
  }
  protected readOptionsFromConfig(config: Config): Partial<KafkaOptionsType> {
    const out: { -readonly [K in keyof KafkaOptionsType]?: KafkaOptionsType[K] } = {};
    if (config.hasPath('brokers')) out.brokers = config.getStringList('brokers');
    if (config.hasPath('clientId')) out.clientId = config.getString('clientId');
    if (config.hasPath('ssl')) out.ssl = config.getBoolean('ssl');
    if (config.hasPath('sasl')) {
      const saslConfig = config.getConfig('sasl');
      out.sasl = {
        mechanism: saslConfig.getString('mechanism') as 'plain' | 'scram-sha-256' | 'scram-sha-512',
        username: saslConfig.getString('username'),
        password: saslConfig.getString('password'),
      };
    }
    if (config.hasPath('consumer')) {
      const cc = config.getConfig('consumer');
      out.consumer = {
        groupId: cc.hasPath('groupId') ? cc.getString('groupId') : undefined,
        fromBeginning: cc.hasPath('fromBeginning') ? cc.getBoolean('fromBeginning') : undefined,
        commitMode: cc.hasPath('commitMode')
          ? (cc.getString('commitMode') as KafkaCommitMode)
          : undefined,
        commitTimeoutMs: cc.hasPath('commitTimeoutMs') ? cc.getNumber('commitTimeoutMs') : undefined,
      };
    }
    if (config.hasPath('topics')) out.topics = config.getStringList('topics');
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof KafkaOptionsType> { return ['brokers']; }
  protected override optionsValidator(): KafkaOptionsValidator { return new KafkaOptionsValidator(); }
  protected endpointLabel(): string {
    const brokers = this.options.brokers;
    return Array.isArray(brokers) ? `kafka://${brokers.join(',')}` : `kafka://${brokers ?? ''}`;
  }

  /**
   * Build a `KafkaInstanceLike` from the configured options.  Override
   * in a subclass for tests that want to inject mock producers /
   * consumers without going through the kafkajs peer dep — that's the
   * test seam used by `tests/unit/io/broker/KafkaActor.test.ts`.
   */
  protected async createKafkaInstance(): Promise<KafkaInstanceLike> {
    const kafkajs = await kafkaLazy.get();
    const Constructor = kafkajs.Kafka ?? (kafkajs as unknown as { default: { Kafka: KafkaConstructor } }).default.Kafka;
    const brokersRaw = this.options.brokers;
    const brokers: ReadonlyArray<string> = Array.isArray(brokersRaw)
      ? brokersRaw
      : (typeof brokersRaw === 'string' ? brokersRaw : '')
          .split(',').map((s: string) => s.trim()).filter(Boolean);
    return new Constructor({
      clientId: this.options.clientId,
      brokers: [...brokers],
      ssl: this.options.ssl,
      sasl: this.options.sasl,
    });
  }

  protected async connectImplementation(): Promise<void> {
    this.kafka = await this.createKafkaInstance();
    this.producer = this.kafka.producer({
      idempotent: this.options.producer?.idempotent,
      allowAutoTopicCreation: this.options.producer?.allowAutoTopicCreation,
    });
    await this.producer.connect();

    if (this.options.consumer?.groupId) {
      this.consumer = this.kafka.consumer({ groupId: this.options.consumer.groupId });
      await this.consumer.connect();
      for (const topic of this.options.topics ?? []) {
        await this.consumer.subscribe({
          topic, fromBeginning: this.options.consumer.fromBeginning ?? false,
        });
      }
      const target = this.options.target;
      const manualCommit = this.options.consumer.commitMode === 'manual';
      const commitTimeoutMs = this.options.consumer.commitTimeoutMs ?? 30_000;

      // We deliberately don't await `run` — it's a long-running pump.
      void this.consumer.run({
        // kafkajs v2: `autoCommit: false` disables the auto-commit
        // path so eachMessage's resolution doesn't trigger a commit.
        // We drive commits from the actor via `commitOffsets` instead.
        autoCommit: !manualCommit,
        eachMessage: async ({ topic, partition, message, heartbeat }: KafkaConsumedMessage): Promise<void> => {
          if (!target) return;
          target.tell({
            topic, partition,
            offset: message.offset,
            key: message.key,
            value: message.value,
            timestamp: message.timestamp,
            headers: message.headers ?? {},
          });

          if (!manualCommit) return;

          // Wait for an external `commit` / `nack` before resolving.
          // The promise rejects on `nack`, the timeout, or disconnect
          // cleanup — kafkajs treats a rejected eachMessage as a
          // partition failure → rebalance → re-delivery (#2).
          const key = pendingKey(topic, partition, message.offset);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              this.pendingCommits.delete(key);
              reject(new Error(
                `KafkaActor: no commit/nack received for ${key} within ${commitTimeoutMs}ms`,
              ));
            }, commitTimeoutMs);
            this.pendingCommits.set(key, {
              done: () => { clearTimeout(timer); resolve(); },
              fail: (err) => { clearTimeout(timer); reject(err); },
              heartbeat,
              topic, partition, offset: message.offset,
            });
          });
        },
      });
    }
  }

  protected async disconnectImplementation(): Promise<void> {
    // Reject every still-pending commit so the kafkajs eachMessage
    // pump unwinds cleanly — otherwise consumer.disconnect would
    // hang waiting for the in-flight handler to resolve.
    if (this.pendingCommits.size > 0) {
      for (const pendingCommit of this.pendingCommits.values()) {
        pendingCommit.fail(new Error('KafkaActor: disconnecting before commit/nack arrived'));
      }
      this.pendingCommits.clear();
    }
    const errors: Error[] = [];
    if (this.consumer) {
      try { await this.consumer.disconnect(); } catch (e) { errors.push(e as Error); }
      this.consumer = null;
    }
    if (this.producer) {
      try { await this.producer.disconnect(); } catch (e) { errors.push(e as Error); }
      this.producer = null;
    }
    this.kafka = null;
    if (errors.length > 0) {
      this.log.warn(`KafkaActor disconnect: ${errors.map((e) => e.message).join('; ')}`);
    }
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<KafkaPublish>): Promise<void> {
    if (!this.producer) throw new Error('KafkaActor: producer not connected');
    const publish = env.payload;
    const value = typeof publish.value === 'string' ? Buffer.from(publish.value) : publish.value;
    const key = publish.key === undefined ? null
      : (typeof publish.key === 'string' ? Buffer.from(publish.key) : publish.key);
    // Header coercion: our `KafkaPublish.headers` API accepts
    // `string | Uint8Array`, but kafkajs ≥ 2.0 only handles `string |
    // Buffer` cleanly — a plain Uint8Array trips `Buffer.byteLength`
    // internally and the produce silently never gets serialised.
    // Buffer IS a Uint8Array subclass, so coercing here preserves
    // the public contract while making the kafkajs path reliable.
    // Surfaced by the b4-headers live-integration scenario against
    // `redpandadata/redpanda:latest`.
    const headers = publish.headers
      ? Object.fromEntries(Object.entries(publish.headers).map(([headerKey, headerValue]) =>
          [headerKey, headerValue instanceof Uint8Array && !Buffer.isBuffer(headerValue) ? Buffer.from(headerValue) : headerValue]))
      : undefined;
    await this.producer.send({
      topic: publish.topic,
      messages: [{ value, key, partition: publish.partition, headers: headers as never }],
    });
  }

  override onReceive(cmd: KafkaCommand): void {
    // Compile-time exhaustiveness: adding a new KafkaCommand variant
    // forces this site to handle it explicitly.
    match(cmd)
      .with({ kind: 'publish' },   (m) => this.onPublish(m))
      .with({ kind: 'subscribe' }, (m) => this.onSubscribe(m))
      .with({ kind: 'commit' },    (c) => void this.onCommit(c))
      .with({ kind: 'nack' },      (c) => this.onNack(c))
      .with({ kind: 'heartbeat' }, (c) => void this.onHeartbeat(c))
      .exhaustive();
  }

  /* ----------------------------- internals ------------------------------ */

  private onPublish(cmd: Extract<KafkaCommand, { kind: 'publish' }>): void {
    this.enqueueOutbound(cmd.publish);
  }

  private onSubscribe(cmd: Extract<KafkaCommand, { kind: 'subscribe' }>): void {
    // Runtime topic-add — kafkajs requires the consumer already be running.
    if (this.consumer && this.connectionState === 'connected') {
      void this.consumer.subscribe({ topic: cmd.topic, fromBeginning: false });
    }
  }

  private async onCommit(cmd: {
    readonly topic: string; readonly partition: number; readonly offset: string;
  }): Promise<void> {
    const key = pendingKey(cmd.topic, cmd.partition, cmd.offset);
    const pending = this.pendingCommits.get(key);
    if (!pending) {
      // Already committed, expired, or — most commonly — auto-mode
      // (where no pending entry was ever inserted).  Silent no-op
      // either way: handlers can be written to send `commit`
      // unconditionally without checking the configured mode.
      this.log.debug(`KafkaActor: commit for unknown ${key} — ignored (already committed, expired, or auto-mode)`);
      return;
    }
    if (!this.consumer || !this.consumer.commitOffsets) {
      pending.fail(new Error('KafkaActor: commit arrived but consumer is not connected or kafkajs lacks commitOffsets'));
      this.pendingCommits.delete(key);
      return;
    }
    try {
      // kafkajs `commitOffsets` takes the **next** offset to consume,
      // i.e., one past the message we just processed.  Offsets are
      // decimal strings; we use BigInt so very large values stay
      // exact (Kafka offsets are 64-bit).
      const next = String(BigInt(cmd.offset) + 1n);
      await this.consumer.commitOffsets([
        { topic: cmd.topic, partition: cmd.partition, offset: next },
      ]);
      pending.done();
    } catch (err) {
      pending.fail(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.pendingCommits.delete(key);
    }
  }

  /**
   * Forward a `heartbeat` command to the captured kafkajs callback —
   * keeps the record's session-deadline alive without affecting the
   * offset.  Unknown record (auto-mode, already-committed, expired)
   * is a silent no-op so handlers can call this unconditionally
   * without checking `commitMode` or whether the record's commit has
   * already landed elsewhere.
   */
  private async onHeartbeat(cmd: {
    readonly topic: string; readonly partition: number; readonly offset: string;
  }): Promise<void> {
    const key = pendingKey(cmd.topic, cmd.partition, cmd.offset);
    const pending = this.pendingCommits.get(key);
    if (!pending || !pending.heartbeat) {
      this.log.debug(`KafkaActor: heartbeat for unknown ${key} — ignored`);
      return;
    }
    try {
      await pending.heartbeat();
    } catch (err) {
      // A failing heartbeat shouldn't reject the in-flight commit —
      // the handler still has a chance to commit/nack normally.  We
      // just log and let the existing timeout / handler path run.
      this.log.warn(
        `KafkaActor: heartbeat call failed for ${key}: ${(err as Error).message}`,
      );
    }
  }

  private onNack(cmd: {
    readonly topic: string; readonly partition: number; readonly offset: string;
    readonly reason?: string;
  }): void {
    const key = pendingKey(cmd.topic, cmd.partition, cmd.offset);
    const pending = this.pendingCommits.get(key);
    if (!pending) return;
    this.log.warn(
      `KafkaActor: nack for ${key}${cmd.reason ? ` (${cmd.reason})` : ''} — `
      + `re-delivery will happen on next rebalance`,
    );
    pending.fail(new Error(cmd.reason ?? 'KafkaActor: nack from handler'));
    this.pendingCommits.delete(key);
  }
}

/* ----------------------------- internals -------------------------------- */

interface PendingCommit {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
  readonly done: () => void;
  readonly fail: (err: Error) => void;
  readonly heartbeat?: () => Promise<void>;
}

function pendingKey(topic: string, partition: number, offset: string): string {
  return `${topic}|${partition}|${offset}`;
}

interface KafkaConstructor {
  new (config: {
    clientId?: string;
    brokers: string[];
    ssl?: boolean;
    sasl?: { mechanism: string; username: string; password: string };
  }): KafkaInstanceLike;
}

/**
 * Minimal Kafka surface the actor depends on.  Exported so test seams
 * (subclasses overriding `createKafkaInstance`) can satisfy the same
 * shape without pulling kafkajs.
 */
export interface KafkaInstanceLike {
  producer(config?: { idempotent?: boolean; allowAutoTopicCreation?: boolean }): KafkaProducerLike;
  consumer(config: { groupId: string }): KafkaConsumerLike;
}

export interface KafkaProducerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(args: {
    topic: string;
    messages: Array<{
      value: Uint8Array | null; key?: Uint8Array | null;
      partition?: number; headers?: Record<string, string | Uint8Array>;
    }>;
  }): Promise<unknown>;
}

interface KafkaConsumedMessage {
  topic: string;
  partition: number;
  message: {
    offset: string;
    key: Uint8Array | null;
    value: Uint8Array | null;
    timestamp: string;
    headers?: Record<string, Uint8Array | string | null>;
  };
  /** kafkajs callback for explicit heartbeats during long handler runs. */
  heartbeat?: () => Promise<void>;
}

export interface KafkaConsumerLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(args: { topic: string; fromBeginning?: boolean }): Promise<void>;
  run(args: {
    autoCommit?: boolean;
    eachMessage: (m: KafkaConsumedMessage) => Promise<void>;
  }): Promise<void>;
  /**
   * Manual offset commit (#2).  Each entry's `offset` is the **next**
   * message to consume — i.e., one past the message we just finished
   * processing.  Required for `commitMode: 'manual'`; older kafkajs
   * releases that lack it surface a clear error at commit time.
   */
  commitOffsets?(args: ReadonlyArray<{
    topic: string; partition: number; offset: string;
  }>): Promise<void>;
}

interface KafkajsModule {
  Kafka?: KafkaConstructor;
}

const kafkaLazy: Lazy<Promise<KafkajsModule>> = Lazy.of(
  () => lazyImportModule<KafkajsModule>('kafkajs', { context: 'KafkaActor' }),
);

/* ========================== heartbeat helper =========================== */

/**
 * Reference to a Kafka record for use with {@link withAutoHeartbeat} —
 * exactly the (topic, partition, offset) triple a `KafkaCommand.heartbeat`
 * command needs.  `KafkaRecord` itself satisfies this shape, so the
 * `eachMessage` payload from the consumer pump can be passed directly.
 */
export interface KafkaRecordRef {
  readonly topic: string;
  readonly partition: number;
  readonly offset: string;
}

/**
 * Run `body` while periodically telling `kafka` to heartbeat the
 * record.  Cancels the timer on success or failure; the body's
 * resolution / rejection is propagated.  Use this when a manual-commit
 * handler is likely to exceed the consumer's `sessionTimeoutMs / 3` —
 * the rule of thumb being three heartbeats per session window so a
 * single dropped tick doesn't trigger eviction.
 *
 * Default `everyMs` is 10 s, suitable for kafkajs's default 30 s
 * `sessionTimeout`.  If you tuned the consumer's session timeout up,
 * scale `everyMs` to match.
 *
 * @example
 * ```ts
 * await withAutoHeartbeat({ kafka, record: rec, everyMs: 5_000 }, async () => {
 *   await reallySlowDatabaseWork(rec.value);
 * });
 * kafka.tell({ kind: 'commit', ...rec });
 * ```
 */
export async function withAutoHeartbeat<T>(
  args: {
    readonly kafka: ActorRef<KafkaCommand>;
    readonly record: KafkaRecordRef;
    readonly everyMs?: number;
  },
  body: () => Promise<T>,
): Promise<T> {
  const intervalMs = args.everyMs ?? 10_000;
  const timer = setInterval(() => {
    args.kafka.tell({
      kind: 'heartbeat',
      topic: args.record.topic,
      partition: args.record.partition,
      offset: args.record.offset,
    });
  }, intervalMs);
  try {
    return await body();
  } finally {
    clearInterval(timer);
  }
}
