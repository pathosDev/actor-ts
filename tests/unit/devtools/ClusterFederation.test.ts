/**
 * What `src/devtools/cluster/` accepts off the cluster wire (#595, #593).
 *
 * Two halves of one habit.  The node agent answers "how is your node
 * doing?" — and the answer is the whole actor tree — to whichever address
 * the query's body pointed at, so a single forged frame turned any
 * DevTools-enabled node into a reflector posting its internals to an
 * attacker-chosen host (#595).  The collector on the other end filed
 * whatever came back under the address the *report* claimed, unbounded
 * and unvalidated, so a peer could invent nodes, overwrite another node's
 * row, or poison the cluster-wide totals (#593).  Both now go by the
 * address the transport handed the handler.
 *
 * The agent half is asserted by driving the registered envelope handler
 * directly, the way `Cluster.dispatchEnvelope` does, with `_sendEnvelope`
 * recorded: an `InMemoryTransport` silently drops a frame to an address
 * nobody registered, so "the attacker's node received nothing" would pass
 * against the unfixed code too.  What has to be pinned is where the agent
 * *aimed*.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { EnvelopeMessage, MemberData, MemberStatus } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import {
  MAXIMUM_PEER_ACTORS,
  MAXIMUM_PEER_REPORTS,
  TOP_MAILBOX_COUNT,
} from '../../../src/devtools/Constants.js';
import { DevToolsFederation } from '../../../src/devtools/cluster/Federation.js';
import { DevToolsNodeAgent } from '../../../src/devtools/cluster/NodeAgent.js';
import {
  DEVTOOLS_AGENT_PATH,
  DEVTOOLS_COLLECTOR_PATH,
  type NodeQueryMessage,
} from '../../../src/devtools/cluster/NodeProtocol.js';
import { NodeSampler } from '../../../src/devtools/internal/NodeSampler.js';
import type { ActorNode, MailboxDepthEntry, NodeFigures } from '../../../src/devtools/protocol/index.js';

const SELF_HOST = '10.0.59.11';
const PEER_HOST = '10.0.59.12';
/** Somewhere the node has no business dialling. */
const ATTACKER_ADDRESS = 'victim@203.0.113.7:9999';

/** One recorded outbound envelope: which address it was aimed at, and what it said. */
type SentEnvelope = {
  readonly to: NodeAddress;
  readonly envelope: EnvelopeMessage;
};

type Harness = {
  readonly system: ActorSystem;
  readonly cluster: Cluster;
  readonly address: NodeAddress;
  /** Everything the node tried to send, in order. */
  readonly sent: SentEnvelope[];
  /** Handler registrations to release before the system goes down. */
  readonly teardown: Array<() => void>;
};

interface ClusterInternals {
  readonly _envelopeHandlersByPath: Map<
    string,
    (envelope: EnvelopeMessage, from: NodeAddress) => void
  >;
  mergeMember(from: NodeAddress, senderStatus: MemberStatus | undefined, data: MemberData): void;
  _sendEnvelope(to: NodeAddress, envelope: EnvelopeMessage): void;
}

const internals = (cluster: Cluster): ClusterInternals => cluster as unknown as ClusterInternals;

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    for (const release of harness.teardown) release();
    try { await harness.cluster.leave(); } catch { /* teardown is best-effort */ }
    try { await harness.system.terminate(); } catch { /* teardown is best-effort */ }
  }
});

/**
 * A one-node cluster with every timer pushed out of the way and outbound
 * sends recorded.  `maxMembers` is `0` — uncapped — so a test can seat
 * more members than the cluster's own default allows and reach the
 * collector's ceiling, which sits at that default deliberately.
 */
async function startNode(systemName: string, port: number): Promise<Harness> {
  const address = new NodeAddress(systemName, SELF_HOST, port);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  const clusterOptions = ClusterOptions.create()
    .withHost(address.host)
    .withPort(port)
    .withTransport(new InMemoryTransport(address))
    .withFailureDetector({
      heartbeatIntervalMs: 60_000,
      unreachableAfterMs: 2_000,
      downAfterMs: 5_000,
    })
    .withGossipIntervalMs(60_000)
    .withMaxMembers(0)
    .withTombstonePruneIntervalMs(60_000);
  const cluster = await Cluster.join(system, clusterOptions);
  const sent: SentEnvelope[] = [];
  internals(cluster)._sendEnvelope = (to, envelope) => { sent.push({ to, envelope }); };
  const harness: Harness = { system, cluster, address, sent, teardown: [] };
  harnesses.push(harness);
  return harness;
}

