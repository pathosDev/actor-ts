import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import { JetStreamKeyValueOptionsValidator } from './JetStreamKeyValueOptions.js';
import type {
  JetStreamKeyValueOptions,
  JetStreamKeyValueOptionsType,
} from './JetStreamKeyValueOptions.js';

/**
 * JetStream **Key-Value** actor (#74).  The third member of the NATS
 * family, next to {@link NatsActor} (core pub/sub) and
 * {@link JetStreamActor} (durable streams): JetStream's KV view is a
 * different sub-API with different semantics — revisioned keys,
 * compare-and-swap, and a change feed — which is why `JetStreamActor`
 * declared it out of scope rather than growing a sixth mode.
 *
 * **Request/reply, not fan-out.**  Most KV operations answer the caller,
 * so a command carries the `target` it should answer on and the reply
 * arrives as a `kind`-tagged {@link JetStreamKeyValueMessage} — the same
 * shape `GrpcClientActor` uses.  `target` is required where an answer is
 * the point (`get`, `keys`, `watch`) and optional where it is a receipt
 * (`put`, `delete`, `purge`): omit it for fire-and-forget writes.
 *
 * **Watches are desired state.**  `{ kind: 'watch' }` is recorded with
 * {@link BrokerActor.rememberSubscription}, so it survives a reconnect and
 * a watch issued during an outage lands on the next connect instead of
 * being dropped.  That is the same guarantee `NatsActor` gives a
 * subscription, and it matters more here: a KV change feed that silently
 * stops is indistinguishable from a bucket that stopped changing.
 *
 * **A failed operation does not drop the connection.**  `dispatchOutgoing`
 * throwing is how {@link BrokerActor} learns the transport died, so a
 * per-key failure (a compare-and-swap conflict, a key the server rejects)
 * is reported to `target` as `keyValueOperationFailed` instead.  Only "not
 * connected" throws.
 *
 * **Example.**
 *
 *   const cacheOptions = JetStreamKeyValueOptions.create()
 *     .withServers(['nats://localhost:4222'])
 *     .withBucket('sessions')
 *     .withHistory(5);
 *   const cache = system.spawnAnonymous(() => new JetStreamKeyValueActor(cacheOptions));
 *
 *   cache.tell({ kind: 'put', key: 'user.42', value: JSON.stringify(session) });
 *   cache.tell({ kind: 'get', key: 'user.42', target: reader });
 *   cache.tell({ kind: 'watch', target: reader });
 */

/** A key that currently holds a value. */
export type KeyValueEntryMessage = {
  readonly kind: 'keyValueEntry';
  readonly key: string;
  readonly value: Uint8Array;
  /** Monotonic per-bucket revision of this write — the compare-and-swap token. */
  readonly revision: number;
  /** Server-assigned write time, ms since epoch. */
  readonly createdAt: number;
};

/** The key does not exist (or its last operation removed it). */
export type KeyValueNotFoundMessage = {
  readonly kind: 'keyValueNotFound';
  readonly key: string;
};

/**
 * A key was removed — as the receipt for `delete` / `purge`, and as the
 * `watch` notification for a removal someone else performed.  `purged`
 * distinguishes the two removals JetStream offers: a delete leaves a
 * tombstone in the key's history, a purge drops the history as well.
 */
export type KeyValueRemovedMessage = {
  readonly kind: 'keyValueRemoved';
  readonly key: string;
  readonly purged: boolean;
};

/** Receipt for a successful `put` — carries the new revision. */
export type KeyValueRevisionMessage = {
  readonly kind: 'keyValueRevision';
  readonly key: string;
  readonly revision: number;
};

/** Answer to `keys`. */
export type KeyValueKeysMessage = {
  readonly kind: 'keyValueKeys';
  readonly keys: ReadonlyArray<string>;
};

/**
 * One operation failed.  Carries the command `kind` that failed so a
 * single collector can tell a lost write from a lost read; the most
 * common cause is a compare-and-swap conflict on `put`.
 */
export type KeyValueOperationFailedMessage = {
  readonly kind: 'keyValueOperationFailed';
  readonly operation: JetStreamKeyValueCommand['kind'];
  readonly key?: string;
  readonly reason: string;
};

