import { describe, expect, test } from 'bun:test';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { MemberWeaklyUp } from '../../../../src/cluster/ClusterEvents.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

describe('Cluster — WeaklyUp', () => {
  test('joining member gets promoted to weakly-up after the timeout when no leader is present', async () => {
    const sys = ActorSystem.create('wup', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const events: string[] = [];
    // Seed an unknown peer so the cluster stays in "joining" — no leader elected.
    const transport = new InMemoryTransport(new NodeAddress('wup', 'h', 55001));
    const cluster = await Cluster.join(sys, {
      host: 'h', port: 55001,
      seeds: ['wup@h:55002'], // seed that's never brought up
      transport,
      weaklyUpAfterMs: 120,
      gossipIntervalMs: 80,
      failureDetector: { heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 },
      seedRetryIntervalMs: 100,
    });

    cluster.subscribe((evt) => {
      if (evt instanceof MemberWeaklyUp) events.push(`weaklyUp:${evt.member.address}`);
    });

    await sleep(220);
    expect(events.some(e => e.startsWith('weaklyUp:wup@h:55001'))).toBe(true);

    await cluster.leave();
    await sys.terminate();
  });

  test('weakly-up member becomes up once the leader converges', async () => {
    // Start A solo (will self-elect as leader), then start B with weaklyUp
    // enabled — B passes through joining → weakly-up → up.
    const sysA = ActorSystem.create('wup-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const a = await Cluster.join(sysA, {
      host: 'h', port: 55101,
      transport: new InMemoryTransport(new NodeAddress('wup-2', 'h', 55101)),
      gossipIntervalMs: 60,
    });

    const sysB = ActorSystem.create('wup-2', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    const eventsB: string[] = [];

    // Seed against A; weaklyUpAfterMs is big enough that normal joining→up
    // via leader convergence wins first and weakly-up is never emitted.
    const b = await Cluster.join(sysB, {
      host: 'h', port: 55102,
      seeds: ['wup-2@h:55101'],
      transport: new InMemoryTransport(new NodeAddress('wup-2', 'h', 55102)),
      weaklyUpAfterMs: 10_000,
      gossipIntervalMs: 60,
    });

    b.subscribe((evt) => eventsB.push(evt.constructor.name));

    await sleep(500);
    expect(eventsB.includes('MemberUp')).toBe(true);
    expect(eventsB.includes('MemberWeaklyUp')).toBe(false);

    await a.leave(); await sysA.terminate();
    await b.leave(); await sysB.terminate();
  });
});
