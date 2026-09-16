/**
 * Mesh message cost — what an actor message pays to cross a node boundary,
 * measured on the actor path rather than on a bare `postMessage`.
 *
 * Three tiers, each running the same `Counter` (`_mesh-counter.ts`):
 *
 *   local        one `ActorSystem`, one `tell` = one array push.  The
 *                baseline every other row is a multiple of.
 *   in-process   two `ActorSystem`s on the *same* thread, each a real cluster
 *                node over a real `MessageChannelTransport`, routed through a
 *                real `WorkerBroker` — the rig `WorkerMesh.test.ts` uses.  A
 *                `MessageChannel` structured-clones even within one thread,
 *                so this row is the whole protocol cost — envelope, ref
 *                encoding, the broker's relay hop and two clones — with no
 *                thread scheduling in it.
 *   worker       the same, with the far node on a real OS thread spawned
 *                through `WorkerCluster`.  The difference to the row above is
 *                what the thread itself costs.
 *
 * Splitting the boundary this way is what makes the numbers usable: the
 * in-process row runs on CI with no thread at all, and the two together say
 * whether a slow hop is the protocol or the scheduling.  The ratio of `worker`
 * to `local` is the number transparent placement (#1563) has to justify per
 * actor — a chatty I/O-bound actor moved to a worker pays it on every message
 * and gains nothing, which is why the `offload` list exists (#1566).
 *
 * The main thread is not a member of a `WorkerCluster` today (#1562), so the
 * worker tier joins it by hand: a `MessageChannel` port registered with the
 * cluster's broker under a main-thread address, and a `Cluster` on this side
 * of it.  That is the "manual wiring" the worker-mesh docs describe, and
 * exactly the twelve lines `WorkerMesh` folds away.
 *
 * Every tell batch is completion-verified: the counter is asked for its count
 * after the batch and the row throws if it disagrees with what was sent
 * (#1027).  Two groups — tell throughput and ask latency — because they answer
 * different questions and a chatty actor is bounded by the first while a
 * request/response one is bounded by the second.
 *
 * Measured 2026-09-16 (Bun 1.4.2, Windows 11, 32 hardware threads), three
 * runs; the tell rows agree within 10 %, the cross-node ask rows drift up to
 * 20 % between runs — read the ratios and treat the last digit of every
 * figure as fiction:
 *
 * | tier        | tell (per msg) | vs local | ask (round trip) | vs local |
 * | ----------- | -------------- | -------- | ---------------- | -------- |
 * | local       |        ~320 ns |     1.0x |          ~6.3 µs |     1.0x |
 * | in-process  |         ~25 µs |     ~78x |           ~80 µs |     ~13x |
 * | worker      |         ~21 µs |     ~66x |          ~180 µs |     ~29x |
 *
 * Two things worth reading off it.  A worker-thread *tell* is cheaper than the
 * in-thread one, not dearer: on one thread the sender and the far node's
 * mailbox drain compete for the same event loop, on two they do not — so the
 * protocol, not the thread, is the bill, at roughly twenty microseconds a
 * message.  And *ask* goes the other way, because a round trip pays the hop
 * twice and the thread's scheduling latency on top.  Either way an actor moved
 * to a worker starts sixty-odd tells behind for every message it receives,
 * which is the case for an `offload` allow-list rather than an offload-all
 * default.
 *
 *   bun run benchmarks/worker/mesh-message-cost.ts
 */
import {
  ActorSystem,
  ActorSystemOptions,
  LogLevel,
  NoopLogger,
  type ActorRef,
} from '../../src/index.js';
import {
  Cluster,
  ClusterOptions,
  MessageChannelTransport,
  NodeAddress,
  RemoteActorRef,
  type PortLike,
} from '../../src/cluster/index.js';
import { WorkerBroker, WorkerCluster, WorkerClusterOptions } from '../../src/worker/index.js';
import { runGroup, type BenchmarkResult, type BenchmarkSpec } from '../lib/harness.js';
import { Counter, COUNTER_NAME, type CounterMessage } from './_mesh-counter.js';

