import { describe, expect, test } from 'bun:test';
import { Cluster } from '../../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../../src/cluster/ClusterOptions.js';
import { MemberWeaklyUp } from '../../../../src/cluster/ClusterEvents.js';
import { InMemoryTransport } from '../../../../src/cluster/Transport.js';
import { NodeAddress } from '../../../../src/cluster/NodeAddress.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

describe('Cluster — WeaklyUp', () => {
  test('joining member gets promoted to weakly-up after the timeout when no leader is present', async () => {
    const sysOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const sys = ActorSystem.create('wup', sysOptions);
    const events: string[] = [];
    // Seed an unknown peer so the cluster stays in "joining" — no leader elected.
    const transport = new InMemoryTransport(new NodeAddress('wup', 'h', 55001));
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(55001)
      .withSeeds(['wup@h:55002']) // seed that's never brought up
      .withTransport(transport)
      .withWeaklyUpAfterMs(120)
      .withGossipIntervalMs(80)
      .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 200, downAfterMs: 400 })
      .withSeedRetryIntervalMs(100);
    const cluster = await Cluster.join(sys, clusterOptions);

    cluster.subscribe((evt) => {
      if (evt instanceof MemberWeaklyUp) events.push(`weaklyUp:${evt.member.address}`);
    });

    // 220 ms was one promotion window (120 ms) plus change — no margin at all
    // once the gossip and seed-retry timers are competing for a loaded event
    // loop.  Waiting for the event itself keeps the lower bound the config
    // already enforces and removes the upper one (#418).
    await awaitCondition(() => events.some(e => e.startsWith('weaklyUp:wup@h:55001')), {
      timeoutMs: 4_000, intervalMs: 20, label: 'the joining member was promoted to weakly-up',
    });
    expect(events.some(e => e.startsWith('weaklyUp:wup@h:55001'))).toBe(true);

    await cluster.leave();
    await sys.terminate();
  });

  test('weakly-up member becomes up once the leader converges', async () => {
    // Start A solo (will self-elect as leader), then start B with weaklyUp
    // enabled — B passes through joining → weakly-up → up.
    const sysAOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const sysA = ActorSystem.create('wup-2', sysAOptions);
    const aOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(55101)
      .withTransport(new InMemoryTransport(new NodeAddress('wup-2', 'h', 55101)))
      .withGossipIntervalMs(60);
    const nodeA = await Cluster.join(sysA, aOptions);

    const sysBOptions = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
    const sysB = ActorSystem.create('wup-2', sysBOptions);
    const eventsB: string[] = [];

    // Seed against A; weaklyUpAfterMs is big enough that normal joining→up
    // via leader convergence wins first and weakly-up is never emitted.
    const bOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(55102)
      .withSeeds(['wup-2@h:55101'])
      .withTransport(new InMemoryTransport(new NodeAddress('wup-2', 'h', 55102)))
      .withWeaklyUpAfterMs(10_000)
      .withGossipIntervalMs(60);
    const nodeB = await Cluster.join(sysB, bOptions);

    nodeB.subscribe((evt) => eventsB.push(evt.constructor.name));

    // `MemberUp` is the anchor for both halves: weakly-up is an *earlier*
    // state, so if the promotion had happened it would already be recorded
    // by the time Up arrives.  That makes the negative assertion sound
    // without a second fixed window.
    await awaitCondition(() => eventsB.includes('MemberUp'), {
      timeoutMs: 4_000, intervalMs: 20, label: 'B reached Up via leader convergence',
    });
    expect(eventsB.includes('MemberUp')).toBe(true);
    expect(eventsB.includes('MemberWeaklyUp')).toBe(false);

    await nodeA.leave(); await sysA.terminate();
    await nodeB.leave(); await sysB.terminate();
  });

  test('a member weakly-up before its seed has started reaches up once the seed does (#1493)', async () => {
    // A's own timer moves it to weakly-up well inside the first retry interval,
    // while B — its only seed — does not exist yet.  Gossip and heartbeats only
    // ever go to members already in the map, so from then on the seed-retry
    // loop is the one thing that can still introduce A to B: it has to outlive
    // the promotion, or A waits, weakly-up and unknown, for good.
    const systemOptionsA = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const systemA = ActorSystem.create('wup-3', systemOptionsA);
    const clusterOptionsA = ClusterOptions.create()
      .withHost('h')
      .withPort(55201)
      .withSeeds(['wup-3@h:55202'])
      .withTransport(new InMemoryTransport(new NodeAddress('wup-3', 'h', 55201)))
      .withWeaklyUpAfterMs(20)
      .withSeedRetryIntervalMs(50)
      .withGossipIntervalMs(60);
    const nodeA = await Cluster.join(systemA, clusterOptionsA);
    let systemB: ActorSystem | null = null;
    let nodeB: Cluster | null = null;
    try {
      await awaitCondition(() => nodeA.selfMember()?.status === 'weakly-up', {
        timeoutMs: 4_000, intervalMs: 5, label: 'A was promoted to weakly-up by its own timer',
      });

      // B arrives late and with no seeds of its own: it forms the cluster and
      // leads it, but it has never heard of A and has no reason to look.
      const systemOptionsB = ActorSystemOptions.create()
        .withLogger(new NoopLogger())
        .withLogLevel(LogLevel.Off);
      systemB = ActorSystem.create('wup-3', systemOptionsB);
      const clusterOptionsB = ClusterOptions.create()
        .withHost('h')
        .withPort(55202)
        .withTransport(new InMemoryTransport(new NodeAddress('wup-3', 'h', 55202)))
        .withGossipIntervalMs(60);
      nodeB = await Cluster.join(systemB, clusterOptionsB);

      await awaitCondition(() => nodeA.selfMember()?.status === 'up', {
        timeoutMs: 4_000, intervalMs: 20, label: 'A reached up through the seed that started late',
      });
      expect(nodeA.selfMember()?.status).toBe('up');
      expect(nodeB.getMembers().some((member) => member.address.equals(nodeA.selfAddress))).toBe(true);
    } finally {
      await nodeA.leave();
      await systemA.terminate();
      if (nodeB) await nodeB.leave();
      if (systemB) await systemB.terminate();
    }
  });
});