/** Everything the actor tells a `target`. */
export type JetStreamKeyValueMessage =
  | KeyValueEntryMessage
  | KeyValueNotFoundMessage
  | KeyValueRemovedMessage
  | KeyValueRevisionMessage
  | KeyValueKeysMessage
  | KeyValueOperationFailedMessage;

/**
 * Write `value` under `key`.  With `expectedRevision` the write is a
 * compare-and-swap: the server rejects it unless the stored revision still
 * matches, which turns read-modify-write into an optimistic-concurrency
 * loop rather than a last-writer-wins race.  Pass `0` to mean "only if the
 * key does not exist yet".
 */
type PutCommand = {
  readonly kind: 'put';
  readonly key: string;
  readonly value: Uint8Array | string;
  readonly expectedRevision?: number;
  readonly target?: ActorRef<JetStreamKeyValueMessage>;
};

/** Read the current value of `key`. */
type GetCommand = {
  readonly kind: 'get';
  readonly key: string;
  readonly target: ActorRef<JetStreamKeyValueMessage>;
};

/** Remove `key`, leaving a tombstone in its history. */
type DeleteCommand = {
  readonly kind: 'delete';
  readonly key: string;
  readonly target?: ActorRef<JetStreamKeyValueMessage>;
};

/** Remove `key` **and** its history. */
type PurgeCommand = {
  readonly kind: 'purge';
  readonly key: string;
  readonly target?: ActorRef<JetStreamKeyValueMessage>;
};

/**
 * List the live keys, optionally narrowed by a NATS subject filter
 * (`'user.>'`).  The whole list is materialised into one message — see the
 * caution on the docs page before pointing this at a large bucket.
 */
type KeysCommand = {
  readonly kind: 'keys';
  readonly filter?: string;
  readonly target: ActorRef<JetStreamKeyValueMessage>;
};

/**
 * Stream every change under `key` (a subject filter; default `'>'` = the
 * whole bucket) to `target` until `unwatch`.  Re-watching a live key swaps
 * the target.
 */
type WatchCommand = {
  readonly kind: 'watch';
  readonly key?: string;
  readonly target: ActorRef<JetStreamKeyValueMessage>;
};

/** Stop the watch for `key` (default `'>'`), on the server and as desired state. */
type UnwatchCommand = {
  readonly kind: 'unwatch';
  readonly key?: string;
};

export type JetStreamKeyValueCommand =
  | PutCommand
  | GetCommand
  | DeleteCommand
  | PurgeCommand
  | KeysCommand
  | WatchCommand
  | UnwatchCommand;

/**
 * The commands that go over the outbound buffer.  `watch` / `unwatch` do
 * not: they are desired state, not one-shot traffic.
 */
type KeyValueOperationCommand =
  | PutCommand
  | GetCommand
  | DeleteCommand
  | PurgeCommand
  | KeysCommand;

/** Subject filter matching every key in the bucket — the nats.js default. */
const WATCH_ALL_KEYS = '>';

export class JetStreamKeyValueActor extends BrokerActor<
  JetStreamKeyValueOptionsType,
  JetStreamKeyValueCommand,
  KeyValueOperationCommand,
  ActorRef<JetStreamKeyValueMessage>
