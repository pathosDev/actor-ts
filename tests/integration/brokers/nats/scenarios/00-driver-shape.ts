/**
 * The nats.js surface the four adapters destructure, checked against the real
 * packages.
 *
 * Every `*Like` interface in `NatsActor`, `JetStreamActor`,
 * `JetStreamKeyValueActor` and `JetStreamObjectStoreActor` is hand-written,
 * because the peers are declared only in this manifest and importing them from
 * `src/` would emit an unresolvable specifier into the published `.d.ts` (#676).
 * A hand-written stub is satisfied by any fake that matches it, so the fakes in
 * `tests/unit/` prove the adapters against the stubs and nothing proves the
 * stubs against the driver.
 *
 * That gap is not hypothetical here. nats.js v3 moved `jetstream()` and
 * `jetstreamManager()` off the connection and into free functions, and moved
 * the KV and object-store views into their own packages; every unit test stayed
 * green through all of it, because they were asserting against the stub.
 * `tests/unit/ci/OptionalPeerModuleShapes.test.ts` closes the same gap for the
 * peers the root install materialises — NATS is not one of them, so this
 * scenario is where it gets closed instead.
 *
 * Deliberately shape-only: it imports the modules and asserts what the adapters
 * reach for exists. The behaviour is the other scenarios' job.
 */
import type { BrokerScenario } from '../../lib/Scenario.js';
import type { NatsContext } from '../Runner.js';

function expectFunction(owner: string, holder: Record<string, unknown>, name: string): void {
  if (typeof holder[name] !== 'function') {
    throw new Error(`${owner}.${name} is ${typeof holder[name]}, expected function`);
  }
}

export const scenario: BrokerScenario<NatsContext> = {
  name: 'driver shape — the real modules carry what the stubs declare',
  async run(context) {
    const transport = await import('@nats-io/transport-node') as unknown as Record<string, unknown>;
    const jetStream = await import('@nats-io/jetstream') as unknown as Record<string, unknown>;
    const keyValue = await import('@nats-io/kv') as unknown as Record<string, unknown>;
    const objectStore = await import('@nats-io/obj') as unknown as Record<string, unknown>;

    // NatsModuleLike / the two JetStream free functions.
    expectFunction('@nats-io/transport-node', transport, 'connect');
    expectFunction('@nats-io/jetstream', jetStream, 'jetstream');
    expectFunction('@nats-io/jetstream', jetStream, 'jetstreamManager');
    expectFunction('@nats-io/kv', keyValue, 'Kvm');
    expectFunction('@nats-io/obj', objectStore, 'Objm');

    // A live connection, so the instance surfaces are checked rather than the
    // module's alone — `nc.jetstream()` existing was the v2 assumption that
    // silently stopped holding.
    const connect = transport['connect'] as (o: unknown) => Promise<Record<string, unknown>>;
    const connection = await connect({ servers: [...context.servers], name: 'shape-probe' });
    try {
      expectFunction('NatsConnection', connection, 'drain');
      expectFunction('NatsConnection', connection, 'closed');
      expectFunction('NatsConnection', connection, 'publish');
      expectFunction('NatsConnection', connection, 'subscribe');
      if ('jetstream' in connection) {
        throw new Error(
          'NatsConnection.jetstream() is back. It was removed in v3, and the adapters now '
          + 'call the free function; if the connection carries it again the two shapes have '
          + 'diverged and JetStreamActor should be reconsidered rather than left as is.',
        );
      }

      const client = (jetStream['jetstream'] as (c: unknown) => Record<string, unknown>)(connection);
      expectFunction('JetStreamClient', client, 'publish');
      const consumers = client['consumers'] as Record<string, unknown>;
      if (typeof consumers !== 'object' || consumers === null) {
        throw new Error('JetStreamClient.consumers is not an object');
      }
      expectFunction('JetStreamClient.consumers', consumers, 'get');
      expectFunction('JetStreamClient.consumers', consumers, 'getPushConsumer');

      const manager = await (jetStream['jetstreamManager'] as (c: unknown) => Promise<Record<string, unknown>>)(connection);
      for (const [group, methods] of [['streams', ['add', 'update']], ['consumers', ['add', 'update']]] as const) {
        const api = manager[group] as Record<string, unknown>;
        for (const method of methods) expectFunction(`JetStreamManager.${group}`, api, method);
      }

      // Kvm / Objm are constructors taking the JetStream client.
      const kvm = new (keyValue['Kvm'] as new (c: unknown) => Record<string, unknown>)(client);
      expectFunction('Kvm', kvm, 'create');
      expectFunction('Kvm', kvm, 'open');
      const objm = new (objectStore['Objm'] as new (c: unknown) => Record<string, unknown>)(client);
      expectFunction('Objm', objm, 'create');
      expectFunction('Objm', objm, 'open');
    } finally {
      await (connection['drain'] as () => Promise<void>)();
    }
  },
};
