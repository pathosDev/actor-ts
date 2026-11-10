/**
 * Smoke case: a node its own `weaklyUpAfterMs` timer moved to weakly-up
 * before its seed had started still reaches up once the seed answers
 * (#1493, #935).
 *
 * The node keeps dialling its seeds while weakly-up (#1493), so the seed
 * learns of it once it listens and, already up, promotes it at once — from
 * the `joining@E` record the join carried, to `up@E+1`.  The node's timer
 * has by then written `weakly-up@E+1`: the same version.  The merge used to
 * drop a record that was not strictly newer, so the node stayed weakly-up in
 * its own view for good while the seed counted it up (#935).
 *
 * Why a smoke case and not only a unit test: which record the seed sees
 * first depends on the runtime's socket.  On Deno a first dial to a port
 * nobody listens on yet does not fail fast; the buffered join reaches the
 * seed once it binds, so the seed promotes the `joining@E` record and ties
 * with the timer.  With the seed 150-170 ms late that left the node weakly-up
 * on every measured Deno run before the tie was resolved, while Bun and Node,
 * where that dial fails at once, reached up in the same scenario.  The
 * in-memory unit test pins the tie itself; this pins it on the runtime that
 * hit it.
 *
 * Ports come from the OS (the node has to name its seed before the seed
 * binds, so `port: 0` is not available), and every node is torn down on
 * every path: a listener Deno still holds keeps the whole run from exiting.
 */
export const name = 'weakly-up late seed';
export const description = 'a node weakly-up before its seed starts is promoted to up once the seed answers';

/** The seed delays measured on Deno: both left the node weakly-up before #935's tie was resolved. */
const SEED_DELAYS_MS = [150, 170];
const WEAKLY_UP_TIMEOUT_MS = 3_000;
const REACH_UP_TIMEOUT_MS = 8_000;

export async function run({ actorTs, loadEntry }) {
  const { ActorSystem, ActorSystemOptions, LogLevel, NoopLogger } = actorTs;
  const { Cluster, ClusterOptions } = await loadEntry('cluster');
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

  async function until(condition, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (condition()) return true;
      await sleep(10);
    }
    return condition();
  }

  const systemName = 'smoke-weakly-up-late-seed';

  /** No `withTransport`, so the cluster builds a real `TcpTransport`. */
  async function buildNode(port, configure) {
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create(systemName, systemOptions);
    const clusterOptions = configure(ClusterOptions.create()
      .withHost('127.0.0.1')
      .withPort(port)
      .withGossipIntervalMs(60));
    try {
      const cluster = await Cluster.join(system, clusterOptions);
      return { system, cluster };
    } catch (e) {
      await system.terminate();
      throw e;
    }
  }

  async function stop(node) {
    if (node === undefined) return;
    try { await node.cluster.leave(); } finally { await node.system.terminate(); }
  }

  for (const delayMs of SEED_DELAYS_MS) {
    const portNode = await freePort();
    let portSeed = await freePort();
    while (portSeed === portNode) portSeed = await freePort();
    let joiner;
    let seed;
    try {
      joiner = await buildNode(portNode, (options) => options
        .withSeeds([`${systemName}@127.0.0.1:${portSeed}`])
        .withSeedRetryIntervalMs(50)
        .withWeaklyUpAfterMs(20));
      const promoted = await until(() => joiner.cluster.selfMember()?.status === 'weakly-up', WEAKLY_UP_TIMEOUT_MS);
      if (!promoted) {
        throw new Error(`the node never reached weakly-up (still "${joiner.cluster.selfMember()?.status}")`);
      }

      await sleep(delayMs);
      seed = await buildNode(portSeed, (options) => options);

      const reached = await until(() => joiner.cluster.selfMember()?.status === 'up', REACH_UP_TIMEOUT_MS);
      if (!reached) {
        const self = joiner.cluster.selfMember();
        const seedView = seed.cluster.getMembers().find((member) => member.address.port === portNode);
        throw new Error(
          `with the seed ${delayMs} ms late the node stayed "${self?.status}" at v${self?.version} `
          + `while the seed holds it "${seedView?.status}" at v${seedView?.version}`,
        );
      }
      if (!joiner.cluster.isReady()) throw new Error(`with the seed ${delayMs} ms late the node is up but not ready`);
    } finally {
      try { await stop(joiner); } finally { await stop(seed); }
    }
  }
}
