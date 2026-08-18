/**
 * The XState v5 arm of the framework comparison (#27).
 *
 * XState is the most widely used actor implementation in the JavaScript
 * ecosystem by a wide margin, which is why it is here — but it is a
 * *statechart* library whose actors are the delivery mechanism, not an actor
 * framework with statecharts bolted on.  Two consequences shape this file,
 * and both are labelled on every row they touch rather than smoothed over:
 *
 *  - **There is no ask.**  XState has no request/response primitive: an actor
 *    exposes a snapshot, and the caller observes it.  The `ask-round-trip`
 *    row therefore measures `send` followed by `waitFor` on the resulting
 *    snapshot, which is the idiomatic way to get a value back — but it is an
 *    emulation, and comparing it to a framework's native ask compares two
 *    different things.  The note travels with the number into `RESULTS.md`
 *    and every published table.
 *  - **Event processing is synchronous.**  `send` runs the transition on the
 *    calling stack rather than queueing for a scheduler turn, so the
 *    `tell-throughput` row is not measuring a mailbox.  That is a genuine
 *    architectural difference and belongs in the number; it is also why the
 *    completion check here reads the context directly, which is a stronger
 *    observation than any of the other arms can make.
 *
 *   bun run benchmarks/comparison/js/xstate.ts
 */
import { assign, createActor, createMachine, setup, waitFor, type ActorRefLike } from 'xstate';
import { createRequire } from 'node:module';
import { runArm, type ArmCase } from './arm.js';
import { workloadCase } from './workload.js';

const WAIT_TIMEOUT_MS = 60_000;

const SYNCHRONOUS_NOTE =
  'XState processes events synchronously on the caller\'s stack — this row does not measure a mailbox.';
const EMULATED_ASK_NOTE =
  'XState has no request/response primitive; this is `send` followed by `waitFor` on the snapshot, '
  + 'which is the idiomatic equivalent but not a native ask.';

/* --------------------------------- machines ------------------------------- */

// XState's discriminant is `type`, not the project's `kind`.  That is the
// documented exemption for names mirroring an external API — the library
// parses these objects, so they are its vocabulary and not ours.

type CounterEvent =
  | { type: 'increment' }
  | { type: 'reset' }
  | { type: 'echo'; value: string };

type PongEvent =
  | { type: 'setPartner'; partner: ActorRefLike }
  | { type: 'ping' };

type PingEvent =
  | { type: 'setPartner'; partner: ActorRefLike }
  | { type: 'startVolley'; exchanges: number }
  | { type: 'pong' };

const counterMachine = setup({
  types: {
    context: {} as { count: number; lastEcho: string },
    events: {} as CounterEvent,
  },
}).createMachine({
  id: 'counter',
  context: { count: 0, lastEcho: '' },
  on: {
    increment: { actions: assign({ count: ({ context }) => context.count + 1 }) },
    reset: { actions: assign({ count: 0 }) },
    echo: { actions: assign({ lastEcho: ({ event }) => `echo:${event.value}` }) },
  },
});

const pongMachine = setup({
  types: {
    context: {} as { partner: ActorRefLike | null },
    events: {} as PongEvent,
  },
}).createMachine({
  id: 'pong',
  context: { partner: null },
  on: {
    setPartner: { actions: assign({ partner: ({ event }) => event.partner }) },
    ping: { actions: ({ context }) => { context.partner?.send({ type: 'pong' }); } },
  },
});

const pingMachine = setup({
  types: {
    context: {} as { partner: ActorRefLike | null; exchanges: number; completed: number },
    events: {} as PingEvent,
  },
}).createMachine({
  id: 'ping',
  context: { partner: null, exchanges: 0, completed: 0 },
  on: {
    setPartner: { actions: assign({ partner: ({ event }) => event.partner }) },
    startVolley: {
      actions: [
        assign({ exchanges: ({ event }) => event.exchanges, completed: 0 }),
        ({ context }) => { context.partner?.send({ type: 'ping' }); },
      ],
    },
    pong: {
      actions: [
        assign({ completed: ({ context }) => context.completed + 1 }),
        ({ context }) => {
          if (context.completed < context.exchanges) context.partner?.send({ type: 'ping' });
        },
      ],
    },
  },
});

/** A machine with no behaviour — the spawn scenario's subject. */
const idleMachine = createMachine({ id: 'idle' });

function installedVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('xstate/package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const counter = createActor(counterMachine).start();

  const pong = createActor(pongMachine).start();
  const ping = createActor(pingMachine).start();
  ping.send({ type: 'setPartner', partner: pong });
  pong.send({ type: 'setPartner', partner: ping });

  const spawnWorkload = workloadCase('spawn', 'batch=100');
  const tellSmall = workloadCase('tell-throughput', 'batch=1k');
  const tellLarge = workloadCase('tell-throughput', 'batch=10k');
  const askWorkload = workloadCase('ask-round-trip', 'sequential');
  const pingPongWorkload = workloadCase('ping-pong', 'exchanges=10k');

  /**
   * `.start()` and `.stop()` are synchronous here, so the confirmation is a
   * direct status read rather than a lifecycle signal to await — the same
   * contract as the other arms, reached without waiting.
   */
  const spawnBatch = (batch: number): number => {
    const actors = [];
    for (let i = 0; i < batch; i++) actors.push(createActor(idleMachine).start());
    const active = actors.filter((actor) => actor.getSnapshot().status === 'active').length;
    for (const actor of actors) actor.stop();
    const stopped = actors.filter((actor) => actor.getSnapshot().status === 'stopped').length;
    return Math.min(active, stopped);
  };

  const tellBatch = (batch: number): number => {
    counter.send({ type: 'reset' });
    for (let i = 0; i < batch; i++) counter.send({ type: 'increment' });
    return counter.getSnapshot().context.count;
  };

  let echoToken = 0;

  const cases: ArmCase[] = [
    {
      workload: spawnWorkload,
      notes: 'XState starts and stops actors synchronously; confirmation is a snapshot status read.',
      run: () => spawnBatch(spawnWorkload.opsPerIteration),
    },
    { workload: tellSmall, notes: SYNCHRONOUS_NOTE, run: () => tellBatch(tellSmall.opsPerIteration) },
    { workload: tellLarge, notes: SYNCHRONOUS_NOTE, run: () => tellBatch(tellLarge.opsPerIteration) },
    {
      workload: askWorkload,
      notes: EMULATED_ASK_NOTE,
      run: async () => {
        const value = `hi-${echoToken++}`;
        counter.send({ type: 'echo', value });
        const snapshot = await waitFor(
          counter,
          (state) => state.context.lastEcho === `echo:${value}`,
          { timeout: WAIT_TIMEOUT_MS },
        );
        return snapshot.context.lastEcho === `echo:${value}` ? 1 : 0;
      },
    },
    {
      workload: pingPongWorkload,
      run: async () => {
        const exchanges = pingPongWorkload.opsPerIteration;
        ping.send({ type: 'startVolley', exchanges });
        const snapshot = await waitFor(
          ping,
          (state) => state.context.completed >= exchanges,
          { timeout: WAIT_TIMEOUT_MS },
        );
        return snapshot.context.completed;
      },
    },
  ];

  await runArm({
    framework: {
      name: 'xstate',
      version: installedVersion(),
      language: 'TypeScript',
      license: 'MIT',
    },
    cases,
    shutdown: () => { ping.stop(); pong.stop(); counter.stop(); },
  });
}

void main();
