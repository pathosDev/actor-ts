/**
 * Recovery time — spawn a fresh PersistentActor against a pre-filled
 * journal and measure how long `preStart` takes to replay.
 *
 *   bun run benchmarks/persistence/recovery.ts
 */
import {
  ActorSystem,
  InMemoryJournal,
  InMemorySnapshotStore,
  LogLevel,
  NoopLogger,
  PersistenceExtensionId,
  PersistentActor,
  Props,
  ask,
  everyNEvents,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type Cmd = 'get';
type Event = { delta: number };

class Counter extends PersistentActor<Cmd, Event, number> {
  constructor(readonly persistenceId: string) { super(); }
  initialState(): number { return 0; }
  onEvent(s: number, e: Event): number { return s + e.delta; }
  override snapshotPolicy = everyNEvents<number, Event>(100);
  async onCommand(s: number, _cmd: Cmd): Promise<void> {
    this.sender.forEach((r) => r.tell(s));
  }
}

async function prefill(journal: InMemoryJournal, pid: string, n: number): Promise<void> {
  const events = Array.from({ length: n }, () => ({ delta: 1 }));
  await journal.append(pid, events, 0);
}

async function main(): Promise<void> {
  const system = ActorSystem.create('bench-recovery', { logger: new NoopLogger(), logLevel: LogLevel.Off });
  const journal = new InMemoryJournal();
  const snapshots = new InMemorySnapshotStore();
  const ext = system.extension(PersistenceExtensionId);
  ext.setJournal(journal);
  ext.setSnapshotStore(snapshots);

  const recovery = (pid: string) => async (): Promise<void> => {
    const ref = system.actorOf(Props.create(() => new Counter(pid)));
    await ask<Cmd, number>(ref, 'get', 30_000);
    ref.stop();
  };

  await prefill(journal, 'p100', 100);
  await prefill(journal, 'p10k', 10_000);

  await runGroup('persistence · recovery (event replay)', [
    { name: 'replay 100 events',    unit: 'event', iterations: 100, opsPerIteration: 100,    run: recovery('p100') },
    { name: 'replay 10,000 events', unit: 'event', iterations: 10,  opsPerIteration: 10_000, run: recovery('p10k') },
  ]);

  await system.terminate();
}

void main();
