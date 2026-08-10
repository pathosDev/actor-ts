/**
 * Unit tests for `JetStreamObjectStoreActor` (#74).
 *
 * The load-bearing case here is the whole-object ceiling: v1 moves an
 * object as a single message, so both directions must refuse an oversize
 * body — the `put` side *before* the body reaches the bounded outbound
 * buffer, the `get` side before it is materialised.  Everything else is
 * the ordinary request/reply surface, driven through the same
 * `createNatsConnection` test seam the other NATS actors use.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import {
  JetStreamObjectStoreActor,
  type JetStreamObjectStoreCommand,
  type JetStreamObjectStoreMessage,
  type ObjectInfoLike,
  type ObjectMetaLike,
  type ObjectStoreBucketOptionsLike,
  type ObjectStoreJetStreamClientLike,
  type ObjectStoreLike,
  type ObjectStoreNatsConnectionLike,
} from '../../../../src/io/broker/JetStreamObjectStoreActor.js';
import {
  DEFAULT_MAX_OBJECT_BYTES,
  JetStreamObjectStoreOptions,
  type JetStreamObjectStoreOptionsBuilder,
  type JetStreamObjectStoreOptionsType,
} from '../../../../src/io/broker/JetStreamObjectStoreOptions.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';

/* --------------------------- Mocks ----------------------------- */

/** In-memory object bucket with delete markers, as the server has them. */
class MockObjectStore implements ObjectStoreLike {
  private readonly objects = new Map<string, { info: ObjectInfoLike; payload: Uint8Array }>();
  readonly putCalls: Array<{ meta: ObjectMetaLike; bytes: number }> = [];
  readonly getBlobCalls: string[] = [];
  failNext: { operation: 'put' | 'get' | 'info' | 'delete' | 'list'; reason: string } | null = null;

  async putBlob(meta: ObjectMetaLike, payload: Uint8Array): Promise<ObjectInfoLike> {
    this.throwIfArmed('put');
    this.putCalls.push({ meta, bytes: payload.byteLength });
    const info: ObjectInfoLike = {
      name: meta.name,
      size: payload.byteLength,
      chunks: 1,
      digest: `SHA-256=${payload.byteLength}`,
      mtime: '2026-08-10T00:00:00.000Z',
      description: meta.description,
      headers: meta.headers,
    };
    this.objects.set(meta.name, { info, payload });
    return info;
  }

  async getBlob(name: string): Promise<Uint8Array | null> {
    this.throwIfArmed('get');
    this.getBlobCalls.push(name);
    const stored = this.objects.get(name);
    return stored && stored.info.deleted !== true ? stored.payload : null;
  }

  async info(name: string): Promise<ObjectInfoLike | null> {
    this.throwIfArmed('info');
    return this.objects.get(name)?.info ?? null;
  }

  async delete(name: string): Promise<unknown> {
    this.throwIfArmed('delete');
    const stored = this.objects.get(name);
    if (stored) this.objects.set(name, { ...stored, info: { ...stored.info, deleted: true } });
    return { purged: 1 };
  }

  async list(): Promise<ReadonlyArray<ObjectInfoLike>> {
    this.throwIfArmed('list');
    return [...this.objects.values()].map((stored) => stored.info);
  }

  /** Seed an object whose metadata claims a size the test wants. */
  seed(info: ObjectInfoLike, payload: Uint8Array): void {
    this.objects.set(info.name, { info, payload });
  }

  private throwIfArmed(operation: 'put' | 'get' | 'info' | 'delete' | 'list'): void {
    if (this.failNext?.operation !== operation) return;
    const { reason } = this.failNext;
    this.failNext = null;
    throw new Error(reason);
  }
}

class MockConnection implements ObjectStoreNatsConnectionLike {
  readonly store = new MockObjectStore();
  readonly bucketCalls: Array<{ bucket: string; options?: ObjectStoreBucketOptionsLike }> = [];
  private closedResolve!: (e: Error | undefined) => void;
  private readonly closedPromise = new Promise<Error | undefined>((r) => { this.closedResolve = r; });

  jetstream(): ObjectStoreJetStreamClientLike {
    return {
      views: {
        os: async (bucket: string, options?: ObjectStoreBucketOptionsLike): Promise<ObjectStoreLike> => {
          this.bucketCalls.push({ bucket, options });
          return this.store;
        },
      },
    };
  }

