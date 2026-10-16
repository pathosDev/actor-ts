/**
 * The endpoint a `NatsActor` publishes carries no credential (#741), found
 * while #1458.
 *
 * `NatsActor.endpointLabel` joins `servers` exactly as they were configured —
 * no scheme added and nothing redacted, which is `BrokerActor`'s contract — so
 * whatever shape a server entry has reaches the lifecycle events through
 * `redactedUrlLabel` and nothing else.  Two shapes nats.js accepts used to come
 * back with the password in them: a scheme-less `user:password@host`, which
 * the label rendered as `user://password@host`, and a joined list without
 * ports, whose second entry the URL parser took for a path.
 *
 * The actor is a real `NatsActor` over a fake transport, so the assertion is
 * on the `BrokerConnected` any subscriber of the system-wide `EventStream`
 * receives — the audience #741 is about — rather than on the helper alone.
 * The entries are ones nats.js 3.4 accepts as servers (a dotless host *with*
 * a port behind userinfo is one it rejects).
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../src/Actor.js';
import type { ActorSystem } from '../../../../src/ActorSystem.js';
import { BrokerConnected } from '../../../../src/io/broker/BrokerEvents.js';
import {
  NatsActor,
  type NatsConnectionLike,
  type NatsModuleLike,
  type NatsSubscriptionLike,
} from '../../../../src/io/broker/NatsActor.js';
import { NatsOptions, NatsOptionsValidator } from '../../../../src/io/broker/NatsOptions.js';
import { createTestActorSystem } from '../../../util/TestActorSystem.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

class IdleNatsConnection implements NatsConnectionLike {
  publish(): void {}
  subscribe(): NatsSubscriptionLike { return { unsubscribe(): void {} }; }
  async drain(): Promise<void> {}
  closed(): Promise<Error | undefined> { return new Promise(() => {}); }
}

class ConnectingNatsModule implements NatsModuleLike {
  async connect(): Promise<NatsConnectionLike> { return new IdleNatsConnection(); }
}

/** Overrides the module seam only, so `endpointLabel` and the connect path are NatsActor's own. */
class FakeTransportNatsActor extends NatsActor {
  protected override natsModule(): Promise<NatsModuleLike> {
    return Promise.resolve(new ConnectingNatsModule());
  }
  /**
   * The credentialed `servers` entries are what this suite feeds the label
   * redaction, and the validator refuses them at start (#1443), so the fake
   * skips it: the label is the second line of defence and is tested as one.
   */
  protected override optionsValidator(): NatsOptionsValidator {
    return new (class extends NatsOptionsValidator {
      override validate(): void {}
    })();
  }
}

/** Record the `endpoint` of every `BrokerConnected` the stream delivers. */
function connectedEndpoints(system: ActorSystem): string[] {
  const seen: string[] = [];
  system.eventStream.subscribe(
    system.spawnAnonymous(() => new (class extends Actor<unknown> {
      override onReceive(event: unknown): void { seen.push((event as BrokerConnected).endpoint); }
    })()),
    BrokerConnected,
  );
  return seen;
}

describe('NatsActor — the published endpoint carries no credential (found while #1458)', () => {
  // [configured servers, the endpoint BrokerConnected carries, what must not appear]
  const cases: Array<[string[], string, string[]]> = [
    [['a:SECRET1@nats.example.com:4222'], '***@nats.example.com:4222', ['SECRET1']],
    [['TOKEN1@h1:4222', 'TOKEN2@h2:4222'], '***@h1:4222,***@h2:4222', ['TOKEN1', 'TOKEN2']],
    [['nats://u:SECRET1@h1', 'nats://u:SECRET2@h2'], 'nats://***@h1,nats://***@h2', ['SECRET1', 'SECRET2']],
  ];

  test.each(cases)('servers %p', async (servers, expected, secrets) => {
    const system = createTestActorSystem({ name: 'nats-endpoint-label' });
    const seen = connectedEndpoints(system);
    const options = NatsOptions.create().withServers(servers);
    system.spawn(() => new FakeTransportNatsActor(options), 'nats');
    try {
      await awaitCondition(() => seen.length >= 1, {
        timeoutMs: 4_000, label: 'BrokerConnected reached its subscriber',
      });
      for (const secret of secrets) expect(seen[0]).not.toContain(secret);
      // The identity survives: the field is useless if it stops saying which servers.
      expect(seen[0]).toBe(expected);
    } finally {
      await system.terminate();
    }
  });
});
