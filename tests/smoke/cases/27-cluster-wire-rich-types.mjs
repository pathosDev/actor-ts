/**
 * Smoke case: a cross-node `tell` carries the rich types persistence carries (#450).
 *
 * The cluster wire used to be a bare `JSON.stringify`, so a `Map` an actor
 * could persist and recover verbatim arrived at a peer as `{}`, a `Date`
 * arrived as a string, a `Uint8Array` arrived as an index-keyed object and a
 * `bigint` threw out of the sender's own `tell`.  `encodeFrame` now writes the
 * same tagged JSON tree the journal / snapshot / durable-state stores write.
 *
 * This is the only place in the repo where that runs over a **real socket on
 * all three runtimes**.  Every other cluster harness is blind to it:
 * `MultiNodeSpec` delivers by reference, `ParallelMultiNodeSpec`
 * structured-clones, all five cluster benchmarks and case 02 use
 * `InMemoryTransport` — none of them serialise anything.  And the three
 * runtimes reach the socket through three different adapters (`Bun.listen`,
 * `net.createServer`, `Deno.listen`), so a frame that round-trips under Bun
 * proves nothing about the other two.
 *
 * Ports are taken from the OS rather than hard-coded: two nodes have to agree
 * on each other's address up front, so `port: 0` is not available here, and a
 * fixed pair is a collision waiting to happen on a shared runner.
 */
export const name = 'cluster wire rich types';
export const description = 'Map / Set / Date / bytes / bigint survive a cross-node tell over real TCP';

const CONVERGE_TIMEOUT_MS = 10_000;
const DELIVERY_TIMEOUT_MS = 5_000;

export async function run({ actorTs, loadEntry }) {
  const { Actor, ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { Cluster, ClusterOptions, NodeAddress, RemoteActorRef } = await loadEntry('cluster');
  const net = await import('node:net');

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** One free loopback port, released before the caller binds it. */
  const freePort = () => new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });

  let delivered = null;
  class Sink extends Actor {
    onReceive(message) { delivered = message; }
  }

  const systemName = 'smoke-wire-types';

  /** No `withTransport`, so the cluster builds a real `TcpTransport` (#450). */
  async function buildNode(port, seeds) {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create(systemName, systemOptions);
    const clusterOptions = ClusterOptions.create()
      .withHost('127.0.0.1')
      .withPort(port)
      .withSeeds(seeds)
      .withGossipIntervalMs(50);
    const cluster = await Cluster.join(system, clusterOptions);
    return { system, cluster };
  }

  const [portA, portB] = [await freePort(), await freePort()];
  // Built one at a time, and each is torn down on the other's failure: a
  // half-built pair would leave a bound listener behind, and a listener Deno
  // still holds keeps the whole run from exiting.
  const nodeA = await buildNode(portA, []);
  let nodeB;
  try {
    nodeB = await buildNode(portB, [`${systemName}@127.0.0.1:${portA}`]);
  } catch (e) {
    await nodeA.cluster.leave();
    await nodeA.system.terminate();
    throw e;
  }

  try {
    const converged = Date.now() + CONVERGE_TIMEOUT_MS;
    while (Date.now() < converged) {
      if (nodeA.cluster.upMembers().length === 2 && nodeB.cluster.upMembers().length === 2) break;
      await sleep(25);
    }
    const upA = nodeA.cluster.upMembers().length;
    const upB = nodeB.cluster.upMembers().length;
    if (upA !== 2 || upB !== 2) {
      throw new Error(`cluster failed to converge over TCP (a=${upA}, b=${upB})`);
    }

    const sink = nodeB.system.spawn(Sink, 'sink');
    const remote = new RemoteActorRef(
      new NodeAddress(systemName, '127.0.0.1', portB),
      sink.path.toString(),
      nodeA.cluster,
    );

    const when = new Date('2026-08-15T10:20:30.400Z');
    remote.tell({
      kind: 'rich',
      byName: new Map([['a', 1], ['b', 2]]),
      seen: new Set(['x', 'y']),
      when,
      bytes: new Uint8Array([0, 1, 254, 255]),
      balance: 9007199254740993n,
      nan: Number.NaN,
    });

    const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
    while (delivered === null && Date.now() < deadline) await sleep(10);
    if (delivered === null) throw new Error('the cross-node tell never arrived');

    const fail = (what) => { throw new Error(`${what} did not survive the cluster wire`); };
    if (!(delivered.byName instanceof Map) || delivered.byName.get('b') !== 2) fail('Map');
    if (!(delivered.seen instanceof Set) || !delivered.seen.has('y')) fail('Set');
    if (!(delivered.when instanceof Date) || delivered.when.getTime() !== when.getTime()) fail('Date');
    if (!(delivered.bytes instanceof Uint8Array) || delivered.bytes[3] !== 255) fail('Uint8Array');
    if (delivered.balance !== 9007199254740993n) fail('bigint');
    if (!Number.isNaN(delivered.nan)) fail('NaN');
  } finally {
    await nodeA.cluster.leave();
    await nodeB.cluster.leave();
    await nodeA.system.terminate();
    await nodeB.system.terminate();
  }
}
