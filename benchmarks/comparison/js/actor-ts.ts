/**
 * The actor-ts arm of the framework comparison (#27).
 *
 * This is the reference implementation of the four scenarios: every other
 * JavaScript arm is this file with a different framework behind the same
 * `ArmCase` contract, and the cross-language runners mirror these shapes by
 * hand.  So the definitions of the operations live here, and the rest of the
 * comparison follows them.
 *
 * Each `run()` returns work the framework was **observed** to complete, never
 * work it was asked to do — the distinction that separates a benchmark from a
 * number (#1027).  Concretely:
 *
 *  - **spawn** awaits confirmed `preStart` and confirmed `postStop` for every
 *    actor in the batch.  It has to.  `spawn` enqueues a `create` system
 *    message and returns; the actor is constructed on a later dispatcher turn,
 *    so a synchronous loop of 100 spawns finishes with zero actors alive.
 *    Timing that loop measures the enqueue and calls it actor creation —
 *    which is exactly what this repo's own spawn benchmarks currently do
 *    (#1204).  Waiting for the lifecycle is both the honest measurement and
 *    the only one that maps onto frameworks whose spawn is synchronous.
 *  - **tell-throughput** reads the counter back and returns what the actor
 *    actually handled.
 *  - **ask-round-trip** checks the reply's contents, so a reply that arrives
 *    wrong counts as zero rather than as a fast success.
 *  - **ping-pong** returns the exchange count the volleying actor itself
 *    tallied.
 *
 * ## Why these handlers dispatch with `if` and not `match`
 *
 * AGENTS.md requires every `match` arm in `src/` to delegate to a private
 * `onXxx` handler, and these actors keep the handlers — but the dispatch
 * itself is a plain conditional, because `match` is not free and the other
 * arms do not pay it.  Measured here, five interleaved rounds each:
 *
 * | tell-throughput | `match(...)` | plain `if` | cost   |
 * | --------------- | ------------ | ---------- | ------ |
 * | batch=1k        |     681k/s   |    827k/s  |  -18 % |
 * | batch=10k       |     748k/s   |    914k/s  |  -22 % |
 *
 * Comparing actor-ts *plus a ts-pattern matcher per message* against nact's
 * bare `if` would have charged this framework a fifth of its throughput for
 * a dispatch style the benchmark imposed rather than the framework requires.
 * The repo's own `single-node/tell-throughput.ts` uses a plain `if` for the
 * same reason, and the `if` figure is the one that agrees with the ~922k that
 * file's header has recorded since #411 — two independent paths to the same
 * number, which is what makes the rest of the table worth reading.
 *
 * The delta is a real finding rather than a benchmarking detail: a user
 * following the project's own house style pays it on every message.  See
 * #974 for the same matcher cost on the mailbox overflow path.
 *
 *   bun run benchmarks/comparison/js/actor-ts.ts
 */
import {
  Actor,
  ActorSystem,
  ActorSystemOptions,
  LogLevel,
  NoopLogger,
  ParallelismExtensionId,
  ParallelismOptions,
  type ActorRef,
} from '../../../src/index.js';
import { ParallelWorker, type WorkMessage } from './actor-ts-parallel-actors.js';
import { runArm, type ArmCase } from './arm.js';
import { actorTsVersion } from './environment.js';
import { workRounds, workSeed, workloadCase, type WorkloadCase } from './workload.js';

/**
 * Generous by design.  These timeouts exist to turn a deadlock into a
 * failure, not to bound a measurement — a benchmark that hangs produces no
 * output at all, which is the one outcome worse than a red one.
 */
const REPLY_TIMEOUT_MS = 60_000;
const LIFECYCLE_TIMEOUT_MS = 60_000;

/* ------------------------------- spawn ---------------------------------- */

/**
 * Counters the probe actors report their lifecycle through.  Module-level
 * because a framework-constructed actor has no call site to thread state
 * into, and the alternative — asking each actor whether it started — would
 * measure the asking.
 */
type LifecycleLatch = {
  startedCount: number;
  stoppedCount: number;
  readonly expected: number;
  readonly onAllStarted: () => void;
  readonly onAllStopped: () => void;
};

let lifecycleLatch: LifecycleLatch | null = null;

class SpawnProbeActor extends Actor<unknown> {
  override preStart(): void {
    if (lifecycleLatch !== null && ++lifecycleLatch.startedCount === lifecycleLatch.expected) {
      lifecycleLatch.onAllStarted();
    }
  }

  override postStop(): void {
    if (lifecycleLatch !== null && ++lifecycleLatch.stoppedCount === lifecycleLatch.expected) {
      lifecycleLatch.onAllStopped();
    }
  }

  override onReceive(): void {}
}