> {
  private natsConnection: KeyValueNatsConnectionLike | null = null;
  private store: KeyValueStoreLike | null = null;
  /**
   * Watch handles owned by the *current* connection, key filter → handle.
   * Wiped on disconnect; the desired set that repopulates it lives in the
   * base class and outlives any one connection.
   */
  private readonly liveWatches = new Map<string, KeyValueWatchLike>();

  constructor(options: JetStreamKeyValueOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.jetstreamKeyValue; }
  protected builtInDefaultOptions(): Partial<JetStreamKeyValueOptionsType> { return {}; }
  protected readOptionsFromConfig(config: Config): Partial<JetStreamKeyValueOptionsType> {
    const out: {
      -readonly [K in keyof JetStreamKeyValueOptionsType]?: JetStreamKeyValueOptionsType[K]
    } = {};
    if (config.hasPath('servers')) out.servers = config.getStringList('servers');
    if (config.hasPath('token')) out.token = config.getString('token');
    if (config.hasPath('user')) out.user = config.getString('user');
    if (config.hasPath('password')) out.password = config.getString('password');
    if (config.hasPath('name')) out.name = config.getString('name');
    if (config.hasPath('bucket')) out.bucket = config.getString('bucket');
    if (config.hasPath('history')) out.history = config.getInt('history');
    if (config.hasPath('timeToLive')) out.timeToLive = config.getDuration('timeToLive');
    if (config.hasPath('storage')) out.storage = config.getString('storage') as 'memory' | 'file';
    if (config.hasPath('replicas')) out.replicas = config.getInt('replicas');
    if (config.hasPath('maxValueBytes')) out.maxValueBytes = config.getBytes('maxValueBytes');
    if (config.hasPath('create')) out.create = config.getBoolean('create');
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof JetStreamKeyValueOptionsType> {
    return ['servers', 'bucket'];
  }
  protected override optionsValidator(): JetStreamKeyValueOptionsValidator {
    return new JetStreamKeyValueOptionsValidator();
  }
  protected endpointLabel(): string {
    const servers = this.options.servers;
    const joined = Array.isArray(servers) ? servers.join(',') : (typeof servers === 'string' ? servers : '');
    return `nats://${joined}/kv/${this.options.bucket ?? ''}`;
  }

  /**
   * Build a `KeyValueNatsConnectionLike`.  Override in a test subclass to
   * inject a mock connection — the `nats` peer-dep is heavy and a KV
   * bucket needs a live server, neither of which a unit test wants.
   */
  protected async createNatsConnection(): Promise<KeyValueNatsConnectionLike> {
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
    this.natsConnection = await this.createNatsConnection();
    this.store = await this.natsConnection.jetstream().views.kv(
      this.options.bucket as string,
      this.bucketOptions(),
    );

    // The previous connection's watch handles are gone with it; the
    // desired set is what re-establishes them here.
    await this.applyDesiredSubscriptions();

    void this.natsConnection.closed().then((err) => {
      this.handleConnectionLost(err ?? new Error('nats connection closed'));
    });
  }

  protected async disconnectImplementation(): Promise<void> {
    for (const watch of this.liveWatches.values()) {
      try { watch.stop(); } catch { /* the connection may already be dead */ }
    }
    // Only the live handles go; the desired set is the base class's.
    this.liveWatches.clear();
    this.store = null;
    if (this.natsConnection) {
      try { await this.natsConnection.drain(); } catch { /* best-effort */ }
      this.natsConnection = null;
    }
  }

  protected override async applySubscription(
    key: string, target: ActorRef<JetStreamKeyValueMessage>,
  ): Promise<void> {
    const store = this.store;
    if (!store) throw new Error('JetStreamKeyValueActor: not connected');
    if (this.liveWatches.has(key)) return;
    const watch = await store.watch({ key });
    this.liveWatches.set(key, watch);
    void this.pumpWatch(key, watch, target);
  }

  protected override revokeSubscription(key: string): void {
    const watch = this.liveWatches.get(key);
    if (!watch) return;
    this.liveWatches.delete(key);
    watch.stop();
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<KeyValueOperationCommand>): Promise<void> {
    const store = this.store;
    // The one throw the base class is meant to see: no transport, so the
    // envelope goes back at the head of the buffer and a reconnect starts.
    if (!store) throw new Error('JetStreamKeyValueActor: not connected');
    // The real command dispatcher: `onReceive` only buffers, so every
    // KeyValueOperationCommand variant is handled here.
    await match(env.payload)
      .with({ kind: 'put' },    (c) => this.onPut(c, store))
      .with({ kind: 'get' },    (c) => this.onGet(c, store))
      .with({ kind: 'delete' }, (c) => this.onDelete(c, store))
      .with({ kind: 'purge' },  (c) => this.onPurge(c, store))
      .with({ kind: 'keys' },   (c) => this.onKeys(c, store))
      .exhaustive();
  }

  override onReceive(command: JetStreamKeyValueCommand): void {
    match(command)
      .with({ kind: 'watch' },   (m) => this.onWatch(m))
      .with({ kind: 'unwatch' }, (m) => this.onUnwatch(m))
      .otherwise((m) => this.onOperation(m));
  }

  /* ----------------------------- internals ----------------------------- */

  /**
   * Every command that is not watch state — buffered rather than executed
   * here, so an operation issued while disconnected is replayed on connect
   * instead of failing, and the buffer keeps the writes in order.
   */
  private onOperation(command: KeyValueOperationCommand): void {
    this.enqueueOutbound(command);
  }

  private onWatch(command: WatchCommand): void {
    // Recorded as desired even while disconnected — the base class applies
    // it now if the connection is up, on the next connect if not.
    void this.rememberSubscription(command.key ?? WATCH_ALL_KEYS, command.target);
  }

  private onUnwatch(command: UnwatchCommand): void {
    void this.forgetSubscription(command.key ?? WATCH_ALL_KEYS);
  }

  private async onPut(command: PutCommand, store: KeyValueStoreLike): Promise<void> {
    const value = toBytes(command.value);
    try {
      const revision = command.expectedRevision !== undefined
        ? await store.update(command.key, value, command.expectedRevision)
        : await store.put(command.key, value);
      command.target?.tell({ kind: 'keyValueRevision', key: command.key, revision });
    } catch (e) {
      this.reportFailure('put', command.key, e, command.target);
    }
  }

  private async onGet(command: GetCommand, store: KeyValueStoreLike): Promise<void> {
    try {
      const entry = await store.get(command.key);
      // A deleted/purged key can surface as its tombstone entry rather than
      // as null, depending on client version — both mean "no value".
      if (!entry || entry.operation !== 'PUT') {
        command.target.tell({ kind: 'keyValueNotFound', key: command.key });
        return;
      }
      command.target.tell(entryMessageOf(entry));
    } catch (e) {
      this.reportFailure('get', command.key, e, command.target);
    }
  }

  private async onDelete(command: DeleteCommand, store: KeyValueStoreLike): Promise<void> {
    try {
      await store.delete(command.key);
      command.target?.tell({ kind: 'keyValueRemoved', key: command.key, purged: false });
    } catch (e) {
      this.reportFailure('delete', command.key, e, command.target);
    }
  }

  private async onPurge(command: PurgeCommand, store: KeyValueStoreLike): Promise<void> {
    try {
      await store.purge(command.key);
      command.target?.tell({ kind: 'keyValueRemoved', key: command.key, purged: true });
    } catch (e) {
      this.reportFailure('purge', command.key, e, command.target);
    }
  }

  private async onKeys(command: KeysCommand, store: KeyValueStoreLike): Promise<void> {
    try {
      const keys: string[] = [];
      for await (const key of await store.keys(command.filter)) keys.push(key);
      command.target.tell({ kind: 'keyValueKeys', keys });
    } catch (e) {
      this.reportFailure('keys', undefined, e, command.target);
    }
  }

  /**
   * Drain one watch into `target`.  A watch that ends because the handle
   * was stopped is the normal exit; one that ends because the connection
   * died is picked up by the reconnect, which re-applies the desired set.
   */
  private async pumpWatch(
    key: string, watch: KeyValueWatchLike, target: ActorRef<JetStreamKeyValueMessage>,
  ): Promise<void> {
    try {
      for await (const entry of watch) {
        // `operation` is the nats.js spelling of the change kind; a plain
        // branch keeps it out of the actor's own `kind` dispatch tables.
        if (entry.operation === 'PUT') target.tell(entryMessageOf(entry));
        else target.tell({ kind: 'keyValueRemoved', key: entry.key, purged: entry.operation === 'PURGE' });
      }
    } catch (e) {
      this.log.warn(`JetStreamKeyValueActor: watch '${key}' ended: ${(e as Error).message}`);
    }
  }

  /**
   * Report a per-operation failure to the caller.  Deliberately not a
   * rethrow: `dispatchOutgoing` throwing means "the transport is gone" to
   * {@link BrokerActor}, and one rejected key is not that.
   */
  private reportFailure(
    operation: JetStreamKeyValueCommand['kind'],
    key: string | undefined,
    cause: unknown,
    target: ActorRef<JetStreamKeyValueMessage> | undefined,
  ): void {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (target) target.tell({ kind: 'keyValueOperationFailed', operation, key, reason });
    else this.log.warn(`JetStreamKeyValueActor: ${operation} '${key ?? ''}' failed: ${reason}`);
  }

  /**
   * Bucket options for `views.kv`.  With `create: false` only `bindOnly`
   * is sent: the create-time limits are meaningless when binding, and
   * sending them would let a typo'd bucket name look like a fresh bucket.
   */
  private bucketOptions(): KeyValueBucketOptionsLike {
    if (this.options.create === false) return { bindOnly: true };
    return {
      history: this.options.history,
      ttl: this.options.timeToLive,
      storage: this.options.storage,
      replicas: this.options.replicas,
      maxValueSize: this.options.maxValueBytes,
    };
  }
}

/* ----------------------------- internals -------------------------------- */

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

function entryMessageOf(entry: KeyValueEntryLike): KeyValueEntryMessage {
  return {
    kind: 'keyValueEntry',
    key: entry.key,
    value: entry.value,
    revision: entry.revision,
    createdAt: entry.created instanceof Date ? entry.created.getTime() : 0,
  };
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
 * Minimal `NatsConnection` surface the KV actor depends on.  Declared
 * here rather than shared with {@link JetStreamActor}: that actor's
 * `NatsConnectionLike` has no `views`, and widening it would drag the
 * stream actor's stubs into every KV change (and vice versa).  Exported
 * so a test subclass overriding `createNatsConnection` can satisfy the
 * shape without the real `nats` peer-dep.
 */
export interface KeyValueNatsConnectionLike {
  jetstream(): KeyValueJetStreamClientLike;
  drain(): Promise<void>;
  closed(): Promise<Error | undefined>;
}

export interface KeyValueJetStreamClientLike {
  readonly views: {
    kv(bucket: string, options?: KeyValueBucketOptionsLike): Promise<KeyValueStoreLike>;
  };
}

/** Create-time bucket limits — nats.js `KvOptions` spelling. */
export type KeyValueBucketOptionsLike = {
  readonly history?: number;
  /** Per-key TTL in milliseconds (nats.js converts to nanos itself). */
  readonly ttl?: number;
  readonly storage?: 'memory' | 'file';
  readonly replicas?: number;
  readonly maxValueSize?: number;
  /** Bind to an existing bucket instead of creating one. */
  readonly bindOnly?: boolean;
};

export interface KeyValueStoreLike {
  get(key: string): Promise<KeyValueEntryLike | null>;
  put(key: string, value: Uint8Array): Promise<number>;
  /** Compare-and-swap write — rejects unless the stored revision matches. */
  update(key: string, value: Uint8Array, revision: number): Promise<number>;
  delete(key: string): Promise<void>;
  purge(key: string): Promise<void>;
  keys(filter?: string): Promise<AsyncIterable<string>>;
  watch(options?: { key?: string }): Promise<KeyValueWatchLike>;
}

export interface KeyValueWatchLike extends AsyncIterable<KeyValueEntryLike> {
  stop(): void;
}

/** nats.js `KvEntry` — `operation` keeps the client's uppercase spelling. */
export type KeyValueEntryLike = {
  readonly key: string;
  readonly value: Uint8Array;
  readonly revision: number;
  readonly created: Date;
  readonly operation: 'PUT' | 'DEL' | 'PURGE';
};

interface NatsModuleLike {
  connect(options: {
    servers: string[]; token?: string; user?: string; pass?: string; name?: string;
  }): Promise<KeyValueNatsConnectionLike>;
}

const natsLazy: Lazy<Promise<NatsModuleLike>> = Lazy.of(
  () => lazyImportModule<NatsModuleLike>('nats', { context: 'JetStreamKeyValueActor' }),
);