  async drain(): Promise<void> { this.closedResolve(undefined); }
  closed(): Promise<Error | undefined> { return this.closedPromise; }
}

class MockObjectStoreActor extends JetStreamObjectStoreActor {
  readonly mockConnection = new MockConnection();
  protected override async createNatsConnection(): Promise<ObjectStoreNatsConnectionLike> {
    return this.mockConnection;
  }
  /** Exposes the merged settings so the HOCON-precedence test can read them. */
  get resolvedOptions(): JetStreamObjectStoreOptionsType { return this.options; }
  /** Exposes the buffer depth so the ceiling test can prove nothing was queued. */
  get bufferedOutbound(): number { return this.outboundBufferSize; }
}

/* --------------------------- Helpers ---------------------------- */

class CollectingTarget extends Actor<JetStreamObjectStoreMessage> {
  readonly received: JetStreamObjectStoreMessage[] = [];
  override onReceive(message: JetStreamObjectStoreMessage): void { this.received.push(message); }
}

type Harness = {
  readonly actor: ActorRef<JetStreamObjectStoreCommand>;
  readonly mock: MockObjectStoreActor;
  readonly target: CollectingTarget;
  readonly targetRef: ActorRef<JetStreamObjectStoreMessage>;
};

function newSystem(name: string, config?: ConfigObject): ActorSystem {
  let sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config) sysOptions = sysOptions.withConfig(config);
  return ActorSystem.create(name, sysOptions);
}

async function boot(sys: ActorSystem, options: JetStreamObjectStoreOptionsBuilder): Promise<Harness> {
  const target = new CollectingTarget();
  const targetRef = sys.spawn(() => target, 'target') as ActorRef<JetStreamObjectStoreMessage>;
  const held = { current: null as MockObjectStoreActor | null };
  const actor = sys.spawn(() => {
    const created = new MockObjectStoreActor(options);
    held.current = created;
    return created;
  }, 'objects') as ActorRef<JetStreamObjectStoreCommand>;
  await awaitCondition(() => (held.current?.mockConnection.bucketCalls.length ?? 0) > 0, {
    label: 'JetStreamObjectStoreActor bound its bucket',
  });
  return { actor, mock: held.current!, target, targetRef };
}

const baseOptions = (): JetStreamObjectStoreOptionsBuilder => JetStreamObjectStoreOptions.create()
  .withServers(['nats://fake:4222'])
  .withBucket('assets');

/* ============================================================== */

describe('JetStreamObjectStoreActor — bucket binding', () => {
  test('create=true (default) forwards the create-time settings', async () => {
    const sys = newSystem('object-create');
    try {
      const options = baseOptions()
        .withDescription('build artefacts')
        .withStorage('file')
        .withReplicas(3);
      const { mock } = await boot(sys, options);
      expect(mock.mockConnection.bucketCalls[0]?.bucket).toBe('assets');
      expect(mock.mockConnection.bucketCalls[0]?.options).toEqual({
        description: 'build artefacts', storage: 'file', replicas: 3,
      });
    } finally {
      await sys.terminate();
    }
  });

  test('create=false binds only', async () => {
    const sys = newSystem('object-bind');
    try {
      const { mock } = await boot(sys, baseOptions().withCreate(false));
      expect(mock.mockConnection.bucketCalls[0]?.options).toEqual({ bindOnly: true });
    } finally {
      await sys.terminate();
    }
  });

  test('HOCON under actor-ts.io.broker.jetstream-object-store feeds the options', async () => {
    const sys = newSystem('object-hocon', {
      'actor-ts': {
        io: {
          broker: {
            'jetstream-object-store': {
              servers: ['nats://from-hocon:4222'],
              bucket: 'hocon-bucket',
              maxObjectBytes: '2M',
            },
          },
        },
      },
    });
    try {
      const options = JetStreamObjectStoreOptions.create().withBucket('builder-bucket');
      const { mock } = await boot(sys, options);
      expect(mock.resolvedOptions.servers).toEqual(['nats://from-hocon:4222']);
      expect(mock.resolvedOptions.maxObjectBytes).toBe(2 * 1024 * 1024);
      expect(mock.resolvedOptions.bucket).toBe('builder-bucket');
    } finally {
      await sys.terminate();
    }
  });

  test('maxObjectBytes defaults to the shipped whole-object ceiling', async () => {
    const sys = newSystem('object-default-ceiling');
    try {
      const { mock } = await boot(sys, baseOptions());
      expect(mock.resolvedOptions.maxObjectBytes).toBe(DEFAULT_MAX_OBJECT_BYTES);
    } finally {
      await sys.terminate();
    }
  });
});