/** Register the agent on `harness` and arrange for it to be torn down. */
function attachAgent(harness: Harness): DevToolsNodeAgent {
  const agent = new DevToolsNodeAgent(harness.system, harness.cluster, new NodeSampler(harness.system));
  agent.start();
  harness.teardown.push(() => agent.stop());
  return agent;
}

/** Register the collector on `harness` and arrange for it to be torn down. */
function attachFederation(harness: Harness): DevToolsFederation {
  const federation = new DevToolsFederation(harness.cluster);
  federation.start();
  harness.teardown.push(() => federation.stop());
  return federation;
}

/**
 * Hand a body to the handler registered at `path`, as `from`.
 *
 * The same two arguments `Cluster.dispatchEnvelope` passes: the decoded
 * envelope, and the identity of the connection it arrived on.
 */
function deliver(harness: Harness, path: string, from: NodeAddress, body: unknown): void {
  const handler = internals(harness.cluster)._envelopeHandlersByPath.get(path);
  if (handler === undefined) throw new Error(`no envelope handler is registered at ${path}`);
  handler({ kind: 'envelope', to: path, from: null, body }, from);
}

/** Make `peer` a member by gossiping its own record, which is a claim it may make. */
function joinPeer(cluster: Cluster, peer: NodeAddress): void {
  internals(cluster).mergeMember(peer, 'up', {
    address: peer.toJSON(), status: 'up', version: Date.now(), roles: [],
  });
}

/** One mailbox-depth reading, as a well-behaved node would report it. */
const mailboxDepth = (path: string, size: number): MailboxDepthEntry =>
  ({ path, size, stashSize: 0, suspended: false });

/** One actor row, as a well-behaved node would report it. */
const actorNode = (nodeAddress: string, name: string): ActorNode => ({
  nodeAddress,
  path: `actor-ts://peer/user/${name}`,
  parentPath: 'actor-ts://peer/user',
  name,
  className: 'ProbeActor',
  displayName: null,
  cellState: 'running',
  mailboxSize: 0,
  stashSize: 0,
  suspended: false,
  dispatcher: null,
  childCount: 0,
  internal: false,
});

/** A complete, valid set of figures claiming to be `address`. */
const figuresClaiming = (address: string): NodeFigures => ({
  address,
  systemName: 'peer',
  uptimeMs: 1_000,
  actorCount: 3,
  actorsStarted: 3,
  actorsStopped: 0,
  actorsRestarted: 0,
  deadLetters: 0,
  messagesProcessed: 7,
  mailboxDrops: 0,
  mailboxBacklog: 0,
  stashedTotal: 0,
  suspendedActors: 0,
  topMailboxes: [],
});

/** A report as it arrives on the wire — `figures` and `actors` are the sender's word. */
const reportClaiming = (
  figures: unknown,
  actors?: unknown,
): Record<string, unknown> => ({
  kind: 'devtools-node-report',
  round: 1,
  figures,
  ...(actors === undefined ? {} : { actors }),
});

describe('DevToolsNodeAgent — the reply follows the connection, not the body (#595)', () => {
  test('a forged return address in the query cannot steer the answer', async () => {
    const harness = await startNode('agent-forged-reply', 9_591);
    attachAgent(harness);
    const peer = new NodeAddress('agent-forged-reply', PEER_HOST, 9_592);

    // The wire carries whatever the sender puts on it; the field is gone
    // from the type but an attacker is not bound by our types.
    deliver(harness, DEVTOOLS_AGENT_PATH, peer, {
      kind: 'devtools-node-query',
      from: ATTACKER_ADDRESS,
      round: 1,
      wantActors: false,
    });

    expect(harness.sent.length).toBe(1);
    expect(harness.sent[0]!.to.toString()).toBe(peer.toString());
    expect(harness.sent[0]!.envelope.to).toBe(DEVTOOLS_COLLECTOR_PATH);
  });

  test('the actor tree is disclosed to the connection peer and nowhere else', async () => {
    const harness = await startNode('agent-forged-tree', 9_593);
    attachAgent(harness);
    const peer = new NodeAddress('agent-forged-tree', PEER_HOST, 9_594);

    deliver(harness, DEVTOOLS_AGENT_PATH, peer, {
      kind: 'devtools-node-query',
      from: ATTACKER_ADDRESS,
      round: 2,
      wantActors: true,
    });

    // The disclosure is the point of the finding: `wantActors` returns
    // every cell's path, class and mailbox depth.
    const report = harness.sent[0]!.envelope.body as { actors?: ReadonlyArray<unknown> };
    expect(Array.isArray(report.actors)).toBe(true);
    expect(harness.sent.map((one) => one.to.toString())).toEqual([peer.toString()]);
  });

  test('a malformed query is dropped rather than answered', async () => {
    const harness = await startNode('agent-malformed', 9_595);
    attachAgent(harness);
    const peer = new NodeAddress('agent-malformed', PEER_HOST, 9_596);

    deliver(harness, DEVTOOLS_AGENT_PATH, peer, { kind: 'devtools-node-query', round: 'soon' });
    deliver(harness, DEVTOOLS_AGENT_PATH, peer, { kind: 'something-else', round: 1 });
    deliver(harness, DEVTOOLS_AGENT_PATH, peer, null);

    expect(harness.sent).toEqual([]);
  });
});

