/**
 * Snapshot-frequency tradeoff — for a PersistentActor that emits one
 * event per command, compare write throughput AND recovery time across
 * four snapshot policies: never, every 1000 events, every 100 events,
 * every 10 events.
 *
 *   bun run benchmarks/persistence/snapshot-frequency.ts
 *
 * Snapshotting more often makes recovery faster (less to replay) but
 * slows the write path (every Nth command pays a snapshot-serialise +
 * store cost).  This benchmark quantifies both sides of the tradeoff
 * on the same workload so readers can pick a policy with real numbers.
 */
import {
  ActorSystem,
  ActorSystemOptions,
  InMemoryJournal,
  InMemorySnapshotStore,
  LogLevel,
  NoopLogger,
  PersistenceExtensionId,
  PersistentActor,
  Props,
  ask,
  everyNEvents,
  type SnapshotPolicy,
} from '../../src/index.js';
import { runGroup } from '../lib/harness.js';

type Cmd = { kind: 'inc' } | { kind: 'get' };
type Event = { delta: number };

function makeCounterClass(policy: SnapshotPolicy<number, Event>): typeof PersistentActor<Cmd, Event, number> {
  return class Counter extends PersistentActor<Cmd, Event, number> {
    readonly persistenceId: string;
    constructor(pid: string) { super(); this.persistenceId = pid; }
    initialState(): number { return 0; }
    onEvent(s: number, e: Event): number { return s + e.delta; }
    override snapshotPolicy(): SnapshotPolicy<number, Event> { return policy; }
    async onCommand(s: number, cmd: Cmd): Promise<void> {
      if (cmd.kind === 'inc') {
        await this.persist({ delta: 1 }, () => {});
        return;
      }
      this.sender.forEach((r) => r.tell(s));
    }
  } as unknown as typeof PersistentActor<Cmd, Event, number>;
}

interface Policy { label: string; unit: string; policy: SnapshotPolicy<number, Event>; }

const POLICIES: ReadonlyArray<Policy> = [
  { label: 'no snapshots',    unit: 'never',     policy: () => false },
  { label: 'snapshot / 1000', unit: 'every1000', policy: everyNEvents<number, Event>(1_000) },
  { label: 'snapshot / 100',  unit: 'every100',  policy: everyNEvents<number, Event>(100) },
  { label: 'snapshot / 10',   unit: 'every10',   policy: everyNEvents<number, Event>(10) },
];

const EVENTS_PER_RUN = 2_000;

async function main(): Promise<void> {
  console.log(
    `\n  Snapshot-frequency tradeoff — write ${EVENTS_PER_RUN.toLocaleString('en-US')} events per policy,\n`
    + `  then spawn a fresh actor against the same journal and measure recovery.\n`,
  );

  for (const pol of POLICIES) {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create(`bench-snap-${pol.unit}`, systemOptions);
    const ext = system.extension(PersistenceExtensionId);
    const journal = new InMemoryJournal();
    const snapshots = new InMemorySnapshotStore();
    ext.setJournal(journal);
    ext.setSnapshotStore(snapshots);

    const pid = `counter-${pol.unit}`;
    const Counter = makeCounterClass(pol.policy);
    const props = Props.create(() => new Counter(pid));
    let ref = system.spawnAnonymous(props);

    // --- phase 1: write throughput ---
    await runGroup(`persistence · write (${pol.label})`, [
      {
        name: `${EVENTS_PER_RUN.toLocaleString('en-US')} events`,
        unit: 'event',
        iterations: 1,
        opsPerIteration: EVENTS_PER_RUN,
        run: async () => {
          for (let i = 0; i < EVENTS_PER_RUN; i++) ref.tell({ kind: 'inc' });
          // Drain by asking for the final state — returns once all persists
          // have been applied.
          await ask<Cmd, number>(ref, { kind: 'get' }, 30_000);
        },
      },
    ]);

    // --- phase 2: recovery time ---
    ref.stop();
    await Bun.sleep(20);

    await runGroup(`persistence · recovery (${pol.label})`, [
      {
        name: `replay after ${EVENTS_PER_RUN.toLocaleString('en-US')} events`,
        unit: 'recovery',
        iterations: 5,
        run: async () => {
          const fresh = system.spawnAnonymous(Props.create(() => new Counter(pid)));
          // `get` returns the recovered state — blocks until replay finishes.
          await ask<Cmd, number>(fresh, { kind: 'get' }, 30_000);
          fresh.stop();
        },
      },
    ]);

    await system.terminate();
    // Small gap so the JIT can reclaim per-system state before the next policy.
    await Bun.sleep(50);
  }
}

void main();
