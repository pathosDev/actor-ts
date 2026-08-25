import { match } from 'ts-pattern';
import type { Config } from '../../config/Config.js';
import { ConfigKeys } from '../../config/ConfigKeys.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { lazyImportModule } from '../../util/LazyImport.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import {
  DEFAULT_MAX_OBJECT_BYTES,
  JetStreamObjectStoreOptionsValidator,
} from './JetStreamObjectStoreOptions.js';
import type {
  JetStreamObjectStoreOptions,
  JetStreamObjectStoreOptionsType,
} from './JetStreamObjectStoreOptions.js';

/**
 * JetStream **Object Store** actor (#74).  Blob storage on top of
 * JetStream: named objects with metadata, versioned by the stream
 * underneath.  A different sub-API from streams and from KV, which is why
 * {@link JetStreamActor} declared it out of scope.
 *
 * **Request/reply, not fan-out** — same shape as
 * {@link JetStreamKeyValueActor}: a command carries the `target` it should
 * answer on and the reply arrives as a `kind`-tagged
 * {@link JetStreamObjectStoreMessage}.  `target` is required where an
 * answer is the point (`get`, `info`, `list`) and optional where it is a
 * receipt (`put`, `delete`).
 *
 * **v1 moves a whole object in one message — deliberately.**  An object's
 * body would otherwise ride {@link OutboundEnvelope} through
 * {@link BrokerActor}'s outbound buffer, which is a bounded FIFO sized in
 * *messages* (1000 by default), not in bytes, and which evicts the
 * **oldest** entry on overflow.  A multi-megabyte body in that buffer
 * means up to `outboundBuffer × body` resident while disconnected, and an
 * overflow silently discards an upload — the two failure modes a blob API
 * must not have.  Streaming past the buffer would need a second dispatch
 * path outside the connection state machine; that is a bigger change than
 * this actor, so v1 takes the honest option instead: bodies are capped at
 * `maxObjectBytes` (1 MiB by default), a `put` above the cap is rejected
 * **before** it reaches the buffer, and a `get` above the cap is refused
 * before the body is materialised.  Both answer with
 * `objectStoreOperationFailed` naming the limit, so the ceiling is visible
 * at the call site rather than at 3 a.m.
 *
 * **A failed operation does not drop the connection** — see
 * {@link JetStreamKeyValueActor}; only "not connected" throws.
 *
 * **Example.**
 *
 *   const assetOptions = JetStreamObjectStoreOptions.create()
 *     .withServers(['nats://localhost:4222'])
 *     .withBucket('assets');
 *   const assets = system.spawnAnonymous(() => new JetStreamObjectStoreActor(assetOptions));
 *
 *   assets.tell({ kind: 'put', name: 'logo.png', payload: bytes, target: uploader });
 *   assets.tell({ kind: 'get', name: 'logo.png', target: reader });
 */