describe('DevToolsFederation — the query advertises no return address (#595)', () => {
  test('poll() puts no `from` on the wire', async () => {
    const harness = await startNode('collector-query', 9_597);
    const peer = new NodeAddress('collector-query', PEER_HOST, 9_598);
    joinPeer(harness.cluster, peer);
    const federation = attachFederation(harness);

    federation.poll();

    expect(harness.sent.length).toBe(1);
    expect(harness.sent[0]!.to.toString()).toBe(peer.toString());
    const query = harness.sent[0]!.envelope.body as NodeQueryMessage & { from?: string };
    expect(query.kind).toBe('devtools-node-query');
    // A return address is the field the agent used to trust.  Not sending
    // one keeps a mixed-version cluster honest about which half is patched.
    expect(query.from).toBeUndefined();
  });
});

describe('DevToolsFederation — a report is filed under its sender (#593)', () => {
  test('the address the report claims is replaced by the one that sent it', async () => {
    const harness = await startNode('collector-attribution', 9_571);
    const peer = new NodeAddress('collector-attribution', PEER_HOST, 9_572);
    joinPeer(harness.cluster, peer);
    const federation = attachFederation(harness);

    deliver(harness, DEVTOOLS_COLLECTOR_PATH, peer, reportClaiming(
      figuresClaiming(ATTACKER_ADDRESS),
      [actorNode(ATTACKER_ADDRESS, 'orders')],
    ));

    // One row, under the sender.  `ActorTreeTap` looks a peer's tree back
    // up by `figures.address`, so the normalisation has to reach the
    // figures and not only the map key, or the panel goes blank instead.
    expect(federation.peers().map((peerSample) => peerSample.figures.address))
      .toEqual([peer.toString()]);
    expect(federation.actorsOf(peer.toString())?.length).toBe(1);
    expect(federation.actorsOf(ATTACKER_ADDRESS)).toBeNull();
  });

  test('a member cannot file readings under another member\'s name', async () => {
    const harness = await startNode('collector-impersonation', 9_573);
    const honest = new NodeAddress('collector-impersonation', PEER_HOST, 9_574);
    const liar = new NodeAddress('collector-impersonation', PEER_HOST, 9_575);
    joinPeer(harness.cluster, honest);
    joinPeer(harness.cluster, liar);
    const federation = attachFederation(harness);

    deliver(harness, DEVTOOLS_COLLECTOR_PATH, honest, reportClaiming({
      ...figuresClaiming(honest.toString()), actorCount: 3,
    }));
    deliver(harness, DEVTOOLS_COLLECTOR_PATH, liar, reportClaiming({
      ...figuresClaiming(honest.toString()), actorCount: 9_999,
    }));

    const byAddress = new Map(
      federation.peers().map((peerSample) => [peerSample.figures.address, peerSample.figures]),
    );
    expect([...byAddress.keys()].sort()).toEqual([honest.toString(), liar.toString()].sort());
    expect(byAddress.get(honest.toString())?.actorCount).toBe(3);
    expect(byAddress.get(liar.toString())?.actorCount).toBe(9_999);
  });

  test('a report from a node the cluster does not hold is ignored', async () => {
    const harness = await startNode('collector-stranger', 9_576);
    const stranger = new NodeAddress('collector-stranger', PEER_HOST, 9_577);
    const federation = attachFederation(harness);

    deliver(harness, DEVTOOLS_COLLECTOR_PATH, stranger,
      reportClaiming(figuresClaiming(stranger.toString())));

    // `poll()` asks members and nobody else, so an unsolicited report is
    // the only kind that can arrive from a non-member.
    expect(federation.peers()).toEqual([]);
  });
});

