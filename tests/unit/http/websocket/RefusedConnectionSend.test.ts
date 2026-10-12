/**
 * One full connection cannot fail the hub that sends to it.
 *
 * A route may bound its connections with `connectionMailboxOverflow: 'reject'`
 * — the policy mirrors `ActorOptions` — and a full `reject` queue throws
 * `MailboxFullError` on the sender's stack.  For `reply` and `broadcast` the
 * sender is the hub, so one connection that had fallen behind threw out of the
 * hub's handler: the hub failed, its supervisor restarted it, and the restart
 * tore down every connection it had spawned.  `broadcast` also stopped at the
 * first refusal, so every client after the slow one missed the frame too.
 *
 * Both helpers now contain the refusal per connection: the frame is lost for
 * that connection alone, counted in `actor_mailbox_dropped_total` under the
 * connection actor's class with reason `drop-new` — what a `drop-new` bound
 * would have reported for the same frame — and the hub carries on.  Only the
 * refusal is contained: a connection whose `tell` fails for any other reason
 * still throws out of the helper, which the last test pins.  A `tell` the
 * application makes on a connection itself still throws on its own stack;
 * that is `reject` working as documented, and `CloseCommandUndroppable.test.ts`
 * pins it.
 *
 * **How a queue is held full.**  Each connection is bounded at one, and the
 * hub does everything in ONE turn of its own: a connection actor runs only
 * after the hub yields, so whatever the hub queued in that turn is still
 * queued when it sends the next frame.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { ActorPath } from '../../../../src/ActorPath.js';
import { ActorRef } from '../../../../src/ActorRef.js';
import type { ActorSystem } from '../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import { wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import type { WebsocketListeners, WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import type { WebsocketFrame, WebsocketUpgradeInfo } from '../../../../src/http/websocket/Types.js';
import { jsonCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketConnection } from '../../../../src/http/websocket/WebsocketConnection.js';
import { websocketConnectedSignal, type WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';
import { DEFAULT_WEBSOCKET_POLICY, type ResolvedWebsocketPolicy } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import type { MetricsRegistry } from '../../../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../../../src/metrics/MetricsExtension.js';
import { TestKit } from '../../../../src/testkit/TestKit.js';
import { TestKitOptions } from '../../../../src/testkit/TestKitOptions.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type FillOthersThenBroadcastMessage = { readonly kind: 'fill-others-then-broadcast' };
type ReplyTwiceMessage = { readonly kind: 'reply-twice' };
type BroadcastMessage = { readonly kind: 'broadcast'; readonly label: string };
type GuardedBroadcastMessage = { readonly kind: 'guarded-broadcast'; readonly label: string };
type In = FillOthersThenBroadcastMessage | ReplyTwiceMessage | BroadcastMessage | GuardedBroadcastMessage;
type Out = { readonly kind: 'frame'; readonly label: string };

/**
 * A connection whose `tell` fails for a reason that is not a full queue — the
 * shape of a defect, which the hub must not mistake for a refusal and swallow.
 */
class ExplodingConnection extends ActorRef<Out> implements WebsocketConnection<Out> {
  readonly path = new ActorPath('ws-conn-exploding', null, 'ws-refused');
  readonly id = 'exploding';
  readonly upgrade: WebsocketUpgradeInfo = { path: '/ws', params: {}, query: {}, headers: {} };
  readonly isOpen = true;
  override tell(): void { throw new Error('transport exploded'); }
  sendRaw(_frame: WebsocketFrame): void {}
  close(): void {}
  abort(): void {}
}

