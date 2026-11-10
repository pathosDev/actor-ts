/**
 * TCP message cost — what an actor message pays to cross a real socket,
 * measured on the actor path: `RemoteActorRef.tell` → `encodeFrame` →
 * loopback TCP → `FrameDecoder` → validate → dispatch.  The first benchmark in
 * the tree that serialises anything — every other cluster suite runs on
 * `InMemoryTransport`, which hands the object to the peer by reference.
 *
 * Two tiers, each running the same `Counter` (`../worker/_mesh-counter.ts`):
 *
 *   local         one `ActorSystem`, one `tell` = one array push.  The
 *                 baseline the other row is a multiple of.
 *   tcp · worker  the counter on a second `Cluster` node hosted by a worker
 *                 thread (`_tcp-peer.ts`), joined over a real `TcpTransport`
 *                 on 127.0.0.1 — no `withTransport`, so `Cluster.join` builds
 *                 the same transport a deployment gets.  The row is the whole
 *                 wire cost: envelope, tagged-JSON frame, the socket, the
 *                 decoder and its guards, and the dispatch on the far side.
 *
 * There is deliberately no "both nodes on this thread" tier, although the
 * mesh benchmark has one and it would be the cheaper thing to run on CI.  It
 * was measured on 2026-09-18 (Bun 1.4.2, Windows 11) and it loses frames:
 * bursts of 500, 1 000 and 1 500 arrive complete, bursts of 2 000 and up all
 * stop at the same point and drop the rest silently — 1 640 frames of this
 * benchmark's 119-byte envelope, 1 509 of a 130-byte one, the same ~195 KB,
 * so the ceiling is a byte budget and it will sit elsewhere on Linux CI.  The
 * far decoder holds no pending bytes, the association stays up, and the count
 * ask sent after the burst is lost with them, so the first symptom is an
 * `AskTimeoutError`.  That is #931: `socket.write()`'s byte count is
 * discarded, and with both nodes on one event loop the receiver cannot drain
 * while the synchronous tell loop fills the loopback buffers, so the kernel's
 * buffers are the whole ceiling.  With the far node on its own thread the same
 * bursts arrive complete.  A one-thread tier belongs here once #931 lands,
 * with "runs at TELL_BATCH 10 000 without throwing" as its acceptance — until
 * then, sizing the batch down to fit under the ceiling would measure the
 * buffer, not the framework: at 1 000 the one-thread variant passes green.
 *
 * Every tell batch is completion-verified: the counter is asked for its count
 * after the batch and the row throws if it disagrees with what was sent
 * (#1027) — from the sending side a frame dropped under back-pressure and a
 * frame that arrived look identical.  The check is live, not decorative: run
 * once with the far node built on the main thread instead of the worker, the
 * run died on the count ask, and asked again once the buffers had drained the
 * tell row threw `sent 10000 increments, the counter saw 1640`; the file
 * exited non-zero both ways.  With the check removed, the same run printed a
 * row and exited 0.
 *
 * Measured 2026-09-18 (Bun 1.4.2, Windows 11, 32 hardware threads), three
 * runs; the tcp rows agree within 8 %, the local tell row drifts by a third
 * between runs — read the ratios and treat the last digit of every figure as
 * fiction:
 *
 * | tier         | tell (per msg) | vs local | ask (round trip) | vs local |
 * | ------------ | -------------- | -------- | ---------------- | -------- |
 * | local        |        ~260 ns |     1.0x |          ~6.1 µs |     1.0x |
 * | tcp · worker |         ~22 µs |     ~85x |          ~245 µs |     ~40x |
 *
 * Set beside the mesh benchmark's worker row — ~21 µs per tell and ~180 µs
 * per ask over a `MessageChannelTransport`, same machine, two days earlier —
 * a tell costs the same over a socket as over a structured clone.  So the
 * twenty-odd microseconds are the protocol (envelope, ref codec, the far
 * side's dispatch), not the wire: the tagged-JSON frame and the loopback
 * socket together are within noise of a clone.  The ask round trip pays some
 * 65 µs more over TCP, which is two frames' worth of encode and decode on top
 * of the two thread hops.  Either way a message that leaves the node pays
 * roughly a hundred local tells; on a LAN the round trip is the network's.
 *
 *   bun run benchmarks/cluster/tcp-message-cost.ts
 */
