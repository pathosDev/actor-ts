/**
 * The parts of cluster `smallest-mailbox` routing that need no cluster (#69):
 * the options rules, and the selection scan over a cache of depths.
 *
 * The wire half — a routee node actually answering with its mailbox depth —
 * is in `tests/integration/in-process/cluster/router/`, where there are two
 * real nodes to send an envelope between.
 */
import { describe, expect, test } from 'bun:test';
import type { Cluster } from '../../../src/cluster/Cluster.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import {
  ClusterRouterOptions,
  ClusterRouterOptionsValidator,
  type ClusterRouterOptionsType,
} from '../../../src/cluster/router/ClusterRouterOptions.js';
import { MailboxDepthProbe } from '../../../src/cluster/router/MailboxDepthProbe.js';
import type { MailboxDepthReportMessage } from '../../../src/cluster/router/MailboxDepthProtocol.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const ROUTEE_PATH = '/user/worker';

type Message = { kind: 'work'; id: string };

/**
 * Takes the accepted-input union and casts, exactly as `ClusterRouter.factory`
 * does — a methods-only builder is not assignable to the bare settings shape
 * (TS weak-type check), so the union is what a consumer's signature says.
 */
function validate(options: ClusterRouterOptions<Message>): void {
  new ClusterRouterOptionsValidator<Message>()
    .validate(options as Partial<ClusterRouterOptionsType<Message>>);
}

/** The minimum a validator needs to get past the always-on rules. */
function baseOptions(): Partial<ClusterRouterOptionsType<Message>> {
  return { routerType: 'smallest-mailbox', routeePath: ROUTEE_PATH };
}

describe('ClusterRouterOptionsValidator — smallest-mailbox (#69)', () => {
  test('accepts smallest-mailbox as a router type', () => {
    expect(() => validate(baseOptions())).not.toThrow();
  });

  test('accepts the builder form with both mailbox-depth knobs set', () => {
    const routerOptions = ClusterRouterOptions.create<Message>()
      .withRouterType('smallest-mailbox')
      .withRouteePath(ROUTEE_PATH)
      .withMailboxDepthRefreshMs(50)
      .withMailboxDepthStaleAfterMs(500);
    expect(() => validate(routerOptions)).not.toThrow();
  });

  test('rejects a refresh interval that is not a positive integer', () => {
    expect(() => validate({ ...baseOptions(), mailboxDepthRefreshMs: 0 }))
      .toThrow(/mailboxDepthRefreshMs/);
    expect(() => validate({ ...baseOptions(), mailboxDepthRefreshMs: -1 }))
      .toThrow(OptionsError);
    expect(() => validate({ ...baseOptions(), mailboxDepthRefreshMs: 12.5 }))
      .toThrow(OptionsError);
  });

  test('rejects a negative staleness bound but accepts 0 as "never stale"', () => {
    expect(() => validate({ ...baseOptions(), mailboxDepthStaleAfterMs: -1 }))
      .toThrow(/mailboxDepthStaleAfterMs/);
    expect(() => validate({ ...baseOptions(), mailboxDepthStaleAfterMs: 0 })).not.toThrow();
  });

  test('rejects a staleness window shorter than the refresh that refills it', () => {
    // Every reading would expire before its replacement could arrive, leaving
    // the cache permanently cold — a router that works, degraded to
    // round-robin, for a reason nothing in the config reads as wrong.
    expect(() => validate({
      ...baseOptions(),
      mailboxDepthRefreshMs: 500,
      mailboxDepthStaleAfterMs: 100,
    })).toThrow(/mailboxDepthStaleAfterMs/);
  });

  test('the cross-field rule sees the other side\'s default, not just what was set', () => {
    // Only the refresh is set here; it crosses the 1000 ms default staleness.
    expect(() => validate({ ...baseOptions(), mailboxDepthRefreshMs: 5_000 }))
      .toThrow(/mailboxDepthStaleAfterMs/);
    // And the mirror image: only the staleness is set, crossing the 200 ms
    // default refresh.
    expect(() => validate({ ...baseOptions(), mailboxDepthStaleAfterMs: 20 }))
      .toThrow(/mailboxDepthStaleAfterMs/);
  });

  test('the knobs are not required — an unset optional always passes', () => {
    expect(() => validate({ routerType: 'round-robin', routeePath: ROUTEE_PATH })).not.toThrow();
  });
});

/**
 * `pickShallowest` / `record` / the staleness read never touch the cluster —
 * they are the pure half of the probe.  Handing the constructor a stand-in
 * keeps these cases free of a transport, a scheduler and two node startups.
 */