describe('DevToolsFederation — what a report may contain (#593)', () => {
  test('figures that would break the cluster-wide totals are refused', async () => {
    const harness = await startNode('collector-poison', 9_578);
    const peer = new NodeAddress('collector-poison', PEER_HOST, 9_579);
    joinPeer(harness.cluster, peer);
    const federation = attachFederation(harness);

    const { actorCount: _dropped, ...missingCounter } = figuresClaiming(peer.toString());
    const poisons: unknown[] = [
      missingCounter,
      { ...figuresClaiming(peer.toString()), messagesProcessed: 'lots' },
      { ...figuresClaiming(peer.toString()), mailboxBacklog: Number.NaN },
      { ...figuresClaiming(peer.toString()), topMailboxes: 'none' },
      { ...figuresClaiming(peer.toString()), topMailboxes: [{ path: '/user/a', size: 'deep' }] },
      {
        ...figuresClaiming(peer.toString()),
        handlerLatency: { p50Ms: 1, p99Ms: 2, count: 'many' },
      },
      [figuresClaiming(peer.toString())],
    ];
    for (const figures of poisons) {
      deliver(harness, DEVTOOLS_COLLECTOR_PATH, peer, reportClaiming(figures));
    }

    // `StatsTap.totalOf` adds these straight into the overview, where one
    // `undefined` makes every cluster-wide number `NaN`.
    expect(federation.peers()).toEqual([]);
  });

  test('an actors field that is not an array is refused outright', async () => {
    const harness = await startNode('collector-actors-shape', 9_580);
    const peer = new NodeAddress('collector-actors-shape', PEER_HOST, 9_581);
    joinPeer(harness.cluster, peer);
    const federation = attachFederation(harness);

    deliver(harness, DEVTOOLS_COLLECTOR_PATH, peer,
      reportClaiming(figuresClaiming(peer.toString()), { length: 1e9 }));

    expect(federation.peers()).toEqual([]);
  });

  test('an oversized actor tree is truncated, and hot mailboxes with it', async () => {
    const harness = await startNode('collector-oversized', 9_582);
    const peer = new NodeAddress('collector-oversized', PEER_HOST, 9_583);
    joinPeer(harness.cluster, peer);
    const federation = attachFederation(harness);

    const huge = Array.from(
      { length: MAXIMUM_PEER_ACTORS + 5 },
      (_unused, index) => actorNode(peer.toString(), `actor-${index}`),
    );
    const padded = Array.from(
      { length: TOP_MAILBOX_COUNT * 4 },
      (_unused, index) => mailboxDepth(`/user/a-${index}`, index),
    );

    deliver(harness, DEVTOOLS_COLLECTOR_PATH, peer, reportClaiming(
      { ...figuresClaiming(peer.toString()), topMailboxes: padded },
      huge,
    ));

    expect(federation.actorsOf(peer.toString())?.length).toBe(MAXIMUM_PEER_ACTORS);
    expect(federation.peers()[0]!.figures.topMailboxes.length).toBe(TOP_MAILBOX_COUNT);
  });

  test('a round that asks for no tree keeps the last one', async () => {
    const harness = await startNode('collector-tree-kept', 9_584);
    const peer = new NodeAddress('collector-tree-kept', PEER_HOST, 9_585);
    joinPeer(harness.cluster, peer);
    const federation = attachFederation(harness);

    deliver(harness, DEVTOOLS_COLLECTOR_PATH, peer, reportClaiming(
      figuresClaiming(peer.toString()), [actorNode(peer.toString(), 'orders')],
    ));
    deliver(harness, DEVTOOLS_COLLECTOR_PATH, peer,
      reportClaiming(figuresClaiming(peer.toString())));

    // Re-keying on the sender must not lose the carry-over: the panel
    // would blank between the rounds that ask for actors otherwise.
    expect(federation.actorsOf(peer.toString())?.length).toBe(1);
  });

  test('the cache stops at its ceiling and drops the oldest reading', async () => {
    const harness = await startNode('collector-ceiling', 9_586);
    const federation = attachFederation(harness);
    const peers = Array.from(
      { length: MAXIMUM_PEER_REPORTS + 1 },
      (_unused, index) => new NodeAddress('collector-ceiling', PEER_HOST, 20_000 + index),
    );

    for (const peer of peers) {
      joinPeer(harness.cluster, peer);
      deliver(harness, DEVTOOLS_COLLECTOR_PATH, peer,
        reportClaiming(figuresClaiming(peer.toString())));
    }

    const held = new Set(federation.peers().map((peerSample) => peerSample.figures.address));
    expect(held.size).toBe(MAXIMUM_PEER_REPORTS);
    expect(held.has(peers[0]!.toString())).toBe(false);
    expect(held.has(peers[peers.length - 1]!.toString())).toBe(true);
  });
});
