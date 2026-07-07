import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Props } from '../../../../src/Props.js';
import {
  DurableStateActor,
  DurableStateConcurrencyError,
  DurableStateOptions,
  InMemoryDurableStateStore,
  type DurableStateStore,
} from '../../../../src/persistence/index.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

interface KV { readonly map: Record<string, string>; }
type Cmd =
  | { kind: 'set'; key: string; value: string; replyTo: import('../../../../src/ActorRef.js').ActorRef }
  | { kind: 'get'; key: string; replyTo: import('../../../../src/ActorRef.js').ActorRef };

class KVActor extends DurableStateActor<Cmd, KV> {
  override async onCommand(cmd: Cmd): Promise<void> {
    if (cmd.kind === 'set') {
      const next: KV = { map: { ...this.state.map, [cmd.key]: cmd.value } };
      await this.persist(next);
      cmd.replyTo.tell({ kind: 'ok', revision: this.revision } as never);
      return;
    }
    cmd.replyTo.tell({ kind: 'value', value: this.state.map[cmd.key] ?? null } as never);
  }
}

const kvProps = (store: DurableStateStore, id: string): Props<Cmd> =>
  Props.create(() => {
    const durableStateOptions = DurableStateOptions.create<KV>()
      .withPersistenceId(id)
      .withStore(store)
      .withEmptyState(() => ({ map: {} }));
    return new KVActor(durableStateOptions) as unknown as import('../../../../src/Actor.js').Actor<Cmd>;
  });

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
    const sink = sys.spawnAnonymous(Props.create(() => new Sink()));

    const ref = sys.spawnAnonymous(kvProps(store, 'user-1'));
    ref.tell({ kind: 'set', key: 'name', value: 'alice', replyTo: sink });
    await sleep(40);
    ref.stop();
    await sleep(30);

    const restarted = sys.spawnAnonymous(kvProps(store, 'user-1'));
    restarted.tell({ kind: 'get', key: 'name', replyTo: sink });
    await sleep(40);

    // Last reply should be the 'alice' value.
    const found = reply.some((m) => (m as { kind: string; value?: string }).value === 'alice');
    expect(found).toBe(true);

    await sys.terminate();
  });
});