import { createServer, type AddressInfo } from 'node:net';
import {
  ActorSystem,
  ActorSystemOptions,
  LogLevel,
  NoopLogger,
  type ActorRef,
} from '../../src/index.js';
import { Cluster, ClusterOptions, NodeAddress, RemoteActorRef } from '../../src/cluster/index.js';
import {
  getWorkerBackend,
  type WorkerCloseEvent,
  type WorkerErrorEvent,
  type WorkerLike,
  type WorkerMessageEvent,
} from '../../src/runtime/worker/index.js';
import { runGroup, type BenchmarkResult, type BenchmarkSpec } from '../lib/harness.js';
import { Counter, COUNTER_NAME, type CounterMessage } from '../worker/_mesh-counter.js';
import type { PeerMessage, PeerReadyMessage, PeerStopMessage } from './_tcp-peer.js';

/** Messages per measured tell iteration — the batch the counter is asked to confirm. */
const TELL_BATCH = 10_000;
const TELL_ITERATIONS = 20;
const ASK_ITERATIONS = 2_000;
/** Generous: a reply that crosses a loopback socket is still well under a millisecond. */
const ASK_TIMEOUT_MS = 5_000;
/** How long the tcp tier may take to see both members `up`. */
const MEMBERSHIP_TIMEOUT_MS = 15_000;
/** How long the far node may take to report `ready` at start and `stopped` at the end. */
const PEER_HANDSHAKE_TIMEOUT_MS = 15_000;

const LOOPBACK = '127.0.0.1';
/**
 * Only the local tier names its own system.  The tcp tier takes its name from
 * the far node's `ready` frame — the pair `system@host:port` is a seed address,
 * and learning it that way leaves no second constant to drift (see
 * `_tcp-peer.ts`, which the main thread must not import for it).
 */
const LOCAL_SYSTEM_NAME = 'bench-tcp-local';

/** One tier: a ref to a counter, and how to tear the tier down afterwards. */
type Tier = {
  readonly label: string;
  readonly counter: ActorRef<CounterMessage>;
  readonly stop: () => Promise<void>;
};

function systemOptions(): ActorSystemOptions {
  return ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
}

/** The near node's options — the same detector and gossip cadence `_tcp-peer.ts` runs. */
function clusterOptionsFor(port: number, seeds: string[]): ClusterOptions {
  return ClusterOptions.create()
    .withHost(LOOPBACK)
    .withPort(port)
    .withSeeds(seeds)
    .withFailureDetector({ heartbeatIntervalMs: 100, unreachableAfterMs: 400, downAfterMs: 800 })
    .withGossipIntervalMs(80);
}

/**
 * The full URI form, deliberately: `RemoteActorRef` takes the path the far
 * side's `parsePathSegments` will read, and that reader accepts only
 * `actor-ts://<system>/…`.
 */
function counterPath(systemName: string): string {
  return `actor-ts://${systemName}/user/${COUNTER_NAME}`;
}

/**
 * One free loopback port, released before the cluster binds it.  Not
 * `port: 0`: the far node learns this address from the handshake and dials it
 * back, and `TcpTransport` binds `bindPort ?? self.port`.
 */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, LOOPBACK, () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/* ------------------------------ far node ---------------------------------- */

/**
 * The next frame from the far node — or a rejection when the thread dies or
 * the deadline passes first, so a bootstrap that throws on the far side fails
 * this run instead of leaving it waiting out CI's cap.
 */
