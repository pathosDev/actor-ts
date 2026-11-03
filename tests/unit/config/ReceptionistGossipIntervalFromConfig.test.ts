/**
 * #842, #857 — `actor-ts.cluster.receptionist.gossip-interval`, driven through
 * the entry point an application calls: `ReceptionistId.start`.
 *
 * `PubSubAndReceptionistConfigDefaults.test.ts` proves the leaf parses, and
 * the receptionist's caps suite reads its own leaves through the extension —
 * but nothing ran the interval through it.  The extension could drop the
 * reader's `gossipIntervalMs` on the way to the actor and every test stayed
 * green while a deployment's tuning silently fell back to the built-in second.
 * The receptionist's JSDoc and the #857 entry both promise more: the
 * extension takes this key, and never the cluster's own gossip interval.
 *
 * Every node runs on a {@link ManualScheduler}, so a gossip push is a timer
 * tick counted in virtual time.  The receptionist pushes only on its timer —
 * a full key set to one random `up` peer per tick — so the count of its frames
 * is the count of its ticks.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import type { WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { Config } from '../../../src/config/Config.js';
import { Find, Listing, ReceptionistId, ReceptionistOptions, ServiceKey } from '../../../src/discovery/index.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const HOST = 'h';
const RECEPTIONIST_GOSSIP = 'receptionist-gossip';

type Node = {
  readonly system: ActorSystem;
  readonly scheduler: ManualScheduler;
  readonly cluster: Cluster;
  /** The kind of every frame the node handed its transport, in order. */
  readonly frames: string[];
};

/** The private surface these cases reach through: the entry point a peer's frame takes, by design. */
interface ClusterInternals {
  handleWire(from: NodeAddress, message: WireMessage): void;
}

/** Keeps every message it receives. */
class Observer extends Actor<unknown> {
  constructor(private readonly received: unknown[]) { super(); }
  override onReceive(message: unknown): void { this.received.push(message); }
}

/**
 * Record the kind of every frame the node hands its transport.  The peer these
 * cases gossip to is a claim with no process behind it, and
 * `InMemoryTransport.send` drops a frame for an address nobody listens on, so
 * the send is the one place a push can be seen.
 */
function recordFrames(transport: InMemoryTransport): string[] {
  const recorded: string[] = [];
  const send = transport.send.bind(transport);
  transport.send = (to: NodeAddress, message: WireMessage): void => {
    recorded.push(message.kind);
    send(to, message);
  };
  return recorded;
}

async function startNode(systemName: string, port: number, hocon: string): Promise<Node> {
  const scheduler = new ManualScheduler();
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withScheduler(scheduler)
    .withConfig(Config.parseString(hocon));
  const system = ActorSystem.create(systemName, systemOptions);
  const transport = new InMemoryTransport(new NodeAddress(systemName, HOST, port));
  const frames = recordFrames(transport);
  const clusterOptions = ClusterOptions.create()
    .withHost(HOST)
    .withPort(port)
    .withTransport(transport)
    // Far past every case, so the detector never takes the peer out of `upMembers()`.
    .withFailureDetector({ heartbeatIntervalMs: 60_000, unreachableAfterMs: 120_000, downAfterMs: 240_000 });
  const cluster = await Cluster.join(system, clusterOptions);
  return { system, scheduler, cluster, frames };
}

async function stopNode(node: Node): Promise<void> {
  try { await node.cluster.leave(); } catch { /* teardown is best-effort */ }
  await node.system.terminate();
}

/**
 * A peer announcing itself `up` in its own gossip frame, which is the one claim
 * `maySpeakFor` never refuses.  From then on it is in `upMembers()`, the set
 * the receptionist gossips to — without one, a tick sends nothing.
 */
function introducePeer(node: Node, port: number): void {
  const peer = new NodeAddress(node.system.name, HOST, port);
  const stamp = Date.now();
  (node.cluster as unknown as ClusterInternals).handleWire(peer, {
    kind: 'gossip',
    from: peer.toJSON(),
    sequence: stamp,
    members: [{ address: peer.toJSON(), status: 'up', version: stamp, roles: [] }],
  });
}

/**
 * Start the receptionist through the extension and return once it has
 * answered a `Find`: past `preStart`, so its gossip timer is armed at the
 * scheduler's current instant, which every case counts from.
 */
async function startReceptionist(node: Node, options?: ReceptionistOptions): Promise<void> {
  const extension = node.system.extension(ReceptionistId);
  const ref = options === undefined ? extension.start(node.cluster) : extension.start(node.cluster, options);
  const received: unknown[] = [];
  const observer = node.system.spawnAnonymous(() => new Observer(received));
  ref.tell(new Find(new ServiceKey<unknown>('nobody-registered'), observer));
  await awaitCondition(() => received.some((message) => message instanceof Listing), {
    label: 'the receptionist answered the Find',
  });
}

const pushes = (node: Node): number => node.frames.filter((kind) => kind === RECEPTIONIST_GOSSIP).length;

describe('ReceptionistId.start applies actor-ts.cluster.receptionist.gossip-interval (#842)', () => {
  test('the key paces the receptionist gossip', async () => {
    const node = await startNode('receptionist-config-interval', 64_721,
      'actor-ts.cluster.receptionist.gossip-interval = 250ms');
    introducePeer(node, 64_722);
    await startReceptionist(node);
    const before = pushes(node);

    node.scheduler.advance(249);
    expect(pushes(node)).toBe(before);
    node.scheduler.advance(1);
    expect(pushes(node)).toBe(before + 1);
    node.scheduler.advance(750);
    expect(pushes(node)).toBe(before + 4);

    await stopNode(node);
  });

  test('the cluster gossip-interval does not pace it', async () => {
    // The receptionist has a timer of its own, at its own key's 1 s default,
    // and does not follow the cluster's cadence.
    const node = await startNode('receptionist-config-own-timer', 64_723,
      'actor-ts.cluster.gossip-interval = 100ms');
    introducePeer(node, 64_724);
    await startReceptionist(node);
    const receptionistBefore = pushes(node);
    const clusterBefore = node.frames.filter((kind) => kind === 'gossip').length;

    node.scheduler.advance(999);

    // Time did pass on this node: the cluster pushed its nine rounds meanwhile.
    expect(node.frames.filter((kind) => kind === 'gossip').length - clusterBefore).toBe(9);
    expect(pushes(node)).toBe(receptionistBefore);
    node.scheduler.advance(1);
    expect(pushes(node)).toBe(receptionistBefore + 1);

    await stopNode(node);
  });

  test('an explicit option outranks the key', async () => {
    const node = await startNode('receptionist-config-explicit', 64_725,
      'actor-ts.cluster.receptionist.gossip-interval = 250ms');
    introducePeer(node, 64_726);
    const receptionistOptions = ReceptionistOptions.create().withGossipIntervalMs(500);
    await startReceptionist(node, receptionistOptions);
    const before = pushes(node);

    node.scheduler.advance(499);
    expect(pushes(node)).toBe(before);
    node.scheduler.advance(1);
    expect(pushes(node)).toBe(before + 1);
    node.scheduler.advance(500);
    expect(pushes(node)).toBe(before + 2);

    await stopNode(node);
  });
});
