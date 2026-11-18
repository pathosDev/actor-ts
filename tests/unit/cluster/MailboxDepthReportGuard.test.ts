/**
 * The mailbox-depth lane narrows what a peer sends it (#1042).
 *
 * A depth report arrives off the cluster wire, and the router's selection
 * scan relies on "a depth is never negative": a report of `-1` from one node
 * used to win every pick and pull the whole pool's traffic onto it.  The
 * guard is documented as the narrowing for untrusted input, so it now
 * delivers it — a depth is a non-negative integer, and anything else is not a
 * report, which the router treats like no reading at all.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { ClusterMailboxDepthAgent } from '../../../src/cluster/router/MailboxDepthAgent.js';
import { isMailboxDepthReport } from '../../../src/cluster/router/MailboxDepthProtocol.js';

function reportWith(depth: unknown): unknown {
  return { kind: 'mailbox-depth-report', node: 'sys@h:1', routeePath: '/user/worker', depth };
}

describe('isMailboxDepthReport — depth narrowing (#1042)', () => {
  test.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['non-finite', Number.POSITIVE_INFINITY],
    ['fractional', 1.5],
    ['string', '3'],
  ])('refuses a %s depth', (_label, depth) => {
    expect(isMailboxDepthReport(reportWith(depth))).toBe(false);
  });

  test.each([0, 1, 10_000])('accepts the depth %p', (depth) => {
    expect(isMailboxDepthReport(reportWith(depth))).toBe(true);
  });
});

describe('ClusterMailboxDepthAgent.serve — names the path it serves (#1042)', () => {
  test.each([
    ['no path', undefined],
    ['an empty path', ''],
  ])('refuses %s', (_label, routeePath) => {
    // Refused before the cluster is touched, so a bare stand-in is enough.
    const cluster = {} as Cluster;
    expect(() => ClusterMailboxDepthAgent.serve(cluster, routeePath as unknown as string))
      .toThrow(/routeePath/);
  });
});

/* ------------------------- served-path bookkeeping ------------------------ */

const systems: ActorSystem[] = [];
afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

class IdleActor extends Actor<string> {
  override onReceive(): void {}
}

/**
 * Just the cluster seams the agent touches, over a real system so the path
 * walk resolves real cells.  `ask` plays a peer's query and returns how many
 * answers it produced.
 */
function agentHarness(): { cluster: Cluster; ask: (routeePath: string) => number } {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create('depth-guard', options);
  systems.push(system);
  system.spawn(IdleActor, 'worker');
  system.spawn(IdleActor, 'payments');
  let handler: ((envelope: { body: unknown }, from: NodeAddress) => void) | null = null;
  let answers = 0;
  const cluster = {
    selfAddress: new NodeAddress('depth-guard', 'h', 1),
    system,
    _registerEnvelopeHandler(_path: string, registered: typeof handler): () => void {
      handler = registered;
      return () => { handler = null; };
    },
    _sendEnvelope(): boolean {
      answers++;
      return true;
    },
  } as unknown as Cluster;
  const ask = (routeePath: string): number => {
    const before = answers;
    handler?.({ body: { kind: 'mailbox-depth-query', replyTo: '/user/sink', routeePath } },
      new NodeAddress('depth-guard', 'h', 2));
    return answers - before;
  };
  return { cluster, ask };
}

describe('ClusterMailboxDepthAgent — served paths are counted per holder (#1042)', () => {
  test('answers a served path, not an unserved one, and keeps a path while any holder does', () => {
    const { cluster, ask } = agentHarness();
    const releaseFirst = ClusterMailboxDepthAgent.serve(cluster, '/user/worker');
    const releaseSecond = ClusterMailboxDepthAgent.serve(cluster, 'user/worker');
    const releasePayments = ClusterMailboxDepthAgent.serve(cluster, '/user/payments');

    expect(ask('/user/worker')).toBe(1);
    expect(ask('/user/payments')).toBe(1);

    releasePayments();
    expect(ask('/user/payments')).toBe(0);

    // The two spellings are one served path held twice.
    releaseFirst();
    releaseFirst();   // idempotent: does not take the second holder's share
    expect(ask('/user/worker')).toBe(1);

    releaseSecond();
    expect(ClusterMailboxDepthAgent._isServing(cluster)).toBe(false);
  });
});
