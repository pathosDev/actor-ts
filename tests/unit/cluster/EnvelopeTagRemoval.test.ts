/**
 * `EnvelopeMessage.tag` on the wire (#1474).
 *
 * The envelope used to carry a `tag` — declared as "a class/type name for
 * richer routing", written by five senders and read by none.  Removing a wire
 * field as a hard cut has two sides, and they need opposite pins.
 *
 * **Outbound, it is gone — from every sender.**  The five converge on the
 * transport: each builds its envelope and hands it to `Cluster._sendEnvelope`,
 * which hands it to `Transport.send`.  So a transport that keeps a copy of
 * every frame, injected through `ClusterOptions.withTransport`, sees exactly
 * what goes on the wire, and two scenarios drive all five through it:
 * `RemoteActorRef.tell` and the pub-sub mediator's two publish frames, then
 * the singleton's three senders — the manager's hand-over request and answer,
 * a `ref()`-only node's answer, and the proxy's delivery.  Deleting the field
 * from the type already makes a literal `tag:` a compile error; this is what
 * catches one smuggled past the type (a cast, an `Object.assign`), and it runs
 * under `bun test`, which does not type-check.  Each scenario first asserts
 * that its senders did send, because an absence over no envelopes proves
 * nothing.  The compile-time half sits with the other deleted protocol surface
 * in `DeadProtocolSurface.test.ts`.
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
 * it either way.  That half is driven through the real `handleWire` →
 * `onEnvelope` → `dispatchEnvelope` path with a bare `InMemoryTransport`
 * standing in for the older node, the shape `UntrustedWireMode.test.ts` uses:
 * from `send` onwards nothing is a stub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import type { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Cluster } from '../../../src/cluster/Cluster.js';
import { ClusterOptions } from '../../../src/cluster/ClusterOptions.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import {
  encodeFrame,
  FrameDecoder,
  type EnvelopeMessage,
  type WireMessage,
} from '../../../src/cluster/Protocol.js';
import { DistributedPubSubId, Publish, Subscribe } from '../../../src/cluster/pubsub/index.js';
import { DistributedPubSubOptions } from '../../../src/cluster/pubsub/DistributedPubSubOptions.js';
import { RemoteActorRef } from '../../../src/cluster/RemoteActorRef.js';
import { StartSingletonOptions } from '../../../src/cluster/singleton/index.js';
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

/* ------------------------------ outbound ------------------------------ */

/** One frame a node handed its transport, and which node that was. */
type Sent = { readonly by: string; readonly message: WireMessage };

/** An envelope out of {@link Sent}, narrowed. */
type SentEnvelope = { readonly by: string; readonly message: EnvelopeMessage };

/** An `InMemoryTransport` that keeps a copy of every frame its node sends. */
class RecordingTransport extends InMemoryTransport {
  constructor(
    self: NodeAddress,
    private readonly sent: Sent[],
    private readonly label: string,
  ) {
    super(self);
  }

  override send(to: NodeAddress, message: WireMessage): void {
    this.sent.push({ by: this.label, message });
    super.send(to, message);
  }
}

type Member = { readonly system: ActorSystem; readonly cluster: Cluster };

async function startMember(
  systemName: string,
  port: number,
  seeds: readonly string[],
  sent: Sent[],
  label: string,
): Promise<Member> {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(systemName, systemOptions);
  systems.push(system);
  const clusterOptions = ClusterOptions.create()
    .withHost('h')
    .withPort(port)
    .withSeeds([...seeds])
    .withTransport(new RecordingTransport(new NodeAddress(systemName, 'h', port), sent, label))
    .withFailureDetector({ heartbeatIntervalMs: 50, unreachableAfterMs: 400, downAfterMs: 60_000 })
    .withGossipIntervalMs(60);
  const cluster = await Cluster.join(system, clusterOptions);
  clusters.push(cluster);
  return { system, cluster };
}