describe('JetStreamObjectStoreActor — put / get / info / list / delete', () => {
  test('put stores the body and get reads it back with its metadata', async () => {
    const sys = newSystem('object-roundtrip');
    try {
      const { actor, target, targetRef } = await boot(sys, baseOptions());
      actor.tell({
        kind: 'put', name: 'notes.txt', payload: 'hello',
        description: 'a note', headers: { 'Content-Type': 'text/plain' },
        target: targetRef,
      });
      await awaitCondition(() => target.received.length === 1, { label: 'put receipt arrived' });
      const stored = target.received[0]!;
      expect(stored.kind).toBe('objectStored');
      if (stored.kind !== 'objectStored') throw new Error('unreachable');
      expect(stored.info.size).toBe(5);
      expect(stored.info.modifiedAt).toBe(Date.parse('2026-08-10T00:00:00.000Z'));

      actor.tell({ kind: 'get', name: 'notes.txt', target: targetRef });
      await awaitCondition(() => target.received.length === 2, { label: 'body arrived' });
      const body = target.received[1]!;
      expect(body.kind).toBe('objectBody');
      if (body.kind !== 'objectBody') throw new Error('unreachable');
      expect(new TextDecoder().decode(body.payload)).toBe('hello');
      expect(body.info.description).toBe('a note');
      expect(body.info.headers).toEqual({ 'Content-Type': 'text/plain' });
    } finally {
      await sys.terminate();
    }
  });

  test('a string payload is encoded exactly once', async () => {
    const sys = newSystem('object-single-encode');
    try {
      const { actor, mock, target, targetRef } = await boot(sys, baseOptions());
      actor.tell({ kind: 'put', name: 'u.txt', payload: 'äöü', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'put receipt arrived' });
      // 3 two-byte code points — proof the admission check measured the
      // encoded length, not the string length, and did not double-encode.
      expect(mock.mockConnection.store.putCalls[0]?.bytes).toBe(6);
    } finally {
      await sys.terminate();
    }
  });

  test('get / info on a missing or deleted object answer objectNotFound', async () => {
    const sys = newSystem('object-missing');
    try {
      const { actor, target, targetRef } = await boot(sys, baseOptions());
      actor.tell({ kind: 'get', name: 'nope', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'missing get answered' });
      expect(target.received[0]).toEqual({ kind: 'objectNotFound', name: 'nope' });

      actor.tell({ kind: 'put', name: 'gone', payload: 'x' });
      actor.tell({ kind: 'delete', name: 'gone', target: targetRef });
      await awaitCondition(() => target.received.length === 2, { label: 'delete receipt arrived' });
      expect(target.received[1]).toEqual({ kind: 'objectDeleted', name: 'gone' });

      actor.tell({ kind: 'info', name: 'gone', target: targetRef });
      await awaitCondition(() => target.received.length === 3, { label: 'info-after-delete answered' });
      expect(target.received[2]).toEqual({ kind: 'objectNotFound', name: 'gone' });
    } finally {
      await sys.terminate();
    }
  });

  test('list omits deleted objects', async () => {
    const sys = newSystem('object-list');
    try {
      const { actor, target, targetRef } = await boot(sys, baseOptions());
      actor.tell({ kind: 'put', name: 'a', payload: 'a' });
      actor.tell({ kind: 'put', name: 'b', payload: 'bb' });
      actor.tell({ kind: 'delete', name: 'b' });
      actor.tell({ kind: 'list', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'listing arrived' });
      const listing = target.received[0]!;
      expect(listing.kind).toBe('objectList');
      if (listing.kind !== 'objectList') throw new Error('unreachable');
      expect(listing.objects.map((info) => info.name)).toEqual(['a']);
    } finally {
      await sys.terminate();
    }
  });

  test('a store error is reported as objectStoreOperationFailed, not a disconnect', async () => {
    const sys = newSystem('object-error');
    try {
      const { actor, mock, target, targetRef } = await boot(sys, baseOptions());
      mock.mockConnection.store.failNext = { operation: 'put', reason: 'bucket full' };
      actor.tell({ kind: 'put', name: 'x', payload: 'x', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'write failure reported' });
      expect(target.received[0]).toEqual({
        kind: 'objectStoreOperationFailed', operation: 'put', name: 'x', reason: 'bucket full',
      });

      // Still connected and serving.
      actor.tell({ kind: 'list', target: targetRef });
      await awaitCondition(() => target.received.length === 2, { label: 'actor still answers' });
      expect(target.received[1]!.kind).toBe('objectList');
    } finally {
      await sys.terminate();
    }
  });
});