/** Fail loudly instead of hanging when a lifecycle signal never arrives. */
async function awaitWithin(promise: Promise<void>, milliseconds: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${milliseconds} ms waiting for ${what}`)), milliseconds);
  });
  try {
    await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/* ---------------------------- tell throughput ---------------------------- */

type IncrementMessage = { kind: 'increment' };
type ReadAndResetMessage = { kind: 'readAndReset' };
type CounterMessage = IncrementMessage | ReadAndResetMessage;

class CounterActor extends Actor<CounterMessage> {
  private count = 0;

  override onReceive(message: CounterMessage): void {
    if (message.kind === 'increment') this.onIncrement();
    else this.onReadAndReset();
  }

  private onIncrement(): void {
    this.count++;
  }

  private onReadAndReset(): void {
    const observed = this.count;
    this.count = 0;
    this.sender.forEach((replyTo) => replyTo.tell(observed));
  }
}

/* ------------------------------ ask round-trip --------------------------- */

class EchoActor extends Actor<string> {
  override onReceive(message: string): void {
    this.sender.forEach((replyTo) => replyTo.tell(`echo:${message}`));
  }
}

/* -------------------------------- ping-pong ------------------------------ */

type StartVolleyMessage = { kind: 'startVolley'; exchanges: number };
type PongMessage = { kind: 'pong' };
type VolleyMessage = StartVolleyMessage | PongMessage;

type PingMessage = { kind: 'ping' };

class PongActor extends Actor<PingMessage> {
  override onReceive(): void {
    this.onPing();
  }

  private onPing(): void {
    this.sender.forEach((replyTo) => replyTo.tell({ kind: 'pong' }));
  }
}

class PingActor extends Actor<VolleyMessage> {
  private exchanges = 0;
  private completed = 0;
  private replyTo: ActorRef | null = null;

  /**
   * Constructor argument, so the factory form is the correct spawn shape here
   * — the class form cannot express a partner reference.
   */
  constructor(private readonly partner: ActorRef<PingMessage>) {
    super();
  }

  override onReceive(message: VolleyMessage): void {
    if (message.kind === 'startVolley') this.onStartVolley(message);
    else this.onPong();
  }

  private onStartVolley(message: StartVolleyMessage): void {
    this.exchanges = message.exchanges;
    this.completed = 0;
    this.sender.forEach((replyTo) => { this.replyTo = replyTo; });
    // The sender is an explicit argument in actor-ts — there is no ambient
    // "current actor".  Omitting it leaves the partner with an empty
    // `sender`, so the volley starts and never comes back.
    this.partner.tell({ kind: 'ping' }, this.self);
  }

  private onPong(): void {
    this.completed++;
    if (this.completed >= this.exchanges) {
      this.replyTo?.tell(this.completed);
      return;
    }
    // The sender is an explicit argument in actor-ts — there is no ambient
    // "current actor".  Omitting it leaves the partner with an empty
    // `sender`, so the volley starts and never comes back.
    this.partner.tell({ kind: 'ping' }, this.self);
  }
}

/* ------------------------------ parallel workload ------------------------ */

/**
 * The `parallel-workload` rows run on a **second** system, built lazily in
 * the first such case's `setup()` — after the four single-actor rows have
 * been measured on the first.  Two reasons.  The rows above must be the
 * `workers = 0` figures the placement feature promises to leave untouched,
 * and a mesh in the same process would cost the main thread its gossip and
 * heartbeats while they run.  And it is what an operator does: this system
 * is `ActorSystem.create` with one config number set, the actors are
 * `system.spawn(ParallelWorker, name)`, the refs are ordinary refs — the
 * placement is the extension's, exactly as documented, not the benchmark's.
 *
 * Every worker actor matches `/user/parallel-*`; nothing else is offloaded.
 * The note names the count `auto` resolved to on this machine, because the
 * row means nothing without it.
 */
class ParallelSystem {
  private system: ActorSystem | null = null;
  readonly workers: ActorRef<WorkMessage>[] = [];
  resolvedWorkers = 0;

  constructor(private readonly actorCount: number) {}

  /** Built once, by whichever case runs first; both rows share the actors. */
  async setup(): Promise<void> {
    if (this.system !== null) return;
    const parallelism = ParallelismOptions.create()
      .withWorkers('auto')
      .withModule(new URL('./actor-ts-parallel-actors.ts', import.meta.url))
      .withOffload(['/user/parallel-*']);
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off)
      .withConfig({ 'actor-ts': { cluster: { 'gossip-interval': '40ms' }, 'worker-cluster': { 'ready-timeout': '60s' } } })
      .withParallelism(parallelism);
    const system = ActorSystem.create('comparison-actor-ts-parallel', systemOptions);
    this.system = system;
    for (let i = 0; i < this.actorCount; i++) this.workers.push(system.spawn(ParallelWorker, `parallel-${i}`));
    const extension = system.extension(ParallelismExtensionId);
    await extension.whenReady();
    this.resolvedWorkers = extension.workerMesh?.size ?? 0;
    // One round trip per actor so the spawns are acknowledged and every
    // worker has imported the module before the first warmup call.
    await Promise.all(this.workers.map((ref) => ref.ask<number>({ kind: 'work', seed: 1, rounds: 1 }, REPLY_TIMEOUT_MS)));
  }

  async shutdown(): Promise<void> {
    if (this.system === null) return;
    const system = this.system;
    this.system = null;
    await system.terminate();
  }
}

class ParallelWorkload {
  private messageIndex = 0;
  private total = 0;

  constructor(readonly workload: WorkloadCase, private readonly parallel: ParallelSystem) {}

  get notes(): string {
    return `Sixty-four actors placed on ${this.parallel.resolvedWorkers} worker thread(s) by `
      + '`actor-ts.parallelism.workers = auto` (available parallelism minus the main thread); '
      + 'every message crosses the thread boundary once each way. No sharding (#529).';
  }

  setup(): Promise<void> { return this.parallel.setup(); }

  /** One message to every actor; returns how many replies carried the right result. */
  async run(): Promise<number> {
    const rounds = this.workload.workIterationsPerMessage ?? 0;
    const message = this.messageIndex++;
    const replies = await Promise.all(this.parallel.workers.map((ref, actor) =>
      ref.ask<number>({ kind: 'work', seed: workSeed(actor, message), rounds }, REPLY_TIMEOUT_MS)));
    let correct = 0;
    for (let actor = 0; actor < replies.length; actor++) {
      const reply = replies[actor]!;
      if (reply === workRounds(workSeed(actor, message), rounds)) correct++;
      this.total = (this.total + reply) >>> 0;
    }
    return correct;
  }

  checksum(): number { return this.total; }
}

/* ---------------------------------- arm ---------------------------------- */

async function main(): Promise<void> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('comparison-actor-ts', systemOptions);

  const counterRef = system.spawnAnonymous(CounterActor);
  const echoRef = system.spawnAnonymous(EchoActor);
  const pongRef = system.spawnAnonymous(PongActor);
  const pingRef = system.spawnAnonymous(() => new PingActor(pongRef));

  const spawnWorkload = workloadCase('spawn', 'batch=100');
  const tellSmall = workloadCase('tell-throughput', 'batch=1k');
  const tellLarge = workloadCase('tell-throughput', 'batch=10k');
  const askWorkload = workloadCase('ask-round-trip', 'sequential');
  const pingPongWorkload = workloadCase('ping-pong', 'exchanges=10k');
  const parallelSystem = new ParallelSystem(workloadCase('parallel-workload', 'load=light').actorCount ?? 0);
  const parallelLight = new ParallelWorkload(workloadCase('parallel-workload', 'load=light'), parallelSystem);
  const parallelHeavy = new ParallelWorkload(workloadCase('parallel-workload', 'load=heavy'), parallelSystem);

  const spawnBatch = async (batch: number): Promise<number> => {
    let onAllStarted!: () => void;
    let onAllStopped!: () => void;
    const allStarted = new Promise<void>((resolve) => { onAllStarted = resolve; });
    const allStopped = new Promise<void>((resolve) => { onAllStopped = resolve; });
    const latch: LifecycleLatch = {
      startedCount: 0, stoppedCount: 0, expected: batch, onAllStarted, onAllStopped,
    };
    lifecycleLatch = latch;

    const refs: ActorRef<unknown>[] = [];
    for (let i = 0; i < batch; i++) refs.push(system.spawnAnonymous(SpawnProbeActor));
    await awaitWithin(allStarted, LIFECYCLE_TIMEOUT_MS, `${batch} actors to start`);

    for (const ref of refs) ref.stop();
    await awaitWithin(allStopped, LIFECYCLE_TIMEOUT_MS, `${batch} actors to stop`);

    lifecycleLatch = null;
    return Math.min(latch.startedCount, latch.stoppedCount);
  };

  const tellBatch = async (batch: number): Promise<number> => {
    for (let i = 0; i < batch; i++) counterRef.tell({ kind: 'increment' });
    return await counterRef.ask<number>({ kind: 'readAndReset' }, REPLY_TIMEOUT_MS);
  };

  const cases: ArmCase[] = [
    {
      workload: spawnWorkload,
      notes: 'One operation is the full lifecycle: spawn, confirmed preStart, stop, confirmed postStop.',
      run: () => spawnBatch(spawnWorkload.opsPerIteration),
    },
    { workload: tellSmall, run: () => tellBatch(tellSmall.opsPerIteration) },
    { workload: tellLarge, run: () => tellBatch(tellLarge.opsPerIteration) },
    {
      workload: askWorkload,
      run: async () => {
        const reply = await echoRef.ask<string>('hi', REPLY_TIMEOUT_MS);
        return reply === 'echo:hi' ? 1 : 0;
      },
    },
    {
      workload: pingPongWorkload,
      run: () => pingRef.ask<number>(
        { kind: 'startVolley', exchanges: pingPongWorkload.opsPerIteration },
        REPLY_TIMEOUT_MS,
      ),
    },
    ...[parallelLight, parallelHeavy].map((parallel): ArmCase => ({
      workload: parallel.workload,
      get notes(): string { return parallel.notes; },
      setup: () => parallel.setup(),
      run: () => parallel.run(),
      checksum: () => parallel.checksum(),
    })),
  ];

  await runArm({
    framework: {
      name: 'actor-ts',
      version: actorTsVersion(),
      language: 'TypeScript',
      license: 'MIT',
    },
    cases,
    shutdown: async () => {
      await parallelSystem.shutdown();
      await system.terminate();
    },
  });
}

void main();
