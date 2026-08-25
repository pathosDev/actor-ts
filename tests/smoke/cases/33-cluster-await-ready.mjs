/**
 * Smoke case: cluster readiness wait (#1355, #943).  A single-node bootstrap
 * resolves ready, and a bootstrap whose seeds never answer rejects with
 * ClusterReadyTimeoutError after tearing its system down on its own.
 *
 * The rejection path releasing every handle is the point of running this on
 * all three runtimes: a leaked socket or timer keeps Deno's event loop alive
 * and the smoke run then hangs after its last green line (#1196).  This case
 * deliberately cleans nothing up after the failed bootstrap — there must be
 * nothing left to clean.
 */
export const name = 'cluster readiness wait';
export const description = 'bootstrap awaitReady resolves ready; dead seeds reject + tear down';

export async function run({ actorTs, loadEntry }) {
  const { LogLevel, NoopLogger } = actorTs;
  const {
    Cluster,
    ClusterBootstrapOptions,
    ClusterReadyTimeoutError,
    InMemoryTransport,
    NodeAddress,
  } = await loadEntry('cluster');

  // 1) Single node: the default awaitReady resolves only once ready.
  const soloOptions = ClusterBootstrapOptions.create('smoke-ready')
    .withHost('h')
    .withPort(55821)
    .withTransport(new InMemoryTransport(new NodeAddress('smoke-ready', 'h', 55821)))
    .withReceptionist(false)
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withShutdownOnSignals(false);
  const solo = await Cluster.bootstrap(soloOptions);
  try {
    if (!solo.cluster.isReady()) throw new Error('bootstrap resolved but isReady() is false');
    await solo.cluster.awaitReady({ timeoutMs: 1_000 });
    if (solo.formedNewCluster !== true) throw new Error('single node did not report formedNewCluster');
  } finally {
    await solo.shutdown();
  }

  // 2) Dead seeds: must reject with ClusterReadyTimeoutError, system already
  //    torn down by the bootstrap itself.
  const deadOptions = ClusterBootstrapOptions.create('smoke-ready-dead')
    .withHost('h')
    .withPort(55822)
    .withTransport(new InMemoryTransport(new NodeAddress('smoke-ready-dead', 'h', 55822)))
    .withSeeds(['smoke-ready-dead@h:55899'])
    .withReceptionist(false)
    .withAwaitReady(250)
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withShutdownOnSignals(false);
  let caught = null;
  try {
    await Cluster.bootstrap(deadOptions);
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof ClusterReadyTimeoutError)) {
    throw new Error(`expected ClusterReadyTimeoutError, got ${caught?.constructor?.name ?? 'no error'}`);
  }
  if (caught.selfStatus !== 'joining') {
    throw new Error(`expected selfStatus 'joining', got '${caught.selfStatus}'`);
  }
}
