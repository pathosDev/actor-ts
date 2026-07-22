/**
 * Durable State KV: simpler than Event Sourcing — persist the full state
 * (not a log of changes) on each mutation.  Survives restart via the
 * InMemoryDurableStateStore (swap for a SQLite/Cassandra-backed one in
 * production).
 *
 *   bun run examples/persistence/durable-state-kv.ts
 */
import { match } from 'ts-pattern';
import {
  Actor,
  ActorSystem,
  DurableStateActor,
  DurableStateOptions,
  InMemoryDurableStateStore,
  Props,
} from '../../src/index.js';

interface KV { readonly map: Record<string, string>; }
type SetCommand = { kind: 'set'; key: string; value: string };
type GetCommand = { kind: 'get'; key: string };
type DumpCommand = { kind: 'dump' };
type Command = SetCommand | GetCommand | DumpCommand;

class KVStore extends DurableStateActor<Command, KV> {
  override async onCommand(command: Command): Promise<void> {
    await match(command)
      .with({ kind: 'set' }, (c) => this.onSet(c))
      .with({ kind: 'get' }, (c) => this.onGet(c))
      .with({ kind: 'dump' }, () => this.onDump())
      .exhaustive();
  }

  private async onSet(c: SetCommand): Promise<void> {
    const next: KV = { map: { ...this.state.map, [c.key]: c.value } };
    await this.persist(next);
    console.log(`set ${c.key}=${c.value} (rev=${this.revision})`);
  }

  private async onGet(c: GetCommand): Promise<void> {
    console.log(`get ${c.key}: ${this.state.map[c.key] ?? '<missing>'}`);
  }

  private async onDump(): Promise<void> {
    console.log('dump:', this.state.map);
  }
}

async function main(): Promise<void> {
  const system = ActorSystem.create('durable-kv');
  const store = new InMemoryDurableStateStore();

  let ref = system.spawnAnonymous(Props.create(() => new KVStore(
    DurableStateOptions.create<KV>()
      .withPersistenceId('app-config')
      .withStore(store)
      .withEmptyState(() => ({ map: {} })),
  ) as unknown as Actor<Command>));

  ref.tell({ kind: 'set', key: 'env', value: 'production' });
  ref.tell({ kind: 'set', key: 'version', value: '1.2.3' });
  ref.tell({ kind: 'get', key: 'env' });
  await Bun.sleep(50);

  // "Crash" — stop the actor, respawn it with the same store.
  ref.stop();
  await Bun.sleep(20);
  console.log('--- actor restarted ---');
  ref = system.spawnAnonymous(Props.create(() => new KVStore(
    DurableStateOptions.create<KV>()
      .withPersistenceId('app-config')
      .withStore(store)
      .withEmptyState(() => ({ map: {} })),
  ) as unknown as Actor<Command>));

  ref.tell({ kind: 'dump' });
  await Bun.sleep(50);
  await system.terminate();
}

void main();