const bothUp = (a: Member, b: Member): Promise<void> => awaitCondition(
  () => a.cluster.upMembers().length === 2 && b.cluster.upMembers().length === 2,
  { timeoutMs: 5_000, label: 'both nodes are up' },
);

/**
 * Every field `EnvelopeMessage` declares.  Held to the type in both directions
 * below, so a field added there has to be added here — and a `tag` added back
 * still fails, on the explicit check in {@link envelopesCarryingNoTag}.
 */
const ENVELOPE_FIELDS = ['kind', 'to', 'from', 'body', 'context', 'trace'] as const;

type ListedEnvelopeField = (typeof ENVELOPE_FIELDS)[number];
type AssertNever<T extends never> = T;
type _NoUnlistedEnvelopeField = AssertNever<Exclude<keyof EnvelopeMessage, ListedEnvelopeField>>;
type _NoStaleEnvelopeField = AssertNever<Exclude<ListedEnvelopeField, keyof EnvelopeMessage>>;

/**
 * The envelopes among `sent`, once each has been checked twice — as the object
 * handed to the transport and as the frame `encodeFrame` makes of it — for a
 * `tag`, and for any field the type does not declare, since a renamed type
 * hint is the same dead field under another key.
 */
function envelopesCarryingNoTag(sent: readonly Sent[]): SentEnvelope[] {
  const envelopes = sent.filter((s): s is SentEnvelope => s.message.kind === 'envelope');
  const declared: readonly string[] = ENVELOPE_FIELDS;
  for (const { message } of envelopes) {
    const onTheWire = JSON.parse(new TextDecoder().decode(encodeFrame(message).subarray(4))) as object;
    for (const keys of [Object.keys(message), Object.keys(onTheWire)]) {
      expect(keys).not.toContain('tag');
      expect(keys.filter((key) => !declared.includes(key))).toEqual([]);
    }
  }
  return envelopes;
}

const bodyKind = (envelope: EnvelopeMessage): unknown =>
  (envelope.body as { kind?: unknown } | null)?.kind;

/** Records its own start and every message, prefixed with where it runs. */
class Marker extends Actor<string> {
  constructor(private readonly lifecycle: string[], private readonly where: string) { super(); }

  override preStart(): void { this.lifecycle.push(`${this.where}:started`); }

  override onReceive(message: string): void { this.lifecycle.push(`${this.where}:${message}`); }
}

