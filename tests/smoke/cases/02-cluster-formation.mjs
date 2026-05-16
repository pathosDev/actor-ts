/**
 * Smoke case: cluster formation.  Two in-memory nodes see each other
 * as Up within the deadline.  No real TCP — InMemoryTransport.
 */
export const name = 'cluster formation';
export const description = '2 nodes converge to Up via InMemoryTransport';

export async function run({ actorTs }) {
  const {
    ActorSystem, Cluster, InMemoryTransport, LogLevel, NoopLogger, NodeAddress,
  } = actorTs;

  async function buildNode(sysName, port, seeds) {
    const sys = ActorSystem.create(sysName, { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const cluster = await Cluster.join(sys, {
      host: 'h', port, seeds,
      transport: new InMemoryTransport(new NodeAddress(sysName, 'h', port)),
      gossipIntervalMs: 30,
    });
    return { sys, cluster };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const [a, b] = await Promise.all([
    buildNode('smoke-cluster', 55801, []),
    buildNode('smoke-cluster', 55802, ['smoke-cluster@h:55801']),
  ]);
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2) break;
      await sleep(25);
    }
    const upA = a.cluster.upMembers().length;
    const upB = b.cluster.upMembers().length;
    if (upA !== 2 || upB !== 2) throw new Error(`cluster failed to converge (a=${upA}, b=${upB})`);
  } finally {
    await a.cluster.leave(); await a.sys.terminate();
    await b.cluster.leave(); await b.sys.terminate();
  }
}