describe('JetStreamObjectStoreActor — the whole-object ceiling', () => {
  test('an oversize put is rejected before it reaches the outbound buffer', async () => {
    const sys = newSystem('object-put-too-big');
    try {
      const { actor, mock, target, targetRef } = await boot(sys, baseOptions().withMaxObjectBytes(16));
      actor.tell({ kind: 'put', name: 'big', payload: 'x'.repeat(64), target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'oversize put refused' });
      const failure = target.received[0]!;
      expect(failure.kind).toBe('objectStoreOperationFailed');
      if (failure.kind !== 'objectStoreOperationFailed') throw new Error('unreachable');
      expect(failure.operation).toBe('put');
      expect(failure.reason).toContain('64 bytes');
      expect(failure.reason).toContain('16-byte');

      // The point of rejecting at receipt time: the body never entered the
      // bounded FIFO, and never reached the wire.
      expect(mock.bufferedOutbound).toBe(0);
      expect(mock.mockConnection.store.putCalls).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('an oversize get is refused from metadata — the body is never fetched', async () => {
    const sys = newSystem('object-get-too-big');
    try {
      const { actor, mock, target, targetRef } = await boot(sys, baseOptions().withMaxObjectBytes(16));
      mock.mockConnection.store.seed(
        { name: 'big', size: 1_048_576, chunks: 8, digest: 'SHA-256=x', mtime: '2026-08-10T00:00:00.000Z' },
        new Uint8Array(0),
      );
      actor.tell({ kind: 'get', name: 'big', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'oversize get refused' });
      const failure = target.received[0]!;
      expect(failure.kind).toBe('objectStoreOperationFailed');
      if (failure.kind !== 'objectStoreOperationFailed') throw new Error('unreachable');
      expect(failure.operation).toBe('get');
      expect(failure.reason).toContain('1048576 bytes');
      expect(mock.mockConnection.store.getBlobCalls).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('info still answers for an object over the ceiling — metadata carries no body', async () => {
    const sys = newSystem('object-info-too-big');
    try {
      const { actor, mock, target, targetRef } = await boot(sys, baseOptions().withMaxObjectBytes(16));
      mock.mockConnection.store.seed(
        { name: 'big', size: 1_048_576, chunks: 8, digest: 'SHA-256=x', mtime: '2026-08-10T00:00:00.000Z' },
        new Uint8Array(0),
      );
      actor.tell({ kind: 'info', name: 'big', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'metadata answered' });
      const info = target.received[0]!;
      expect(info.kind).toBe('objectInfo');
      if (info.kind !== 'objectInfo') throw new Error('unreachable');
      expect(info.info.size).toBe(1_048_576);
    } finally {
      await sys.terminate();
    }
  });

  test('a body exactly at the ceiling is accepted', async () => {
    const sys = newSystem('object-at-ceiling');
    try {
      const { actor, mock, target, targetRef } = await boot(sys, baseOptions().withMaxObjectBytes(16));
      actor.tell({ kind: 'put', name: 'edge', payload: new Uint8Array(16), target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'boundary put answered' });
      expect(target.received[0]!.kind).toBe('objectStored');
      expect(mock.mockConnection.store.putCalls[0]?.bytes).toBe(16);
    } finally {
      await sys.terminate();
    }
  });

  test('an oversize put without a target is dropped and logged, not enqueued', async () => {
    const sys = newSystem('object-oversize-no-target');
    try {
      const { actor, mock } = await boot(sys, baseOptions().withMaxObjectBytes(4));
      actor.tell({ kind: 'put', name: 'big', payload: 'x'.repeat(64) });
      // Nothing observable is produced on purpose, so this is the one place
      // a bare sleep is right: the assertion is that nothing happened.
      await sleep(30);
      expect(mock.bufferedOutbound).toBe(0);
      expect(mock.mockConnection.store.putCalls).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });
});