describe('no envelope a node sends carries a tag (#1474)', () => {
  test('RemoteActorRef.tell and both pub-sub publish frames', async () => {
    const systemName = 'envelope-tag-outbound';
    const sent: Sent[] = [];
    const nodeA = await startMember(systemName, 54_751, [], sent, 'a');
    const nodeB = await startMember(systemName, 54_752, [`${systemName}@h:54751`], sent, 'b');
    await bothUp(nodeA, nodeB);

    // The sender that computed the tag — the constructor name, `"Object"` here.
    const inbox: unknown[] = [];
    const inboxRef = nodeA.system.spawn(() => new Recorder(inbox), 'inbox');
    new RemoteActorRef(nodeA.cluster.selfAddress, inboxRef.path.toString(), nodeB.cluster)
      .tell({ kind: 'note', text: 'across' });
    await awaitCondition(() => inbox.length === 1, {
      timeoutMs: 4_000,
      label: "B's remote tell reached A",
    });

    const pubsubOptions = DistributedPubSubOptions.create().withGossipIntervalMs(100);
    const mediatorA = nodeA.system.extension(DistributedPubSubId).start(nodeA.cluster, pubsubOptions);
    const mediatorB = nodeB.system.extension(DistributedPubSubId).start(nodeB.cluster, pubsubOptions);
    const news: unknown[] = [];
    mediatorA.tell(new Subscribe('news', nodeA.system.spawn(() => new Recorder(news), 'reader')));
    // Re-published on every poll until the subscription has crossed: before
    // that, B knows no remote subscriber and sends nothing.  A publish is a
    // `tell`, so what it delivers shows on a later poll, never on this one.
    await awaitCondition(() => {
      if (news.includes('to-all')) return true;
      mediatorB.tell(new Publish('news', 'to-all'));
      return false;
    }, { timeoutMs: 4_000, label: "B's broadcast publish reached the subscriber on A" });
    await awaitCondition(() => {
      if (news.includes('to-one')) return true;
      mediatorB.tell(new Publish('news', 'to-one', 'one-subscriber'));
      return false;
    }, { timeoutMs: 4_000, label: "B's anycast publish reached the subscriber on A" });

    const envelopes = envelopesCarryingNoTag(sent);
    // The positive control: each sender has to have sent, or the checks above
    // held over nothing.
    const fromB = envelopes.filter(({ by }) => by === 'b').map(({ message }) => message);
    expect(fromB.some((message) => message.to === inboxRef.path.toString())).toBe(true);
    expect(fromB.some((message) => bodyKind(message) === 'pubsub-publish')).toBe(true);
    expect(fromB.some((message) => bodyKind(message) === 'pubsub-publish-one')).toBe(true);
  }, 20_000);

  test("the singleton's three senders: the manager, a ref()-only node, the proxy", async () => {
    const systemName = 'envelope-tag-singleton';
    const sent: Sent[] = [];
    const lifecycle: string[] = [];
    const startOn = (member: Member, where: string, typeName: string): ActorRef<string> => {
      const singletonOptions = StartSingletonOptions.create<string>()
        .withTypeName(typeName)
        .withActor(() => new Marker(lifecycle, `${where}:${typeName}`));
      return member.cluster.singleton.start(singletonOptions);
    };

    // B first and alone, so B hosts `handed-over`; for `proxied-only` it only
    // takes a ref(), which claims the manager path with no manager behind it.
    const nodeB = await startMember(systemName, 54_762, [], sent, 'b');
    const proxyOnB = startOn(nodeB, 'b', 'handed-over');
    nodeB.cluster.singleton.ref<string>('proxied-only');
    await awaitCondition(() => lifecycle.includes('b:handed-over:started'), {
      timeoutMs: 4_000,
      label: 'B hosts handed-over',
    });

    // A joins below B and so becomes the host of both.  For `handed-over` its
    // manager asks B to stand down and B's manager answers; for `proxied-only`
    // B's extension answers with no manager at all.
    const nodeA = await startMember(systemName, 54_761, [`${systemName}@h:54762`], sent, 'a');
    await bothUp(nodeA, nodeB);
    startOn(nodeA, 'a', 'handed-over');
    startOn(nodeA, 'a', 'proxied-only');
    await awaitCondition(
      () => lifecycle.includes('a:handed-over:started') && lifecycle.includes('a:proxied-only:started'),
      { timeoutMs: 8_000, label: 'A hosts both singletons' },
    );

    // B's proxy now routes to the host on A.
    proxyOnB.tell('via-the-proxy');
    await awaitCondition(() => lifecycle.includes('a:handed-over:via-the-proxy'), {
      timeoutMs: 4_000,
      label: "B's proxy delivered to the host on A",
    });

    const envelopes = envelopesCarryingNoTag(sent);
    const sentHandOver = (by: string, kind: string, typeName: string): boolean => envelopes.some(
      (envelope) => envelope.by === by
        && bodyKind(envelope.message) === kind
        && (envelope.message.body as { typeName?: unknown }).typeName === typeName,
    );
    // The positive control, one line per sender.
    expect(sentHandOver('a', 'singleton.HandOverRequest', 'handed-over')).toBe(true);
    expect(sentHandOver('b', 'singleton.HandOverAcknowledgment', 'handed-over')).toBe(true);
    expect(sentHandOver('b', 'singleton.HandOverAcknowledgment', 'proxied-only')).toBe(true);
    expect(envelopes.some(({ by, message }) => by === 'b' && message.body === 'via-the-proxy')).toBe(true);
  }, 30_000);
});

/* ------------------------------ inbound ------------------------------- */

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
