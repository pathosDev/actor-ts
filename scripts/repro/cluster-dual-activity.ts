/**
 * End-to-end reproduction for two ways a sharded entity ends up live on two
 * nodes at once — reported from a downstream project on 0.17.0 and posted on
 * #1272 and #940. Three real processes on one host, no Docker.
 *
 *   bun scripts/repro/cluster-dual-activity.ts restart   # #1272: restart the lowest-addressed node
 *   bun scripts/repro/cluster-dual-activity.ts pause [ms] # #940: stall one node (8000 ms default) past the downing window
 *
 * Ground truth for "where does an entity run" is the entity itself: every
 * live incarnation reports from its own 500 ms timer, so an id whose reports
 * alternate A, B, A within a second is running twice. A clean move (A … A,
 * then B … B) does not count.
 *
 * The `pause` scenario stalls the node's event loop with `Atomics.wait` rather
 * than `SIGSTOP`, so it also runs on Windows. From the cluster's point of view
 * the two are the same thing: the process neither sends nor reads, the kernel
 * buffers what peers send it, and on resume the queued frames are read before
 * the overdue timers fire. A long GC pause or a suspended VM looks identical.
 *
 * Not a test: it takes ~40 s and needs free local ports 25531–25533. It is
 * kept beside the fixes so the before/after figures on the issues can be
 * re-measured.
 */
import { Actor, NoopLogger } from '../../src/index.js';
import {
  Cluster,
  DistributedDataCoordinatorStateStore,
  KeepMajority,
  MemberLeft,
  SelfRemoved,
  ShardKey,
  SingletonKey,
} from '../../src/cluster/index.js';
import { DistributedDataId } from '../../src/crdt/index.js';

const PORTS = [25531, 25532, 25533];
const SEEDS = PORTS.map((port) => `127.0.0.1:${port}`);
const ENTITIES = Array.from({ length: 30 }, (_, i) => `e${i + 1}`);
const PAUSE_MS = Number(process.argv[3] ?? 8_000);

type Report = { event: string; port: number; time: number; id?: string };

if (process.argv[2] === 'node') {
  await runNode(Number(process.argv[3]));
} else {
  await drive(process.argv[2] ?? 'restart');
}

async function runNode(port: number): Promise<void> {
  const report = (event: string, extra: object = {}) =>
    console.log(JSON.stringify({ event, port, time: Date.now(), ...extra }));

  type EntityCommand = { id: string; kind: 'wake' | 'beat' };
  class Entity extends Actor<EntityCommand> {
    static readonly shard = ShardKey.of<EntityCommand>('entity', (command) => command.id);
    override preStart(): void {
      this.context.timers.startTimerWithFixedDelay('beat', { id: this.entityId, kind: 'beat' }, 500);
    }
    override onReceive(command: EntityCommand): void {
      if (command.kind === 'beat') report('alive', { id: this.entityId });
    }
  }
  class Waker extends Actor<'tick'> {
    static readonly singleton = SingletonKey.of<'tick'>('waker');
    override preStart(): void {
      this.context.timers.startTimerWithFixedDelay('tick', 'tick', 250);
    }
    override onReceive(): void {
      for (const id of ENTITIES) region.tell({ id, kind: 'wake' });
    }
  }

  const { system, cluster } = await Cluster.bootstrap({
    name: 'repro',
    host: '127.0.0.1',
    port,
    seeds: SEEDS,
    stableObservation: { stableMarginMs: 1000, pollIntervalMs: 250, selfElectionGraceMs: 2000 },
    logger: new NoopLogger(),
    shutdownOnSignals: false,
    failureDetector: { heartbeatIntervalMs: 200, unreachableAfterMs: 1000, downAfterMs: 2500 },
    gossipIntervalMs: 200,
    downing: new KeepMajority(),
    // The default 20 s window would not down a node paused for 8 s at all;
    // the downstream report ran on 0.17.0, before #839 introduced it.
    splitBrainResolver: { stableAfterMs: 3000 },
    awaitReady: false,
  });
  cluster.subscribe((event) => {
    if (event instanceof SelfRemoved) {
      report('self-removed');
      process.exit(3);
    }
    if (event instanceof MemberLeft && event.member.address.equals(cluster.selfAddress)) {
      report('self-left');
    }
  });
  const coordinatorStateStore = new DistributedDataCoordinatorStateStore(
    system.extension(DistributedDataId).start(cluster),
    String(port),
  );
  const region = cluster.sharding.start(Entity, () => new Entity(), {
    numShards: 30,
    passivationIdleMs: 0,
    coordinatorStateStore,
  });
  cluster.singleton.start(Waker, () => new Waker());

  // `freeze <ms>` on stdin stalls the whole event loop, like SIGSTOP would.
  void (async () => {
    for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
      const match = /freeze (\d+)/.exec(new TextDecoder().decode(chunk));
      if (match) {
        report('frozen');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(match[1]));
        report('resumed');
      }
    }
  })();
  report('up');
}