/** In-memory socket that records what was written and whether it was closed. */
class MockSocket implements WebsocketSocketAdapter {
  readyState: 0 | 1 | 2 | 3 = 1;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  remoteAddress = '127.0.0.1';
  private listeners: WebsocketListeners | null = null;
  private readonly pending: string[] = [];

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.listeners?.onClose(code ?? 1000, reason ?? '');
  }
  setListeners(l: WebsocketListeners): void {
    this.listeners = l;
    for (const data of this.pending.splice(0)) l.onMessage(data);
  }

  /** A frame from the client — held until the connection actor attaches, like a real adapter. */
  emit(message: In): void {
    const data = JSON.stringify(message);
    if (this.listeners === null) this.pending.push(data);
    else this.listeners.onMessage(data);
  }

  /** The labels of the frames written so far, in order. */
  get labels(): string[] {
    return this.sent.map((data) => (JSON.parse(data) as Out).label);
  }
}

type HubRecord = { starts: number; readonly connected: string[]; readonly errors: string[] };

class SendingHub extends WebsocketServerActor<Out, In> {
  constructor(private readonly record: HubRecord) {
    super();
  }

  override preStart(): void {
    this.record.starts += 1;
  }

  protected override onClientConnected(client: WebsocketConnection<Out>): void {
    this.record.connected.push(client.id);
  }

  onMessage(message: In): void {
    match(message)
      .with({ kind: 'fill-others-then-broadcast' }, () => this.onFillOthersThenBroadcast())
      .with({ kind: 'reply-twice' }, () => this.onReplyTwice())
      .with({ kind: 'broadcast' }, (m) => this.onBroadcast(m))
      .with({ kind: 'guarded-broadcast' }, (m) => this.onGuardedBroadcast(m))
      .exhaustive();
  }

  /** A broadcast whose caller records what escaped it, instead of failing on it. */
  private onGuardedBroadcast(message: GuardedBroadcastMessage): void {
    try {
      this.broadcast({ kind: 'frame', label: message.label });
    } catch (e) {
      this.record.errors.push(String(e));
    }
  }

  /**
   * Fill every other connection's queue to its capacity of one with a direct
   * `tell`, then broadcast: the others refuse the broadcast, the sender's own
   * connection — empty — takes it.
   */
  private onFillOthersThenBroadcast(): void {
    for (const client of this.clients.values()) {
      if (client.id !== this.connection.id) client.tell({ kind: 'frame', label: 'filler' });
    }
    this.broadcast({ kind: 'frame', label: 'news' });
  }

  /** The second reply meets the queue the first one filled. */
  private onReplyTwice(): void {
    this.reply({ kind: 'frame', label: 'first' });
    this.reply({ kind: 'frame', label: 'second' });
  }

  private onBroadcast(message: BroadcastMessage): void {
    this.broadcast({ kind: 'frame', label: message.label });
  }
}

const request: HttpRequest = {
  method: 'GET', path: '/ws', headers: {}, query: {}, params: {}, body: null,
};

/** Every connection bounded at one, refusing what does not fit. */
const REJECTING_POLICY: ResolvedWebsocketPolicy = {
  ...DEFAULT_WEBSOCKET_POLICY,
  connectionMailboxCapacity: 1,
  connectionMailboxOverflow: 'reject',
};

const kits: TestKit[] = [];
afterEach(async () => {
  await Promise.all(kits.splice(0).map((kit) => kit.system.terminate()));
});

type Harness = {
  readonly system: ActorSystem;
  readonly hub: WebsocketServerRef<Out, In>;
  readonly registry: MetricsRegistry;
  readonly record: HubRecord;
  /** Wire a client and wait until the hub has announced it. */
  readonly connect: () => Promise<MockSocket>;
};

function harness(name: string): Harness {
  const kit = TestKit.create(name, TestKitOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off));
  kits.push(kit);
  const registry = kit.system.extension(MetricsExtensionId).enable();
  const record: HubRecord = { starts: 0, connected: [], errors: [] };
  const hub = kit.system.spawn(() => new SendingHub(record), 'hub') as WebsocketServerRef<Out, In>;
  const connect = async (): Promise<MockSocket> => {
    const socket = new MockSocket();
    const before = record.connected.length;
    wireConnection<Out, In>(kit.system, hub, request, socket, jsonCodec<Out, In>(), REJECTING_POLICY);
    await awaitCondition(() => record.connected.length > before, {
      timeoutMs: 4_000,
      label: 'the hub announced the new connection',
    });
    return socket;
  };
  return { system: kit.system, hub, registry, record, connect };
}

