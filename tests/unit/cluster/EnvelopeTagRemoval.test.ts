/**
 * `EnvelopeMessage.tag` on the wire (#1474).
 *
 * The envelope used to carry a `tag` — declared as "a class/type name for
 * richer routing", written by five senders and read by none.  Removing a wire
 * field as a hard cut has two sides, and they need opposite pins.
 *
 * **Inbound, it is still tolerated.**  A node on an older release keeps
 * writing it: the constructor name on every `RemoteActorRef.tell` (`"Object"`
 * for any kind-discriminated message), `'Singleton'` on the three singleton
 * frames, `'PubSubPublish'` / `'PubSubPublishOne'` on the mediator's.  None of
 * that may become a protocol error — `wireFrameProblem` never read the field —
 * and the body has to arrive.  That is rolling-update tolerance on the wire,
 * not API compatibility, and it claims nothing about mixed versions beyond
 * itself: there is no protocol negotiation (#823), and what happens to the
 * unknown field after the decoder is #823's question, so nothing here asserts
 * it either way.
 *
 * Driven through the real `handleWire` → `onEnvelope` → `dispatchEnvelope`
 * path with a bare `InMemoryTransport` standing in for the older node, the
 * shape `UntrustedWireMode.test.ts` uses: from `send` onwards nothing is a stub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { FrameDecoder, type WireMessage } from '../../../src/cluster/Protocol.js';
import { InMemoryTransport } from '../../../src/cluster/Transport.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const systems: ActorSystem[] = [];
const clusters: Cluster[] = [];
const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.shutdown().catch(() => {})));
  await Promise.all(clusters.splice(0).map((c) => c.leave().catch(() => {})));
  await Promise.all(systems.splice(0).map((s) => s.terminate().catch(() => {})));
});

/** Records every body it was told, so an arrival is assertable. */
class Recorder extends Actor<unknown> {
  constructor(private readonly seen: unknown[]) { super(); }

  override onReceive(message: unknown): void { this.seen.push(message); }
}

/**
 * A frame as a node on an older release put it on the wire: JSON text with a
 * length prefix — not an `EnvelopeMessage` literal, whose type has no `tag` any
 * more — decoded by the same `FrameDecoder` a socket transport runs.
 */
function fromAnOlderRelease(frame: Record<string, unknown>): WireMessage {
  const payload = new TextEncoder().encode(JSON.stringify(frame));
  const bytes = new Uint8Array(4 + payload.byteLength);
  new DataView(bytes.buffer).setUint32(0, payload.byteLength, false);
  bytes.set(payload, 4);
  const decoded = new FrameDecoder().push(bytes);
  expect(decoded).toHaveLength(1);
  return decoded[0]!;
}

describe('an envelope from an older node that still carries tag (#1474)', () => {
  test("is accepted and its body delivered, on both of dispatchEnvelope's routes", async () => {
    const systemName = 'envelope-tag-legacy';
    const systemOptions = ActorSystemOptions.create()
      .withLogger(new NoopLogger())
      .withLogLevel(LogLevel.Off);
    const system = ActorSystem.create(systemName, systemOptions);
    systems.push(system);
    const inbox: unknown[] = [];
    const inboxRef = system.spawn(() => new Recorder(inbox), 'inbox');

    const self = new NodeAddress(systemName, 'h', 54_741);
    const clusterOptions = ClusterOptions.create()
      .withHost('h')
      .withPort(54_741)
      .withTransport(new InMemoryTransport(self));
    const cluster = await Cluster.join(system, clusterOptions);
    clusters.push(cluster);
    const framework: unknown[] = [];
    cluster._registerEnvelopeHandler('/cluster/pretend-extension', (envelope) => {
      framework.push(envelope.body);
    });

    const olderNode = new InMemoryTransport(new NodeAddress(systemName, 'h', 54_742));
    olderNode.setHandler(() => {});
    await olderNode.start();
    transports.push(olderNode);

    // Path resolution to a user actor: what an older `RemoteActorRef.tell` of a
    // kind-discriminated message sent — its constructor name, `"Object"`.
    olderNode.send(self, fromAnOlderRelease({
      kind: 'envelope',
      to: inboxRef.path.toString(),
      from: null,
      body: { kind: 'note', text: 'from an older node' },
      tag: 'Object',
    }));
    // A registered per-path handler, which is where the singleton, pub-sub and
    // sharding frames land — the three literal tags came from those senders.
    olderNode.send(self, fromAnOlderRelease({
      kind: 'envelope',
      to: '/cluster/pretend-extension',
      from: null,
      body: 'framework-traffic',
      tag: 'Singleton',
    }));

    await awaitCondition(() => inbox.length === 1 && framework.length === 1, {
      timeoutMs: 4_000,
      label: 'both frames from the older node were delivered',
    });
    expect(inbox).toEqual([{ kind: 'note', text: 'from an older node' }]);
    expect(framework).toEqual(['framework-traffic']);
  });
});