async function drive(scenario: string): Promise<void> {
  const reports: Report[] = [];
  const processes = new Map<number, ReturnType<typeof Bun.spawn>>();
  const start = (port: number) => {
    const child = Bun.spawn(['bun', import.meta.path, 'node', String(port)], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    processes.set(port, child);
    void (async () => {
      let buffer = '';
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
        buffer += new TextDecoder().decode(chunk);
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          try {
            reports.push(JSON.parse(buffer.slice(0, newline)) as Report);
          } catch {
            // not a report line
          }
          buffer = buffer.slice(newline + 1);
        }
      }
    })();
  };
  const runningTwice = (from: number, to: number): string[] => {
    const beatsById = new Map<string, Report[]>();
    for (const r of reports) {
      if (r.event === 'alive' && r.time >= from && r.time < to) {
        beatsById.set(r.id!, [...(beatsById.get(r.id!) ?? []), r]);
      }
    }
    const found: string[] = [];
    for (const [id, beats] of beatsById) {
      beats.sort((a, b) => a.time - b.time);
      for (let i = 0; i + 2 < beats.length; i++) {
        const [a, b] = [beats[i]!, beats[i + 1]!];
        if (a.port !== b.port && beats.slice(i + 2).some((c) => c.port === a.port && c.time - b.time < 1000)) {
          found.push(`${id}@${a.port}+${b.port}`);
          break;
        }
      }
    }
    return found;
  };
  const stopAll = () => {
    for (const child of processes.values()) child.kill(9);
  };

  for (const port of PORTS) start(port);
  await Bun.sleep(8000);

  if (scenario === 'restart') {
    const lowest = PORTS[0]!;
    processes.get(lowest)!.kill(9);
    await Bun.sleep(6000);
    const restartedAt = Date.now();
    start(lowest);
    await Bun.sleep(15000);
    const now = Date.now();
    const early = runningTwice(restartedAt, restartedAt + 5000);
    const late = runningTwice(now - 2000, now);
    console.log(
      `restart of ${lowest}: ${early.length} of ${ENTITIES.length} entities live on two nodes in the first 5 s, ${late.length} still at 13–15 s`,
    );
    if (early.length > 0) console.log(early.slice(0, 10).join(' '));
    stopAll();
    process.exit(early.length > 0 || late.length > 0 ? 1 : 0);
  }

  const victim = PORTS[1]!;
  const ownBefore = new Set(
    reports.filter((r) => r.event === 'alive' && r.port === victim && r.time > Date.now() - 1000).map((r) => r.id),
  );
  const child = processes.get(victim)!;
  (child.stdin as import('bun').FileSink).write(`freeze ${PAUSE_MS}\n`);
  await Bun.sleep(PAUSE_MS + 200);
  const resumedAt = Date.now();
  await Bun.sleep(15000);
  const now = Date.now();
  const resumed = reports.find((r) => r.port === victim && r.event === 'resumed')?.time ?? resumedAt;
  const after = reports.filter((r) => r.port === victim && r.time >= resumed);
  const left = after.find((r) => r.event === 'self-left')?.time;
  // Every id that ran on two nodes at any point after the resume, not only at
  // the end: a node that stands down 20 s late still ran a second copy.
  const twice = runningTwice(resumed, now);
  console.log(
    `pause of ${victim} for ${PAUSE_MS} ms (it hosted ${ownBefore.size} entities): after resume ` +
      `self-removed=${after.some((r) => r.event === 'self-removed')}, ` +
      `left the cluster ${left === undefined ? 'never' : `${left - resumed} ms after resuming`}, ` +
      `${twice.length} of ${ENTITIES.length} entities live on two nodes at some point after resume`,
  );
  if (twice.length > 0) console.log(twice.slice(0, 10).join(' '));
  stopAll();
  // A pause the survivors waited out is not a removal: the node stays, and only
  // a second copy of an entity is a failure either way.
  process.exit(twice.length > 0 ? 1 : 0);
}
