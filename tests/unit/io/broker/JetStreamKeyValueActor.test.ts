/**
 * Unit tests for `JetStreamKeyValueActor` (#74).
 *
 * Same test-seam pattern as `JetStreamActor`: subclass the actor and
 * override `createNatsConnection` to inject a pure-JS mock, so the whole
 * command surface — including the compare-and-swap path and the watch
 * pump — is driven without the `nats` peer-dep or a live server.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import {
  JetStreamKeyValueActor,
  type JetStreamKeyValueCommand,
  type JetStreamKeyValueMessage,
  type KeyValueBucketOptionsLike,
  type KeyValueEntryLike,
  type KeyValueJetStreamClientLike,
  type KeyValueNatsConnectionLike,
  type KeyValueStoreLike,
  type KeyValueWatchLike,
} from '../../../../src/io/broker/JetStreamKeyValueActor.js';
import {
  JetStreamKeyValueOptions,
  type JetStreamKeyValueOptionsBuilder,
  type JetStreamKeyValueOptionsType,
} from '../../../../src/io/broker/JetStreamKeyValueOptions.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/* --------------------------- Mocks ----------------------------- */

/** In-memory KV bucket with the revision + tombstone semantics we rely on. */
class MockKeyValueStore implements KeyValueStoreLike {
  private readonly entries = new Map<string, KeyValueEntryLike>();
  private revisionCounter = 0;
  readonly watches: MockWatch[] = [];
  /** Set to make the next operation of that kind reject. */
  failNext: { operation: 'get' | 'put' | 'delete' | 'purge' | 'keys'; reason: string } | null = null;

  async get(key: string): Promise<KeyValueEntryLike | null> {
    this.throwIfArmed('get');
    return this.entries.get(key) ?? null;
  }

  async put(key: string, value: Uint8Array): Promise<number> {
    this.throwIfArmed('put');
    return this.write(key, value, 'PUT');
  }

  async update(key: string, value: Uint8Array, revision: number): Promise<number> {
    this.throwIfArmed('put');
    const current = this.entries.get(key);
    const currentRevision = current && current.operation === 'PUT' ? current.revision : 0;
    if (currentRevision !== revision) {
      throw new Error(`wrong last sequence: ${currentRevision}`);
    }
    return this.write(key, value, 'PUT');
  }

  async delete(key: string): Promise<void> {
    this.throwIfArmed('delete');
    this.write(key, new Uint8Array(0), 'DEL');
  }

  async purge(key: string): Promise<void> {
    this.throwIfArmed('purge');
    this.write(key, new Uint8Array(0), 'PURGE');
  }

  async keys(filter?: string): Promise<AsyncIterable<string>> {
    this.throwIfArmed('keys');
    // Enough of the NATS subject-filter grammar for the tests: a trailing
    // `>` is the multi-token wildcard, anything else is an exact key.
    const matches = (key: string): boolean => {
      if (filter === undefined) return true;
      if (filter.endsWith('>')) return key.startsWith(filter.slice(0, -1));
      return key === filter;
    };
    const live = [...this.entries.values()]
      .filter((entry) => entry.operation === 'PUT')
      .filter((entry) => matches(entry.key))
      .map((entry) => entry.key);
    return (async function* () { for (const key of live) yield key; })();
  }

  async watch(options?: { key?: string }): Promise<KeyValueWatchLike> {
    const watch = new MockWatch(options?.key);
    this.watches.push(watch);
    return watch;
  }

  /** Simulate a change arriving from another writer. */
  emit(entry: KeyValueEntryLike): void {
    for (const watch of this.watches) watch.push(entry);
  }

  private write(key: string, value: Uint8Array, operation: KeyValueEntryLike['operation']): number {
    const revision = ++this.revisionCounter;
    this.entries.set(key, { key, value, revision, created: new Date(revision), operation });
    return revision;
  }

  private throwIfArmed(operation: 'get' | 'put' | 'delete' | 'purge' | 'keys'): void {
    if (this.failNext?.operation !== operation) return;
    const { reason } = this.failNext;
    this.failNext = null;
    throw new Error(reason);
  }
}

/** Async-iterable watch handle the actor's pump drives via `for await`. */
class MockWatch implements KeyValueWatchLike {
  stopped = false;
  private resolveNext: ((r: IteratorResult<KeyValueEntryLike>) => void) | null = null;
  private readonly buffer: KeyValueEntryLike[] = [];

  constructor(readonly key: string | undefined) {}