/** Frames a full connection refused and the hub let go of, as the stock family counts them. */
function refusedFrames(registry: MetricsRegistry): number {
  return registry.collect()
    .filter((sample) => sample.name === 'actor_mailbox_dropped_total'
      && sample.labels['class'] === 'WebsocketConnectionActor'
      && sample.labels['reason'] === 'drop-new')
    .reduce((total, sample) => total + sample.value, 0);
}

describe("a connection that refuses a frame does not fail the hub ('reject')", () => {
  test('broadcast skips the full connection and still reaches the ones after it', async () => {
    const h = harness('ws-refused-broadcast');
    // Connected first, so `broadcast` meets the full connection before the
    // healthy one — the order in which an aborted loop would starve it.
    const slow = await h.connect();
    const sender = await h.connect();

    sender.emit({ kind: 'fill-others-then-broadcast' });
    await awaitCondition(() => sender.sent.length === 1 && slow.sent.length === 1, {
      timeoutMs: 4_000,
      label: 'the broadcast reached the sender and the filler reached the slow connection',
    });
    expect(sender.labels).toEqual(['news']);
    expect(slow.labels).toEqual(['filler']);
    expect(refusedFrames(h.registry)).toBe(1);

    // The hub is the same incarnation and still serving both.
    sender.emit({ kind: 'broadcast', label: 'after' });
    await awaitCondition(() => sender.sent.length === 2 && slow.sent.length === 2, {
      timeoutMs: 4_000,
      label: 'a later broadcast reached both connections',
    });
    expect(sender.labels).toEqual(['news', 'after']);
    expect(slow.labels).toEqual(['filler', 'after']);
    expect(h.record.starts).toBe(1);
    expect(slow.closeCalls).toEqual([]);
    expect(sender.closeCalls).toEqual([]);
  });

  test('a reply the connection cannot queue is dropped for that connection only', async () => {
    const h = harness('ws-refused-reply');
    const bystander = await h.connect();
    const sender = await h.connect();

    sender.emit({ kind: 'reply-twice' });
    await awaitCondition(() => sender.sent.length === 1, {
      timeoutMs: 4_000,
      label: 'the first reply was written',
    });
    expect(refusedFrames(h.registry)).toBe(1);

    sender.emit({ kind: 'broadcast', label: 'after' });
    await awaitCondition(() => sender.sent.length === 2 && bystander.sent.length === 1, {
      timeoutMs: 4_000,
      label: 'a later broadcast reached both connections',
    });
    expect(sender.labels).toEqual(['first', 'after']);
    expect(bystander.labels).toEqual(['after']);
    expect(h.record.starts).toBe(1);
    expect(bystander.closeCalls).toEqual([]);
    expect(sender.closeCalls).toEqual([]);
  });

  test('a failure that is not a refusal still reaches the caller, uncounted', async () => {
    const h = harness('ws-exploding-broadcast');
    const sender = await h.connect();
    h.hub.tell(websocketConnectedSignal<Out>(new ExplodingConnection()));
    await awaitCondition(() => h.record.connected.includes('exploding'), {
      timeoutMs: 4_000,
      label: 'the hub took the stand-in connection',
    });

    sender.emit({ kind: 'guarded-broadcast', label: 'news' });
    await awaitCondition(() => h.record.errors.length > 0, {
      timeoutMs: 4_000,
      label: 'the broadcast surfaced the failure to its caller',
    });
    expect(h.record.errors).toEqual(['Error: transport exploded']);
    expect(refusedFrames(h.registry)).toBe(0);
    expect(h.record.starts).toBe(1);
  });
});
