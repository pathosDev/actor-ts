import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { ActorFactory } from '../../../../src/Actor.js';
import {
  DurableStateActor,
  DurableStateConcurrencyError,
  DurableStateOptions,
  InMemoryDurableStateStore,
  type DurableStateStore,
} from '../../../../src/persistence/index.js';

import { gracefulStop } from '../../../../src/pattern/GracefulStop.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type KV = { readonly map: Record<string, string>; };
type Command =
  | { kind: 'set'; key: string; value: string; replyTo: import('../../../../src/ActorRef.js').ActorRef }
  | { kind: 'get'; key: string; replyTo: import('../../../../src/ActorRef.js').ActorRef };

class KVActor extends DurableStateActor<Command, KV> {
  override async onCommand(command: Command): Promise<void> {
    if (command.kind === 'set') {
      const next: KV = { map: { ...this.state.map, [command.key]: command.value } };
      await this.persist(next);
      command.replyTo.tell({ kind: 'ok', revision: this.revision } as never);
      return;
    }
    command.replyTo.tell({ kind: 'value', value: this.state.map[command.key] ?? null } as never);
  }
}

const kvActor = (store: DurableStateStore, id: string): ActorFactory<Command> =>
  () => {
    const durableStateOptions = DurableStateOptions.create<KV>()
      .withPersistenceId(id)
      .withStore(store)
      .withEmptyState(() => ({ map: {} }));
    return new KVActor(durableStateOptions) as unknown as import('../../../../src/Actor.js').Actor<Command>;
  };

describe('InMemoryDurableStateStore', () => {
  test('upsert + load round-trip with monotonic revisions', async () => {
    const store = new InMemoryDurableStateStore();
    const r1 = await store.upsert('a', 0, { n: 1 });
    expect(r1.revision).toBe(1);
    const r2 = await store.upsert('a', 1, { n: 2 });
    expect(r2.revision).toBe(2);
    const loaded = (await store.load<{ n: number }>('a')).toNullable();
    expect(loaded?.revision).toBe(2);
    expect(loaded?.state.n).toBe(2);
  });

  test('stale expectedRevision throws DurableStateConcurrencyError', async () => {
    const store = new InMemoryDurableStateStore();
    await store.upsert('b', 0, { n: 1 });
    let caught: unknown = null;
    try { await store.upsert('b', 0, { n: 2 }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(DurableStateConcurrencyError);
  });

  test('delete removes the record', async () => {
    const store = new InMemoryDurableStateStore();
    await store.upsert('c', 0, { n: 1 });
    await store.delete('c');
    expect((await store.load('c')).isNone()).toBe(true);
  });

  test('rejects a negative or non-integer expectedRevision as an argument error', async () => {
    const store = new InMemoryDurableStateStore();
    // A bogus revision is a caller bug, not a lost race — surfacing it as a
    // concurrency conflict would invite an endless retry loop.  Same guard as
    // the relational and object-storage stores.
    await expect(store.upsert('d', -1, { n: 1 })).rejects.toThrow(/non-negative integer/);
    await expect(store.upsert('d', 1.5, { n: 1 })).rejects.toThrow(/non-negative integer/);
    expect((await store.load('d')).isNone()).toBe(true);
  });
});

describe('DurableStateActor', () => {
  const newSys = (): ActorSystem => {
    const sysOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    return ActorSystem.create('ds-test', sysOptions);
  };

  test('persisted state survives actor restart', async () => {
    const store = new InMemoryDurableStateStore();
    const sys = newSys();
    const reply: unknown[] = [];

    class Sink extends (await import('../../../../src/Actor.js')).Actor<{ kind: string }> {
      override onReceive(m: { kind: string }): void { reply.push(m); }
    }
    const sink = sys.spawnAnonymous(Sink);

    const ref = sys.spawnAnonymous(kvActor(store, 'user-1'));
    ref.tell({ kind: 'set', key: 'name', value: 'alice', replyTo: sink });
    // The `ok` reply is sent *after* `persist` resolves, so it is exactly the
    // "the write is durable" marker the restart depends on (#418).
    await awaitCondition(() => reply.length === 1, {
      timeoutMs: 4_000, label: 'the set was acknowledged after persisting',
    });
    // The restart below reuses the same persistence id, so the first instance has
    // to be really gone and not merely asked to stop.  `gracefulStop` resolves on
    // the termination itself, which is what the 30 ms was guessing at (#418).
    expect(await gracefulStop(ref, 4_000)).toBe(true);

    const restarted = sys.spawnAnonymous(kvActor(store, 'user-1'));
    restarted.tell({ kind: 'get', key: 'name', replyTo: sink });
    await awaitCondition(() => reply.length === 2, {
      timeoutMs: 4_000, label: 'the restarted actor answered the get',
    });

    // Last reply should be the 'alice' value.
    const found = reply.some((m) => (m as { kind: string; value?: string }).value === 'alice');
    expect(found).toBe(true);

    await sys.terminate();
  });
});
