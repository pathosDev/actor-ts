/**
 * Worker-side bootstrap for tcp-message-cost.ts — one real OS thread hosting
 * its own `ActorSystem` and `Cluster`, reachable only over a real
 * `TcpTransport` bound to a loopback port the OS hands out.
 *
 * Deliberately not built on `WorkerNode.join()`: that hands out a
 * `MessageChannelTransport`, and the socket is the whole point here.  So no
 * `withTransport` — `Cluster.join` builds the `TcpTransport` itself — and the
 * parent is reached through `getWorkerScope()`, the runtime seam behind
 * `WorkerNode`, rather than `self.postMessage`; Node's `worker_threads` has no
 * `self` (#1569).
 *
 * The port is probed and released rather than bound as `port: 0`: the main
 * thread seeds on *this* address, and `TcpTransport` binds `bindPort ??
 * self.port`, so a zero here would be the port peers dial.  Same TOCTOU window
 * smoke case 27 accepts.  The system name travels with the port in `ready`
 * instead of being imported from here — importing this module *runs* it, and
 * the main thread must not start a second far node.  What the worker
 * announces is exactly a seed address, which is what the main thread does
 * with it.
 *
 * No seeds: the worker self-elects as the first member and the main thread
 * joins *it*, so no side ever dials a port the other has not bound yet.
 * `main()` is a named async function and not a top-level `await`, for the
 * reason `WorkerNode`'s JSDoc gives: under Bun a top-level await in a worker
 * suspends the module loader in a way that keeps the parent's first frame
 * from ever dispatching.
 *
 * Ignored by the benchmark discovery harness — filename starts with "_".
 */
import { createServer, type AddressInfo } from 'node:net';
import { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } from '../../src/index.js';
import { Cluster, ClusterOptions } from '../../src/cluster/index.js';
import { getWorkerScope } from '../../src/runtime/worker/index.js';
import { Counter, COUNTER_NAME } from '../worker/_mesh-counter.js';

/** The far node is up and bound: its system name and port together are the seed the main thread joins. */
export type PeerReadyMessage = { readonly kind: 'ready'; readonly systemName: string; readonly port: number };
/** Cluster left and system terminated; the thread can be terminated without losing a frame. */
export type PeerStoppedMessage = { readonly kind: 'stopped' };
export type PeerMessage = PeerReadyMessage | PeerStoppedMessage;

/** The one thing the main thread ever asks of the far node. */
export type PeerStopMessage = { readonly kind: 'stop' };
export type ParentMessage = PeerStopMessage;

const SYSTEM_NAME = 'bench-tcp';
const LOOPBACK = '127.0.0.1';

/** One free loopback port, released before the cluster binds it. */
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

async function main(): Promise<void> {
  const scope = await getWorkerScope();
  const port = await freeLoopbackPort();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(SYSTEM_NAME, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(LOOPBACK)
    .withPort(port)
    .withSeeds([])
    .withFailureDetector({ heartbeatIntervalMs: 100, unreachableAfterMs: 400, downAfterMs: 800 })
    .withGossipIntervalMs(80);
  const cluster = await Cluster.join(system, clusterOptions);
  system.spawn(Counter, COUNTER_NAME);

  const onStop = async (): Promise<void> => {
    await cluster.leave();
    await system.terminate();
    const stopped: PeerStoppedMessage = { kind: 'stopped' };
    scope.post(stopped);
  };
  scope.onMessage((data) => {
    if ((data as ParentMessage).kind === 'stop') void onStop();
  });

  const ready: PeerReadyMessage = { kind: 'ready', systemName: SYSTEM_NAME, port };
  scope.post(ready);
}

void main();
