/**
 * What `src/devtools/cluster/` accepts off the cluster wire (#595).
 *
 * The node agent answers one question — "how is your node doing?" — and
 * the answer is the whole actor tree.  It used to send that answer
 * wherever the query's body pointed, so a single forged frame turned any
 * DevTools-enabled node into a reflector that posted its internals to an
 * attacker-chosen host.  The reply now goes to the address the transport
 * hands the handler, which is the connection the query arrived on.
 *
 * Asserted by driving the registered envelope handler directly, the way
 * `Cluster.dispatchEnvelope` does, with `_sendEnvelope` recorded: an
 * `InMemoryTransport` silently drops a frame to an address nobody
 * registered, so "the attacker's node received nothing" would pass
 * against the unfixed code too.  What has to be pinned is where the
 * agent *aimed*.
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
import { DevToolsFederation } from '../../../src/devtools/cluster/Federation.js';
import { DevToolsNodeAgent } from '../../../src/devtools/cluster/NodeAgent.js';
import {
  DEVTOOLS_AGENT_PATH,
  DEVTOOLS_COLLECTOR_PATH,
  type NodeQueryMessage,
} from '../../../src/devtools/cluster/NodeProtocol.js';
import { NodeSampler } from '../../../src/devtools/internal/NodeSampler.js';

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

/** A one-node cluster with every timer pushed out of the way and outbound sends recorded. */
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