  push(entry: KeyValueEntryLike): void {
    if (this.resolveNext) {
      const resolveNext = this.resolveNext;
      this.resolveNext = null;
      resolveNext({ value: entry, done: false });
    } else {
      this.buffer.push(entry);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.resolveNext) {
      const resolveNext = this.resolveNext;
      this.resolveNext = null;
      resolveNext({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<KeyValueEntryLike> {
    return {
      next: (): Promise<IteratorResult<KeyValueEntryLike>> => {
        if (this.buffer.length > 0) return Promise.resolve({ value: this.buffer.shift()!, done: false });
        if (this.stopped) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolveNext) => { this.resolveNext = resolveNext; });
      },
    };
  }
}

class MockConnection implements KeyValueNatsConnectionLike {
  readonly store = new MockKeyValueStore();
  readonly bucketCalls: Array<{ bucket: string; options?: KeyValueBucketOptionsLike }> = [];
  private closedResolve!: (e: Error | undefined) => void;
  private readonly closedPromise = new Promise<Error | undefined>((r) => { this.closedResolve = r; });

  jetstream(): KeyValueJetStreamClientLike {
    return {
      views: {
        kv: async (bucket: string, options?: KeyValueBucketOptionsLike): Promise<KeyValueStoreLike> => {
          this.bucketCalls.push({ bucket, options });
          return this.store;
        },
      },
    };
  }

  async drain(): Promise<void> { this.closedResolve(undefined); }
  closed(): Promise<Error | undefined> { return this.closedPromise; }
}

class MockKeyValueActor extends JetStreamKeyValueActor {
  readonly mockConnection = new MockConnection();
  protected override async createNatsConnection(): Promise<KeyValueNatsConnectionLike> {
    return this.mockConnection;
  }
  /** Exposes the merged settings so the HOCON-precedence test can read them. */
  get resolvedOptions(): JetStreamKeyValueOptionsType { return this.options; }
}

/* --------------------------- Helpers ---------------------------- */

class CollectingTarget extends Actor<JetStreamKeyValueMessage> {
  readonly received: JetStreamKeyValueMessage[] = [];
  override onReceive(message: JetStreamKeyValueMessage): void { this.received.push(message); }
}

type Harness = {
  readonly actor: ActorRef<JetStreamKeyValueCommand>;
  readonly mock: MockKeyValueActor;
  readonly target: CollectingTarget;
  readonly targetRef: ActorRef<JetStreamKeyValueMessage>;
};

function newSystem(name: string, config?: ConfigObject): ActorSystem {
  let sysOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (config) sysOptions = sysOptions.withConfig(config);
  return ActorSystem.create(name, sysOptions);
}

async function boot(sys: ActorSystem, options: JetStreamKeyValueOptionsBuilder): Promise<Harness> {
  const target = new CollectingTarget();
  const targetRef = sys.spawn(() => target, 'target') as ActorRef<JetStreamKeyValueMessage>;
  const held = { current: null as MockKeyValueActor | null };
  const actor = sys.spawn(() => {
    const created = new MockKeyValueActor(options);
    held.current = created;
    return created;
  }, 'kv') as ActorRef<JetStreamKeyValueCommand>;
  // The bucket handle is the strongest observable "connected" signal.
  await awaitCondition(() => (held.current?.mockConnection.bucketCalls.length ?? 0) > 0, {
    label: 'JetStreamKeyValueActor bound its bucket',
  });
  return { actor, mock: held.current!, target, targetRef };
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

const baseOptions = (): JetStreamKeyValueOptionsBuilder => JetStreamKeyValueOptions.create()
  .withServers(['nats://fake:4222'])
  .withBucket('sessions');

/* ============================================================== */

describe('JetStreamKeyValueActor — bucket binding', () => {
  test('create=true (default) forwards the create-time limits', async () => {
    const sys = newSystem('kv-create');
    try {
      const options = baseOptions()
        .withHistory(5)
        .withTimeToLive(60_000)
        .withStorage('memory')
        .withReplicas(3)
        .withMaxValueBytes(4096);
      const { mock } = await boot(sys, options);
      expect(mock.mockConnection.bucketCalls[0]?.bucket).toBe('sessions');
      expect(mock.mockConnection.bucketCalls[0]?.options).toEqual({
        history: 5, ttl: 60_000, storage: 'memory', replicas: 3, maxValueSize: 4096,
      });
    } finally {
      await sys.terminate();
    }
  });

  test('create=false binds only — no create-time limits are sent', async () => {
    const sys = newSystem('kv-bind');
    try {
      const options = baseOptions()
        .withHistory(5)
        .withCreate(false);
      const { mock } = await boot(sys, options);
      expect(mock.mockConnection.bucketCalls[0]?.options).toEqual({ bindOnly: true });
    } finally {
      await sys.terminate();
    }
  });

  test('HOCON under actor-ts.io.broker.jetstream-key-value feeds the options', async () => {
    const sys = newSystem('kv-hocon', {
      'actor-ts': {
        io: {
          broker: {
            'jetstream-key-value': {
              servers: ['nats://from-hocon:4222'],
              bucket: 'hocon-bucket',
              history: 7,
            },
          },
        },
      },
    });
    try {
      // Only the bucket comes from the builder — servers + history fall
      // through to HOCON, which is the precedence the base class promises.
      const options = JetStreamKeyValueOptions.create().withBucket('builder-bucket');
      const { mock } = await boot(sys, options);
      expect(mock.resolvedOptions.servers).toEqual(['nats://from-hocon:4222']);
      expect(mock.resolvedOptions.history).toBe(7);
      expect(mock.resolvedOptions.bucket).toBe('builder-bucket');
    } finally {
      await sys.terminate();
    }
  });
});

describe('JetStreamKeyValueActor — put / get / delete / purge', () => {
  test('put answers with the new revision and get reads the value back', async () => {
    const sys = newSystem('kv-put-get');
    try {
      const { actor, target, targetRef } = await boot(sys, baseOptions());
      actor.tell({ kind: 'put', key: 'user.42', value: 'hello', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'put receipt arrived' });
      expect(target.received[0]).toEqual({ kind: 'keyValueRevision', key: 'user.42', revision: 1 });

      actor.tell({ kind: 'get', key: 'user.42', target: targetRef });
      await awaitCondition(() => target.received.length === 2, { label: 'get answer arrived' });
      const entry = target.received[1]!;
      expect(entry.kind).toBe('keyValueEntry');
      if (entry.kind !== 'keyValueEntry') throw new Error('unreachable');
      expect(decode(entry.value)).toBe('hello');
      expect(entry.revision).toBe(1);
      expect(entry.createdAt).toBe(1);
    } finally {
      await sys.terminate();
    }
  });

  test('get on a missing key answers keyValueNotFound', async () => {
    const sys = newSystem('kv-missing');
    try {
      const { actor, target, targetRef } = await boot(sys, baseOptions());
      actor.tell({ kind: 'get', key: 'nobody', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'not-found answer arrived' });
      expect(target.received[0]).toEqual({ kind: 'keyValueNotFound', key: 'nobody' });
    } finally {
      await sys.terminate();
    }
  });

  test('get on a deleted key answers keyValueNotFound, not the tombstone', async () => {
    const sys = newSystem('kv-tombstone');
    try {
      const { actor, target, targetRef } = await boot(sys, baseOptions());
      actor.tell({ kind: 'put', key: 'gone', value: 'x' });
      actor.tell({ kind: 'delete', key: 'gone', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'delete receipt arrived' });
      expect(target.received[0]).toEqual({ kind: 'keyValueRemoved', key: 'gone', purged: false });

      actor.tell({ kind: 'get', key: 'gone', target: targetRef });
      await awaitCondition(() => target.received.length === 2, { label: 'get-after-delete answered' });
      expect(target.received[1]).toEqual({ kind: 'keyValueNotFound', key: 'gone' });
    } finally {
      await sys.terminate();
    }
  });

  test('purge reports purged=true', async () => {
    const sys = newSystem('kv-purge');
    try {
      const { actor, target, targetRef } = await boot(sys, baseOptions());
      actor.tell({ kind: 'put', key: 'temp', value: 'x' });
      actor.tell({ kind: 'purge', key: 'temp', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'purge receipt arrived' });
      expect(target.received[0]).toEqual({ kind: 'keyValueRemoved', key: 'temp', purged: true });
    } finally {
      await sys.terminate();
    }
  });

  test('keys lists only live keys, honouring the filter', async () => {
    const sys = newSystem('kv-keys');
    try {
      const { actor, target, targetRef } = await boot(sys, baseOptions());
      actor.tell({ kind: 'put', key: 'user.1', value: 'a' });
      actor.tell({ kind: 'put', key: 'user.2', value: 'b' });
      actor.tell({ kind: 'put', key: 'other.1', value: 'c' });
      actor.tell({ kind: 'delete', key: 'user.2' });
      actor.tell({ kind: 'keys', filter: 'user.>', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'key list arrived' });
      expect(target.received[0]).toEqual({ kind: 'keyValueKeys', keys: ['user.1'] });
    } finally {
      await sys.terminate();
    }
  });
});

describe('JetStreamKeyValueActor — compare-and-swap', () => {
  test('expectedRevision matching the stored revision writes', async () => {
    const sys = newSystem('kv-cas-ok');
    try {
      const { actor, target, targetRef } = await boot(sys, baseOptions());
      actor.tell({ kind: 'put', key: 'counter', value: '1', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'first write acknowledged' });

      actor.tell({ kind: 'put', key: 'counter', value: '2', expectedRevision: 1, target: targetRef });
      await awaitCondition(() => target.received.length === 2, { label: 'compare-and-swap acknowledged' });
      expect(target.received[1]).toEqual({ kind: 'keyValueRevision', key: 'counter', revision: 2 });
    } finally {
      await sys.terminate();
    }
  });

  test('a stale expectedRevision fails the operation without killing the connection', async () => {
    const sys = newSystem('kv-cas-conflict');
    try {
      const { actor, target, targetRef } = await boot(sys, baseOptions());
      actor.tell({ kind: 'put', key: 'counter', value: '1' });
      actor.tell({ kind: 'put', key: 'counter', value: '2', expectedRevision: 99, target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'conflict reported' });
      const failure = target.received[0]!;
      expect(failure.kind).toBe('keyValueOperationFailed');
      if (failure.kind !== 'keyValueOperationFailed') throw new Error('unreachable');
      expect(failure.operation).toBe('put');
      expect(failure.key).toBe('counter');

      // The actor is still usable — a failed key must not tear the
      // connection down (that is what dispatchOutgoing throwing would do).
      actor.tell({ kind: 'get', key: 'counter', target: targetRef });
      await awaitCondition(() => target.received.length === 2, { label: 'actor still answers' });
      expect(target.received[1]!.kind).toBe('keyValueEntry');
    } finally {
      await sys.terminate();
    }
  });

  test('a store error on get is reported as keyValueOperationFailed', async () => {
    const sys = newSystem('kv-get-error');
    try {
      const { actor, mock, target, targetRef } = await boot(sys, baseOptions());
      mock.mockConnection.store.failNext = { operation: 'get', reason: 'bucket unavailable' };
      actor.tell({ kind: 'get', key: 'anything', target: targetRef });
      await awaitCondition(() => target.received.length === 1, { label: 'read failure reported' });
      expect(target.received[0]).toEqual({
        kind: 'keyValueOperationFailed', operation: 'get', key: 'anything', reason: 'bucket unavailable',
      });
    } finally {
      await sys.terminate();
    }
  });
});

describe('JetStreamKeyValueActor — watch', () => {
  test('watch streams puts and removals, and defaults to the whole bucket', async () => {
    const sys = newSystem('kv-watch');
    try {
      const { actor, mock, target, targetRef } = await boot(sys, baseOptions());
      actor.tell({ kind: 'watch', target: targetRef });
      await awaitCondition(() => mock.mockConnection.store.watches.length === 1, {
        label: 'watch established on the bucket',
      });
      expect(mock.mockConnection.store.watches[0]!.key).toBe('>');

      mock.mockConnection.store.emit({
        key: 'user.7', value: new TextEncoder().encode('v'), revision: 9,
        created: new Date(1_700_000_000_000), operation: 'PUT',
      });
      await awaitCondition(() => target.received.length === 1, { label: 'watched put delivered' });
      expect(target.received[0]).toEqual({
        kind: 'keyValueEntry', key: 'user.7', value: new TextEncoder().encode('v'),
        revision: 9, createdAt: 1_700_000_000_000,
      });

      mock.mockConnection.store.emit({
        key: 'user.7', value: new Uint8Array(0), revision: 10,
        created: new Date(0), operation: 'PURGE',
      });
      await awaitCondition(() => target.received.length === 2, { label: 'watched purge delivered' });
      expect(target.received[1]).toEqual({ kind: 'keyValueRemoved', key: 'user.7', purged: true });
    } finally {
      await sys.terminate();
    }
  });

  test('unwatch stops the handle', async () => {
    const sys = newSystem('kv-unwatch');
    try {
      const { actor, mock, targetRef } = await boot(sys, baseOptions());
      actor.tell({ kind: 'watch', key: 'user.>', target: targetRef });
      await awaitCondition(() => mock.mockConnection.store.watches.length === 1, {
        label: 'watch established',
      });
      actor.tell({ kind: 'unwatch', key: 'user.>' });
      await awaitCondition(() => mock.mockConnection.store.watches[0]!.stopped, {
        label: 'watch handle stopped',
      });
    } finally {
      await sys.terminate();
    }
  });

  test('a watch issued before the connect lands on the bucket anyway', async () => {
    const sys = newSystem('kv-watch-early');
    try {
      // Spawn actor + target, then send `watch` immediately — the actor is
      // still in preStart, so this exercises the desired-state path rather
      // than the already-connected one.
      const target = new CollectingTarget();
      const targetRef = sys.spawn(() => target, 'target') as ActorRef<JetStreamKeyValueMessage>;
      const held = { current: null as MockKeyValueActor | null };
      const actor = sys.spawn(() => {
        const created = new MockKeyValueActor(baseOptions());
        held.current = created;
        return created;
      }, 'kv') as ActorRef<JetStreamKeyValueCommand>;
      actor.tell({ kind: 'watch', target: targetRef });

      await awaitCondition(() => (held.current?.mockConnection.store.watches.length ?? 0) === 1, {
        label: 'early watch established after connect',
      });
    } finally {
      await sys.terminate();
    }
  });
});