function pureProbe(staleAfterMs: number): MailboxDepthProbe {
  return new MailboxDepthProbe(
    undefined as unknown as Cluster,
    'actor-ts://sys/user/router',
    ROUTEE_PATH,
    staleAfterMs,
  );
}

const node = (port: number): { targetNode: NodeAddress } => ({
  targetNode: new NodeAddress('sys', 'h', port),
});

function report(port: number, depth: number, routeePath = ROUTEE_PATH): MailboxDepthReportMessage {
  return {
    kind: 'mailbox-depth-report',
    node: new NodeAddress('sys', 'h', port).toString(),
    routeePath,
    depth,
  };
}

describe('MailboxDepthProbe — selection (#69)', () => {
  test('picks the node that reported the shallowest mailbox', () => {
    const probe = pureProbe(1_000);
    const routees = [node(1), node(2), node(3)];
    probe.record(report(1, 7), 0);
    probe.record(report(2, 2), 0);
    probe.record(report(3, 9), 0);
    expect(probe.pickShallowest(routees, 0, 0)).toBe(routees[1]!);
    // …and keeps picking it while the readings stand, regardless of the
    // rotation start.  That is the whole point over round-robin.
    expect(probe.pickShallowest(routees, 1, 0)).toBe(routees[1]!);
    expect(probe.pickShallowest(routees, 2, 0)).toBe(routees[1]!);
  });

  test('a node with no reading is skipped, not assumed idle', () => {
    // The silent node may well be the struggling one.  Assuming zero would
    // send it everything precisely when it can least take it.
    const probe = pureProbe(1_000);
    const routees = [node(1), node(2)];
    probe.record(report(2, 4), 0);
    expect(probe.pickShallowest(routees, 0, 0)).toBe(routees[1]!);
  });

  test('a cold cache degrades to the round-robin rotation', () => {
    const probe = pureProbe(1_000);
    const routees = [node(1), node(2), node(3)];
    expect(probe.pickShallowest(routees, 0, 0)).toBe(routees[0]!);
    expect(probe.pickShallowest(routees, 1, 0)).toBe(routees[1]!);
    expect(probe.pickShallowest(routees, 2, 0)).toBe(routees[2]!);
    expect(probe.pickShallowest(routees, 3, 0)).toBe(routees[0]!);
  });

  test('an all-idle pool rotates instead of pinning the first routee', () => {
    // Every depth 0 — a plain "first minimum wins" scan would send everything
    // to routee 1 whenever the pool drains between arrivals.
    const probe = pureProbe(1_000);
    const routees = [node(1), node(2), node(3)];
    for (const routee of routees) probe.record(report(routee.targetNode.port, 0), 0);
    const picked = [0, 1, 2, 3].map((index) => probe.pickShallowest(routees, index, 0));
    expect(picked).toEqual([routees[0]!, routees[1]!, routees[2]!, routees[0]!]);
  });

  test('a uniformly saturated pool rotates too', () => {
    const probe = pureProbe(1_000);
    const routees = [node(1), node(2)];
    probe.record(report(1, 64), 0);
    probe.record(report(2, 64), 0);
    expect(probe.pickShallowest(routees, 0, 0)).toBe(routees[0]!);
    expect(probe.pickShallowest(routees, 1, 0)).toBe(routees[1]!);
  });

  test('a reading past the staleness bound stops counting', () => {
    const probe = pureProbe(1_000);
    const routees = [node(1), node(2)];
    probe.record(report(1, 0), 0);
    probe.record(report(2, 5), 0);
    // Fresh: the idle node wins.
    expect(probe.pickShallowest(routees, 1, 500)).toBe(routees[0]!);
    // Expired: both readings are gone, so the rotation decides.
    expect(probe._depthOf(routees[0]!.targetNode.toString(), 1_001)).toBeNull();
    expect(probe.pickShallowest(routees, 1, 1_001)).toBe(routees[1]!);
  });

  test('staleAfterMs 0 turns the expiry off — an ancient reading still counts', () => {
    const probe = pureProbe(0);
    const routees = [node(1), node(2)];
    probe.record(report(1, 0), 0);
    probe.record(report(2, 5), 0);
    expect(probe._depthOf(routees[0]!.targetNode.toString(), 86_400_000)).toBe(0);
    expect(probe.pickShallowest(routees, 1, 86_400_000)).toBe(routees[0]!);
  });

  test('a report for a different routee path is ignored', () => {
    const probe = pureProbe(1_000);
    probe.record(report(1, 3, '/user/other'), 0);
    expect(probe._depthOf(new NodeAddress('sys', 'h', 1).toString(), 0)).toBeNull();
  });
});
