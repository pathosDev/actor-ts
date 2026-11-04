import { describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { bootstrapCluster } from '../../../src/cluster/ClusterBootstrap.js';
import { ClusterBootstrapOptions } from '../../../src/cluster/ClusterBootstrapOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { ConfigError } from '../../../src/config/Config.js';
import type { ConfigObject } from '../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { PersistenceExtensionId } from '../../../src/persistence/PersistenceExtension.js';
import { runWorkerMeshNode, type WorkerMeshInitData } from '../../../src/worker/WorkerMeshBootstrap.js';
import type { WorkerNodeContext } from '../../../src/worker/WorkerNode.js';

/**
 * #1729 — the refusal of a key under `actor-ts.persistence` that no reader
 * takes, on each route that builds a system from a configuration file:
 * `ActorSystem.create` itself (`PersistenceSelectorStartup.test.ts`),
 * `Cluster.bootstrap`, and a WorkerMesh worker, which inherits its main
 * thread's file.
 */

/** A selector misspelt in the file every route here is handed. */
const MISSPELT: ConfigObject = {
  'actor-ts': { persistence: { journal: { plugn: 'actor-ts.persistence.journal.sqlite' } } },
};
const KEY = 'actor-ts.persistence.journal.plugn';
const REFUSAL = `Config at "${KEY}" is not a key the journal block takes`;

/** The error `promise` rejects with; fails the case when it resolves instead. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject, and it resolved');
}

describe('the refusal on every route that builds a system from the file (#1729)', () => {
  test('Cluster.bootstrap: the system it creates fails its startup, naming the key', async () => {
    const name = 'unknown-key-bootstrap';
    // No port is bound: the in-memory transport carries the join.
    const transport = new InMemoryTransport(new NodeAddress(name, '127.0.0.1', 2552));
    const bootstrapOptions = ClusterBootstrapOptions.create(name)
      .withHost('127.0.0.1')
      .withPort(2552)
      .withSeeds([])
      .withTransport(transport)
      .withReceptionist(false)
      .withShutdownOnSignals(false)
      .withLogger(new NoopLogger())
      .withConfig(MISSPELT)
      .withPersistence({ plugins: [] });
    // The bootstrap does not wait for the system's startup — for this failure
    // as for every other the persistence-start phase reports — so the refusal
    // is the system's to report, through the readiness it hands back.
    const { system, shutdown } = await bootstrapCluster(bootstrapOptions);
    try {
      const error = await rejectionOf(system.whenReady());

      expect(error.message).toContain('"persistence-warm-up"');
      expect(error.cause).toBeInstanceOf(ConfigError);
      expect((error.cause as Error).message).toStartWith(REFUSAL);
    } finally {
      await shutdown();
    }
  });

  test('a WorkerMesh worker boots on its main thread\'s file, and refuses the key where it first resolves a store', async () => {
    // The main thread reads the file and refuses it at its own startup; the
    // worker inherits the file without the plug-ins and opens nothing at its
    // startup (#1473), so the refusal comes where it first asks for a store.
    const main = ActorSystem.create(
      'unknown-key-mesh-main',
      ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off).withConfig(MISSPELT),
    );
    const address = new NodeAddress('unknown-key-mesh-worker', '127.0.0.1', 2552);
    const init: WorkerMeshInitData = {
      kind: 'worker-mesh-init',
      config: MISSPELT,
      secretPaths: [],
      seeds: [],
      roles: [],
      modules: [],
    };
    const context = {
      self: address,
      systemName: 'unknown-key-mesh-worker',
      transport: new InMemoryTransport(address),
      initData: init,
      ready: () => {},
    } as unknown as WorkerNodeContext<WorkerMeshInitData>;
    try {
      const mainFailure = await rejectionOf(main.whenReady());
      expect((mainFailure.cause as Error).message).toStartWith(REFUSAL);

      const { system: worker } = await runWorkerMeshNode(context, async () => ({}));
      try {
        await worker.whenReady();

        expect(worker.extensions.has(PersistenceExtensionId)).toBe(false);
        expect(() => worker.extension(PersistenceExtensionId).journal).toThrow(REFUSAL);
      } finally {
        await worker.terminate();
      }
    } finally {
      await main.terminate();
    }
  }, 20_000);
});
