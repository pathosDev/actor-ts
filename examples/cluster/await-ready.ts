/**
 * Waiting for cluster readiness (#1355).
 *
 * Two nodes bootstrap in one process over the in-memory transport.  Node A
 * founds the cluster; node B names A as its seed and — the point of this
 * example — waits until the cluster has TWO up members before its
 * `Cluster.bootstrap` resolves.  A resolved bootstrap therefore means "safe
 * to serve", never "still joining": on a missed deadline it would reject
 * with `ClusterReadyTimeoutError` and tear the system down instead.
 *
 * `cluster.awaitReady()` / `cluster.isReady()` offer the same wait without
 * the bootstrap — shown on node A at the end.
 */
import { LogLevel } from '../../src/index.js';
import {
  Cluster,
  ClusterBootstrapOptions,
  InMemoryTransport,
  NodeAddress,
} from '../../src/cluster/index.js';

const SYSTEM_NAME = 'await-ready';
const HOST = '127.0.0.1';
const PORT_A = 42551;
const PORT_B = 42552;

const founderOptions = ClusterBootstrapOptions.create(SYSTEM_NAME)
  .withHost(HOST)
  .withPort(PORT_A)
  .withTransport(new InMemoryTransport(new NodeAddress(SYSTEM_NAME, HOST, PORT_A)))
  .withReceptionist(false)
  .withShutdownOnSignals(false)
  .withLogLevel(LogLevel.Warn);
const founder = await Cluster.bootstrap(founderOptions);
console.log(`node A up (formed new cluster: ${founder.formedNewCluster})`);

const joinerOptions = ClusterBootstrapOptions.create(SYSTEM_NAME)
  .withHost(HOST)
  .withPort(PORT_B)
  .withTransport(new InMemoryTransport(new NodeAddress(SYSTEM_NAME, HOST, PORT_B)))
  .withSeeds([`${HOST}:${PORT_A}`])
  .withReceptionist(false)
  .withShutdownOnSignals(false)
  .withLogLevel(LogLevel.Warn)
  // Resolve only once BOTH members are up — sized to the deployment, the
  // way `actor-ts.cluster.bootstrap.minimum-members` would size it in HOCON.
  .withAwaitReady({ minimumMembers: 2, timeoutMs: 8_000 });
const joiner = await Cluster.bootstrap(joinerOptions);
console.log(
  `cluster ready with ${joiner.cluster.upMembers().length} members `
  + `(node B formed new cluster: ${joiner.formedNewCluster})`,
);

// The same wait, standalone: node A's view converges to two members too.
await founder.cluster.awaitReady({ minimumMembers: 2, timeoutMs: 8_000 });
console.log(`node A sees it too: isReady(minimumMembers 2) = ${founder.cluster.isReady({ minimumMembers: 2 })}`);

await joiner.shutdown();
await founder.shutdown();