function nextPeerMessage(worker: WorkerLike, timeoutMs: number): Promise<PeerMessage> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: () => void): void => {
      if (timer !== undefined) clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('close', onClose);
      outcome();
    };
    const onMessage = (event: WorkerMessageEvent): void => {
      settle(() => resolve(event.data as PeerMessage));
    };
    const onError = (event: WorkerErrorEvent): void => {
      settle(() => reject(new Error(`the far node failed: ${event.message ?? 'unknown error'}`)));
    };
    const onClose = (event: WorkerCloseEvent): void => {
      settle(() => reject(new Error(`the far node exited (code ${event.code ?? '?'}) before answering`)));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('close', onClose);
    timer = setTimeout(() => {
      settle(() => reject(new Error(`the far node did not answer within ${timeoutMs} ms`)));
    }, timeoutMs);
  });
}

async function awaitPeerReady(worker: WorkerLike): Promise<PeerReadyMessage> {
  const message = await nextPeerMessage(worker, PEER_HANDSHAKE_TIMEOUT_MS);
  if (message.kind !== 'ready') throw new Error(`expected 'ready' from the far node, got '${message.kind}'`);
  return message;
}

async function stopPeer(worker: WorkerLike): Promise<void> {
  const stop: PeerStopMessage = { kind: 'stop' };
  worker.postMessage(stop);
  const message = await nextPeerMessage(worker, PEER_HANDSHAKE_TIMEOUT_MS);
  if (message.kind !== 'stopped') throw new Error(`expected 'stopped' from the far node, got '${message.kind}'`);
}

/* ------------------------------- tiers ------------------------------------ */

async function localTier(): Promise<Tier> {
  const system = ActorSystem.create(LOCAL_SYSTEM_NAME, systemOptions());
  const counter = system.spawn(Counter, COUNTER_NAME);
  return {
    label: 'local',
    counter,
    stop: () => system.terminate(),
  };
}

async function tcpWorkerTier(): Promise<Tier> {
  const backend = await getWorkerBackend();
  const worker = backend.spawn(new URL('./_tcp-peer.ts', import.meta.url), { name: 'tcp-peer' });
  let far: PeerReadyMessage;
  try {
    far = await awaitPeerReady(worker);
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  const farAddress = new NodeAddress(far.systemName, LOOPBACK, far.port);

  const system = ActorSystem.create(far.systemName, systemOptions());
  const clusterOptions = clusterOptionsFor(await freeLoopbackPort(), [farAddress.toString()]);
  const cluster = await Cluster.join(system, clusterOptions);
  await cluster.awaitReady({ minimumMembers: 2, timeoutMs: MEMBERSHIP_TIMEOUT_MS });

  const counter = new RemoteActorRef<CounterMessage>(farAddress, counterPath(far.systemName), cluster);
  return {
    label: 'tcp · worker',
    counter,
    stop: async () => {
      await cluster.leave();
      await system.terminate();
      // The far node leaves and terminates on `stop`; the thread goes either way.
      try {
        await stopPeer(worker);
      } finally {
        await worker.terminate();
      }
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
    `\n  TCP message cost — the same Counter actor local, and on a second cluster node\n`
    + `  on a worker thread over a real TcpTransport on loopback.  ${TELL_BATCH.toLocaleString('en-US')} tells\n`
    + `  per batch, every batch confirmed by an ask for the count.\n`,
  );

  const tiers = [await localTier(), await tcpWorkerTier()];
  try {
    const tell = await runGroup('cluster · tcp message cost — tell', tiers.map(tellSpec));
    const ask = await runGroup('cluster · tcp message cost — ask', tiers.map(askSpec));

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
      '\n  tcp · worker is the whole wire: envelope + tagged-JSON frame + loopback socket\n'
      + '  + decoder and its guards + dispatch, with the far node on its own thread.\n',
    );
  } finally {
    for (const tier of tiers.reverse()) await tier.stop();
  }
}

void main();
