/**
 * The nact arm of the framework comparison (#27).
 *
 * nact is the most-starred dedicated actor library for Node, and the closest
 * neighbour actor-ts has: same model, same runtime, functional rather than
 * class-based API.  It is also effectively unmaintained, which is worth
 * knowing when reading its numbers — they are a snapshot of 7.6.2, not of a
 * moving target.
 *
 * Two API differences shape this file, and neither is a disadvantage being
 * papered over:
 *
 *  - **There is no ambient sender.**  `ActorContext` carries `self`, `parent`,
 *    `path`, `name`, `children` and `log` — no `sender`.  A reply address is
 *    therefore part of the message, which is exactly what `query()` does when
 *    it hands the factory a one-shot ref.  So the message shapes here carry a
 *    `sender` field where the actor-ts arm relies on `this.sender`.
 *  - **Actors start synchronously.**  Verified rather than assumed:
 *    `initialStateFunc` has fired for all 100 actors the instant the spawn
 *    loop returns, while `afterStop` arrives on a later turn.  So the spawn
 *    scenario counts starts synchronously and awaits confirmed stops — the
 *    same contract the actor-ts arm implements, reached differently.  That
 *    actor-ts defers construction and nact does not is a real difference, and
 *    it belongs in the measured number rather than in a footnote excusing it.
 *
 * The volleying actor mutates and returns its state object rather than
 * spreading a new one per exchange.  nact permits both; the mutating form is
 * the charitable reading, and this arm should not pay 10 000 allocations per
 * iteration for a style choice imposed from outside.
 *
 *   bun run benchmarks/comparison/js/nact.ts
 */
import { dispatch, query, spawn, spawnStateless, start, stop, type Ref } from 'nact';
import { createRequire } from 'node:module';
import { runArm, type ArmCase } from './arm.js';
import { workloadCase } from './workload.js';

const REPLY_TIMEOUT_MS = 60_000;
const LIFECYCLE_TIMEOUT_MS = 60_000;

/* ------------------------------ message shapes --------------------------- */

type IncrementMessage = { kind: 'increment' };
type ReadAndResetMessage = { kind: 'readAndReset'; sender: Ref<number> };
type CounterMessage = IncrementMessage | ReadAndResetMessage;

type EchoMessage = { value: string; sender: Ref<string> };

type PingMessage = { sender: Ref<PongMessage> };
type PongMessage = { kind: 'pong' };
type StartVolleyMessage = { kind: 'startVolley'; exchanges: number; sender: Ref<number> };
type VolleyMessage = StartVolleyMessage | PongMessage;

type VolleyState = {
  exchanges: number;
  completed: number;
  replyTo: Ref<number> | null;
};

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

function installedVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('nact/package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const system = start();

  const counterRef = spawn(
    system,
    (state: number, message: CounterMessage): number => {
      if (message.kind === 'increment') return state + 1;
      dispatch(message.sender, state);
      return 0;
    },
    'counter',
    { initialState: 0 },
  );

  const echoRef = spawnStateless(system, (message: EchoMessage): void => {
    dispatch(message.sender, `echo:${message.value}`);
  });

  const pongRef = spawnStateless(system, (message: PingMessage): void => {
    dispatch(message.sender, { kind: 'pong' });
  });

  const pingRef: Ref<VolleyMessage> = spawn(
    system,
    (state: VolleyState, message: VolleyMessage, context: { self: Ref<PongMessage> }): VolleyState => {
      if (message.kind === 'startVolley') {
        state.exchanges = message.exchanges;
        state.completed = 0;
        state.replyTo = message.sender;
        dispatch(pongRef, { sender: context.self });
        return state;
      }
      state.completed++;
      if (state.completed >= state.exchanges) {
        if (state.replyTo !== null) dispatch(state.replyTo, state.completed);
        return state;
      }
      dispatch(pongRef, { sender: context.self });
      return state;
    },
    'ping',
    { initialState: { exchanges: 0, completed: 0, replyTo: null } as VolleyState },
  );

  const spawnWorkload = workloadCase('spawn', 'batch=100');
  const tellSmall = workloadCase('tell-throughput', 'batch=1k');
  const tellLarge = workloadCase('tell-throughput', 'batch=10k');
  const askWorkload = workloadCase('ask-round-trip', 'sequential');
  const pingPongWorkload = workloadCase('ping-pong', 'exchanges=10k');

  const spawnBatch = async (batch: number): Promise<number> => {
    let startedCount = 0;
    let stoppedCount = 0;
    let onAllStopped!: () => void;
    const allStopped = new Promise<void>((resolve) => { onAllStopped = resolve; });

    const refs: Ref<unknown>[] = [];
    for (let i = 0; i < batch; i++) {
      refs.push(spawn(
        system,
        (state: number): number => state,
        undefined,
        {
          initialStateFunc: (): number => { startedCount++; return 0; },
          afterStop: (): void => { if (++stoppedCount === batch) onAllStopped(); },
        },
      ));
    }

    for (const ref of refs) stop(ref);
    await awaitWithin(allStopped, LIFECYCLE_TIMEOUT_MS, `${batch} nact actors to stop`);

    return Math.min(startedCount, stoppedCount);
  };

  const tellBatch = async (batch: number): Promise<number> => {
    for (let i = 0; i < batch; i++) dispatch(counterRef, { kind: 'increment' });
    return await query<CounterMessage, (sender: Ref<number>) => ReadAndResetMessage>(
      counterRef,
      (sender) => ({ kind: 'readAndReset', sender }),
      REPLY_TIMEOUT_MS,
    );
  };

  const cases: ArmCase[] = [
    {
      workload: spawnWorkload,
      notes: 'nact creates actors synchronously — `initialStateFunc` has run for the whole '
        + 'batch when the spawn loop returns — so only the stops are awaited.',
      run: () => spawnBatch(spawnWorkload.opsPerIteration),
    },
    { workload: tellSmall, run: () => tellBatch(tellSmall.opsPerIteration) },
    { workload: tellLarge, run: () => tellBatch(tellLarge.opsPerIteration) },
    {
      workload: askWorkload,
      run: async () => {
        const reply = await query<EchoMessage, (sender: Ref<string>) => EchoMessage>(
          echoRef,
          (sender) => ({ value: 'hi', sender }),
          REPLY_TIMEOUT_MS,
        );
        return reply === 'echo:hi' ? 1 : 0;
      },
    },
    {
      workload: pingPongWorkload,
      run: () => query<VolleyMessage, (sender: Ref<number>) => StartVolleyMessage>(
        pingRef,
        (sender) => ({ kind: 'startVolley', exchanges: pingPongWorkload.opsPerIteration, sender }),
        REPLY_TIMEOUT_MS,
      ),
    },
  ];

  await runArm({
    framework: {
      name: 'nact',
      version: installedVersion(),
      language: 'JavaScript',
      license: 'Apache-2.0',
    },
    cases,
    shutdown: () => { stop(system); },
  });
}

void main();