/** Messages per measured tell iteration — the batch the counter is asked to confirm. */
const TELL_BATCH = 10_000;
const TELL_ITERATIONS = 20;
const ASK_ITERATIONS = 2_000;
/** Generous: a reply that crosses a thread is still well under a millisecond. */
const ASK_TIMEOUT_MS = 5_000;
/** How long the worker tier may take to see both members `up`. */
const MEMBERSHIP_TIMEOUT_MS = 15_000;

const SYSTEM_NAME = 'bench-mesh';
/**
 * `main` sorts before `worker`, so the main thread is the lowest address and
 * therefore the leader — the same choice `WorkerMesh` makes by default
 * (#1562).  Nothing here depends on it; it is stated so the rows are
 * reproducible.
 */
const MAIN_ADDRESS = new NodeAddress(SYSTEM_NAME, 'main', 1);
const WORKER_HOSTNAME = 'worker';
const WORKER_BASE_PORT = 2;
/**
 * The full URI form, deliberately.  `RemoteActorRef` takes the path
 * `parsePathSegments` will read on the far side, and that reader accepts only
 * `actor-ts://<system>/…` — a bare `/user/counter` parses to no segments, the
 * ref silently targets the system root, and every message to it is dropped.
 */
const COUNTER_PATH = `actor-ts://${SYSTEM_NAME}/user/${COUNTER_NAME}`;

/** One tier: a ref to a counter, and how to tear the tier down afterwards. */
type Tier = {
  readonly label: string;
  readonly counter: ActorRef<CounterMessage>;
  stop(): Promise<void>;
};

function systemOptions(): ActorSystemOptions {
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
}

function clusterOptionsFor(address: NodeAddress, transport: MessageChannelTransport, seeds: string[]): ClusterOptions {
  return ClusterOptions.create()
    .withHost(address.host)
    .withPort(address.port)
    .withSeeds(seeds)
    .withTransport(transport)
    .withFailureDetector({ heartbeatIntervalMs: 100, unreachableAfterMs: 400, downAfterMs: 800 })
    .withGossipIntervalMs(80);
}

/* ------------------------------- tiers ------------------------------------ */

async function localTier(): Promise<Tier> {
  const system = ActorSystem.create(SYSTEM_NAME, systemOptions());
  const counter = system.spawn(Counter, COUNTER_NAME);
  return {
    label: 'local',
    counter,
    stop: () => system.terminate(),
  };
}

/**
 * A node on this thread, wired into a broker the way a worker would be —
 * `WorkerMesh.test.ts`'s `startNode`, minus the test scaffolding.
 */
async function inProcessNode(
  broker: WorkerBroker,
  address: NodeAddress,
  seeds: string[],
): Promise<{ system: ActorSystem; cluster: Cluster }> {
  const channel = new MessageChannel();
  broker.register(address, channel.port1 as unknown as PortLike);
  const transport = new MessageChannelTransport(address, channel.port2 as unknown as PortLike);
  const system = ActorSystem.create(SYSTEM_NAME, systemOptions());
  const cluster = await Cluster.join(system, clusterOptionsFor(address, transport, seeds));
  return { system, cluster };
}

async function inProcessTier(): Promise<Tier> {
  const broker = new WorkerBroker();
  const farAddress = new NodeAddress(SYSTEM_NAME, WORKER_HOSTNAME, WORKER_BASE_PORT);
  const far = await inProcessNode(broker, farAddress, []);
  far.system.spawn(Counter, COUNTER_NAME);
  const near = await inProcessNode(broker, MAIN_ADDRESS, [farAddress.toString()]);
  await near.cluster.awaitReady({ minimumMembers: 2, timeoutMs: MEMBERSHIP_TIMEOUT_MS });

  const counter = new RemoteActorRef<CounterMessage>(farAddress, COUNTER_PATH, near.cluster);
  return {
    label: 'in-process',
    counter,
    stop: async () => {
      await near.cluster.leave();
      await near.system.terminate();
      await far.cluster.leave();
      await far.system.terminate();
      broker.close();
    },
  };
}