/** Metadata JetStream keeps for one stored object. */
export type JetStreamObjectInfo = {
  readonly name: string;
  /** Body size in bytes. */
  readonly size: number;
  /** Number of chunks the server split the body into. */
  readonly chunks: number;
  /** Server-computed content digest (`SHA-256=…`). */
  readonly digest: string;
  /** Last modification, ms since epoch; `0` when the server sent none. */
  readonly modifiedAt: number;
  readonly description?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

/** Receipt for a successful `put`. */
export type ObjectStoredMessage = {
  readonly kind: 'objectStored';
  readonly name: string;
  readonly info: JetStreamObjectInfo;
};

/** Answer to `get` — metadata plus the whole body. */
export type ObjectBodyMessage = {
  readonly kind: 'objectBody';
  readonly name: string;
  readonly payload: Uint8Array;
  readonly info: JetStreamObjectInfo;
};

/** Answer to `info` — metadata only, no body. */
export type ObjectInfoMessage = {
  readonly kind: 'objectInfo';
  readonly name: string;
  readonly info: JetStreamObjectInfo;
};

/** Answer to `list`. */
export type ObjectListMessage = {
  readonly kind: 'objectList';
  readonly objects: ReadonlyArray<JetStreamObjectInfo>;
};

/** Receipt for a successful `delete`. */
export type ObjectDeletedMessage = {
  readonly kind: 'objectDeleted';
  readonly name: string;
};

/** The object does not exist, or exists only as a delete marker. */
export type ObjectNotFoundMessage = {
  readonly kind: 'objectNotFound';
  readonly name: string;
};

/**
 * One operation failed.  Carries the command `kind` that failed; the
 * whole-body ceiling reports through here too, so a caller that never
 * expected an oversize object still learns about it.
 */
export type ObjectStoreOperationFailedMessage = {
  readonly kind: 'objectStoreOperationFailed';
  readonly operation: JetStreamObjectStoreCommand['kind'];
  readonly name?: string;
  readonly reason: string;
};

/** Everything the actor tells a `target`. */
export type JetStreamObjectStoreMessage =
  | ObjectStoredMessage
  | ObjectBodyMessage
  | ObjectInfoMessage
  | ObjectListMessage
  | ObjectDeletedMessage
  | ObjectNotFoundMessage
  | ObjectStoreOperationFailedMessage;

/** Store `payload` under `name`, replacing any previous body. */
type PutCommand = {
  readonly kind: 'put';
  readonly name: string;
  readonly payload: Uint8Array | string;
  readonly description?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly target?: ActorRef<JetStreamObjectStoreMessage>;
};

/** Read the whole body of `name`. */
type GetCommand = {
  readonly kind: 'get';
  readonly name: string;
  readonly target: ActorRef<JetStreamObjectStoreMessage>;
};

/** Remove `name` from the bucket. */
type DeleteCommand = {
  readonly kind: 'delete';
  readonly name: string;
  readonly target?: ActorRef<JetStreamObjectStoreMessage>;
};

/** Metadata for `name` without transferring the body — always allowed, whatever the size. */
type InfoCommand = {
  readonly kind: 'info';
  readonly name: string;
  readonly target: ActorRef<JetStreamObjectStoreMessage>;
};

/** Metadata for every live object in the bucket. */
type ListCommand = {
  readonly kind: 'list';
  readonly target: ActorRef<JetStreamObjectStoreMessage>;
};

export type JetStreamObjectStoreCommand =
  | PutCommand
  | GetCommand
  | DeleteCommand
  | InfoCommand
  | ListCommand;

export class JetStreamObjectStoreActor extends BrokerActor<
  JetStreamObjectStoreOptionsType,
  JetStreamObjectStoreCommand,
  JetStreamObjectStoreCommand
> {
  private natsConnection: ObjectStoreNatsConnectionLike | null = null;
  private store: ObjectStoreLike | null = null;

  constructor(options: JetStreamObjectStoreOptions = {}) { super(options); }

  protected configKey(): string { return ConfigKeys.io.broker.jetstreamObjectStore; }
  protected builtInDefaultOptions(): Partial<JetStreamObjectStoreOptionsType> {
    return { maxObjectBytes: DEFAULT_MAX_OBJECT_BYTES };
  }
  protected readOptionsFromConfig(config: Config): Partial<JetStreamObjectStoreOptionsType> {
    const out: {
      -readonly [K in keyof JetStreamObjectStoreOptionsType]?: JetStreamObjectStoreOptionsType[K]
    } = {};
    if (config.hasPath('servers')) out.servers = config.getStringList('servers');
    if (config.hasPath('token')) out.token = config.getString('token');
    if (config.hasPath('user')) out.user = config.getString('user');
    if (config.hasPath('password')) out.password = config.getString('password');
    if (config.hasPath('name')) out.name = config.getString('name');
    if (config.hasPath('bucket')) out.bucket = config.getString('bucket');
    if (config.hasPath('description')) out.description = config.getString('description');
    if (config.hasPath('storage')) out.storage = config.getString('storage') as 'memory' | 'file';
    if (config.hasPath('replicas')) out.replicas = config.getInt('replicas');
    if (config.hasPath('maxObjectBytes')) out.maxObjectBytes = config.getBytes('maxObjectBytes');
    if (config.hasPath('create')) out.create = config.getBoolean('create');
    return out;
  }
  protected requiredOptions(): ReadonlyArray<keyof JetStreamObjectStoreOptionsType> {
    return ['servers', 'bucket'];
  }
  protected override optionsValidator(): JetStreamObjectStoreOptionsValidator {
    return new JetStreamObjectStoreOptionsValidator();
  }
  protected endpointLabel(): string {
    const servers = this.options.servers;
    const joined = Array.isArray(servers) ? servers.join(',') : (typeof servers === 'string' ? servers : '');
    return `nats://${joined}/object/${this.options.bucket ?? ''}`;
  }

  /**
   * Build an `ObjectStoreNatsConnectionLike`.  Override in a test subclass
   * to inject a mock connection — the `nats` peer-dep is heavy and an
   * object bucket needs a live server, neither of which a unit test wants.
   */
  protected async createNatsConnection(): Promise<ObjectStoreNatsConnectionLike> {
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
    this.store = await this.natsConnection.jetstream().views.os(
      this.options.bucket as string,
      this.bucketOptions(),
    );

    void this.natsConnection.closed().then((err) => {
      this.handleConnectionLost(err ?? new Error('nats connection closed'));
    });
  }

  protected async disconnectImplementation(): Promise<void> {
    this.store = null;
    if (this.natsConnection) {
      try { await this.natsConnection.drain(); } catch { /* best-effort */ }
      this.natsConnection = null;
    }
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<JetStreamObjectStoreCommand>): Promise<void> {
    const store = this.store;
    // The one throw the base class is meant to see: no transport, so the
    // envelope goes back at the head of the buffer and a reconnect starts.
    if (!store) throw new Error('JetStreamObjectStoreActor: not connected');
    // The real command dispatcher: `onReceive` only buffers, so every
    // JetStreamObjectStoreCommand variant is handled here.
    await match(env.payload)
      .with({ kind: 'put' },    (c) => this.onPut(c, store))
      .with({ kind: 'get' },    (c) => this.onGet(c, store))
      .with({ kind: 'delete' }, (c) => this.onDelete(c, store))
      .with({ kind: 'info' },   (c) => this.onInfo(c, store))
      .with({ kind: 'list' },   (c) => this.onList(c, store))
      .exhaustive();
  }

  /**
   * Buffer the command — except an oversize `put`, which is rejected here
   * so the body never enters the bounded outbound buffer at all.  A plain
   * branch rather than a second `match`: the dispatch table lives in
   * `dispatchOutgoing`, and duplicating it here would only make the
   * admission check look like a second protocol.
   */
  override onReceive(command: JetStreamObjectStoreCommand): void {
    const admitted = command.kind === 'put' ? this.admitPut(command) : command;
    if (admitted) this.enqueueOutbound(admitted);
  }

  /* ----------------------------- internals ----------------------------- */

  /**
   * Encode the body once and check it against `maxObjectBytes`.  Returns
   * the normalised command (bytes already encoded, so `dispatchOutgoing`
   * does not re-encode a string) or `null` when the body is too large.
   */
  private admitPut(command: PutCommand): PutCommand | null {
    const payload = toBytes(command.payload);
    const limit = this.maxObjectBytes();
    if (payload.byteLength > limit) {
      this.reportFailure(
        'put', command.name,
        `body is ${payload.byteLength} bytes, above the ${limit}-byte whole-object limit `
        + '(raise maxObjectBytes, or split the object)',
        command.target,
      );
      return null;
    }
    return { ...command, payload };
  }

  private async onPut(command: PutCommand, store: ObjectStoreLike): Promise<void> {
    try {
      const info = await store.putBlob(
        { name: command.name, description: command.description, headers: command.headers },
        toBytes(command.payload),
      );
      command.target?.tell({ kind: 'objectStored', name: command.name, info: objectInfoOf(info) });
    } catch (e) {
      this.reportFailure('put', command.name, messageOf(e), command.target);
    }
  }

  /**
   * Read a whole object.  The `info` round-trip before the body is what
   * makes the ceiling enforceable: the size is known from metadata, so an
   * oversize object is refused without ever being materialised.
   */
  private async onGet(command: GetCommand, store: ObjectStoreLike): Promise<void> {
    try {
      const info = await store.info(command.name);
      if (!info || info.deleted === true) {
        command.target.tell({ kind: 'objectNotFound', name: command.name });
        return;
      }
      const limit = this.maxObjectBytes();
      if (info.size > limit) {
        this.reportFailure(
          'get', command.name,
          `object is ${info.size} bytes, above the ${limit}-byte whole-object limit `
          + '(raise maxObjectBytes, or read it with the nats client directly)',
          command.target,
        );
        return;
      }
      const payload = await store.getBlob(command.name);
      if (payload === null) {
        command.target.tell({ kind: 'objectNotFound', name: command.name });
        return;
      }
      command.target.tell({
        kind: 'objectBody', name: command.name, payload, info: objectInfoOf(info),
      });
    } catch (e) {
      this.reportFailure('get', command.name, messageOf(e), command.target);
    }
  }

  private async onDelete(command: DeleteCommand, store: ObjectStoreLike): Promise<void> {
    try {
      await store.delete(command.name);
      command.target?.tell({ kind: 'objectDeleted', name: command.name });
    } catch (e) {
      this.reportFailure('delete', command.name, messageOf(e), command.target);
    }
  }

  private async onInfo(command: InfoCommand, store: ObjectStoreLike): Promise<void> {
    try {
      const info = await store.info(command.name);
      if (!info || info.deleted === true) {
        command.target.tell({ kind: 'objectNotFound', name: command.name });
        return;
      }
      command.target.tell({ kind: 'objectInfo', name: command.name, info: objectInfoOf(info) });
    } catch (e) {
      this.reportFailure('info', command.name, messageOf(e), command.target);
    }
  }

  private async onList(command: ListCommand, store: ObjectStoreLike): Promise<void> {
    try {
      const listed = await store.list();
      command.target.tell({
        kind: 'objectList',
        objects: listed.filter((info) => info.deleted !== true).map(objectInfoOf),
      });
    } catch (e) {
      this.reportFailure('list', undefined, messageOf(e), command.target);
    }
  }

  /**
   * Report a per-operation failure to the caller.  Deliberately not a
   * rethrow: `dispatchOutgoing` throwing means "the transport is gone" to
   * {@link BrokerActor}, and one rejected object is not that.
   */
  private reportFailure(
    operation: JetStreamObjectStoreCommand['kind'],
    name: string | undefined,
    reason: string,
    target: ActorRef<JetStreamObjectStoreMessage> | undefined,
  ): void {
    if (target) target.tell({ kind: 'objectStoreOperationFailed', operation, name, reason });
    else this.log.warn(`JetStreamObjectStoreActor: ${operation} '${name ?? ''}' failed: ${reason}`);
  }

  private maxObjectBytes(): number {
    return this.options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  /**
   * Bucket options for `views.os`.  With `create: false` only `bindOnly`
   * is sent: the create-time settings are meaningless when binding, and
   * sending them would let a typo'd bucket name look like a fresh bucket.
   */
  private bucketOptions(): ObjectStoreBucketOptionsLike {
    if (this.options.create === false) return { bindOnly: true };
    return {
      description: this.options.description,
      storage: this.options.storage,
      replicas: this.options.replicas,
    };
  }
}

/* ----------------------------- internals -------------------------------- */

function toBytes(payload: Uint8Array | string): Uint8Array {
  return typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function objectInfoOf(info: ObjectInfoLike): JetStreamObjectInfo {
  const modifiedAt = info.mtime !== undefined ? Date.parse(info.mtime) : Number.NaN;
  return {
    name: info.name,
    size: info.size,
    chunks: info.chunks,
    digest: info.digest ?? '',
    modifiedAt: Number.isNaN(modifiedAt) ? 0 : modifiedAt,
    description: info.description,
    headers: info.headers,
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
 * Minimal `NatsConnection` surface the object-store actor depends on.
 * Declared here rather than shared with {@link JetStreamActor} or
 * {@link JetStreamKeyValueActor}: each of the three needs a different
 * slice of the JetStream client, and one widened interface would make
 * every mock in every suite carry all three.  Exported so a test subclass
 * overriding `createNatsConnection` can satisfy the shape without the real
 * `nats` peer-dep.
 */
export interface ObjectStoreNatsConnectionLike {
  jetstream(): ObjectStoreJetStreamClientLike;
  drain(): Promise<void>;
  closed(): Promise<Error | undefined>;
}

export interface ObjectStoreJetStreamClientLike {
  readonly views: {
    os(bucket: string, options?: ObjectStoreBucketOptionsLike): Promise<ObjectStoreLike>;
  };
}

/** Create-time bucket settings — nats.js `ObjectStoreOptions` spelling. */
export type ObjectStoreBucketOptionsLike = {
  readonly description?: string;
  readonly storage?: 'memory' | 'file';
  readonly replicas?: number;
  /** Bind to an existing bucket instead of creating one. */
  readonly bindOnly?: boolean;
};

/** Object metadata accepted by `putBlob` — nats.js `ObjectStoreMeta`. */
export type ObjectMetaLike = {
  readonly name: string;
  readonly description?: string;
  readonly headers?: Readonly<Record<string, string>>;
};

export interface ObjectStoreLike {
  putBlob(meta: ObjectMetaLike, payload: Uint8Array): Promise<ObjectInfoLike>;
  getBlob(name: string): Promise<Uint8Array | null>;
  info(name: string): Promise<ObjectInfoLike | null>;
  delete(name: string): Promise<unknown>;
  list(): Promise<ReadonlyArray<ObjectInfoLike>>;
}

/** nats.js `ObjectInfo` — `mtime` is the RFC-3339 string the server sends. */
export type ObjectInfoLike = {
  readonly name: string;
  readonly size: number;
  readonly chunks: number;
  readonly digest?: string;
  readonly mtime?: string;
  readonly description?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly deleted?: boolean;
};

interface NatsModuleLike {
  connect(options: {
    servers: string[]; token?: string; user?: string; pass?: string; name?: string;
  }): Promise<ObjectStoreNatsConnectionLike>;
}

const natsLazy: Lazy<Promise<NatsModuleLike>> = Lazy.of(
  () => lazyImportModule<NatsModuleLike>('nats', { context: 'JetStreamObjectStoreActor' }),
);