async function workerTier(): Promise<Tier> {
  const workerClusterOptions = WorkerClusterOptions.create()
    .withBootstrap(new URL('./_mesh-worker.ts', import.meta.url))
    .withWorkers(1)
    .withSystemName(SYSTEM_NAME)
    .withHostname(WORKER_HOSTNAME)
    .withBasePort(WORKER_BASE_PORT)
    .withRestartPolicy('never');
  const workers = await WorkerCluster.spawn(workerClusterOptions);
  const workerAddress = workers.addresses[0]!;

  // The main thread joins the worker's cluster by hand — see the header.
  const channel = new MessageChannel();
  workers.broker.register(MAIN_ADDRESS, channel.port1 as unknown as PortLike);
  const transport = new MessageChannelTransport(MAIN_ADDRESS, channel.port2 as unknown as PortLike);
  const system = ActorSystem.create(SYSTEM_NAME, systemOptions());
  const cluster = await Cluster.join(
    system,
    clusterOptionsFor(MAIN_ADDRESS, transport, [workerAddress.toString()]),
  );
  await cluster.awaitReady({ minimumMembers: 2, timeoutMs: MEMBERSHIP_TIMEOUT_MS });

  const counter = new RemoteActorRef<CounterMessage>(workerAddress, COUNTER_PATH, cluster);
  return {
    label: 'worker',
    counter,
    stop: async () => {
      await cluster.leave();
      await system.terminate();
      await workers.terminate();
    },
  };
}

/* ------------------------------ measuring --------------------------------- */

async function confirmedCount(counter: ActorRef<CounterMessage>): Promise<number> {
  return counter.ask<number>({ kind: 'count' }, ASK_TIMEOUT_MS);
}

function tellSpec(tier: Tier): BenchmarkSpec {
  return {
    name: `tell · ${tier.label}`,
    unit: 'msg',
    iterations: TELL_ITERATIONS,
    opsPerIteration: TELL_BATCH,
    run: async () => {
      for (let i = 0; i < TELL_BATCH; i++) tier.counter.tell({ kind: 'increment' });
      const seen = await confirmedCount(tier.counter);
      if (seen !== TELL_BATCH) {
        throw new Error(`${tier.label}: sent ${TELL_BATCH} increments, the counter saw ${seen}`);
      }
    },
  };
}

function askSpec(tier: Tier): BenchmarkSpec {
  return {
    name: `ask · ${tier.label}`,
    unit: 'ask',
    iterations: ASK_ITERATIONS,
    run: async () => { await confirmedCount(tier.counter); },
  };
}

function ratio(row: BenchmarkResult, baseline: BenchmarkResult): string {
  return `${(row.perOpNs / baseline.perOpNs).toFixed(1)}x`;
}

async function main(): Promise<void> {
  console.log(
    `\n  Mesh message cost — the same Counter actor local, on a second node in this\n`
    + `  thread, and on a real worker thread.  ${TELL_BATCH.toLocaleString('en-US')} tells per batch,\n`
    + `  every batch confirmed by an ask for the count.\n`,
  );

  const tiers = [await localTier(), await inProcessTier(), await workerTier()];
  try {
    const tell = await runGroup('worker · mesh message cost — tell', tiers.map(tellSpec));
    const ask = await runGroup('worker · mesh message cost — ask', tiers.map(askSpec));

    console.log('\n  Cost relative to local (per message / per round trip):\n');
    console.log('    tier          tell        ask');
    for (let i = 0; i < tiers.length; i++) {
      console.log(
        `    ${tiers[i]!.label.padEnd(12)}`
        + `${ratio(tell[i]!, tell[0]!).padStart(8)}`
        + `${ratio(ask[i]!, ask[0]!).padStart(11)}`,
      );
    }
    console.log(
      '\n  in-process is the protocol (envelope + ref codec + broker relay + two clones);\n'
      + '  worker − in-process is what the thread itself adds.\n',
    );
  } finally {
    for (const tier of tiers.reverse()) await tier.stop();
  }
}

void main();
