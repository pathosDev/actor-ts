/**
 * #986 — a connection that went away leaves the hub's `clients`, and its
 * `onClientDisconnected` runs, whatever the hub's queue does to its traffic.
 *
 * The `disconnected` signal is the only thing that takes a client out of
 * `clients`.  It used to be a plain `hub.tell` from the connection actor's
 * `postStop`, so every way a hub sheds user traffic shed it too: a bound under
 * a frame flood, and a `throttle({ onExcess: 'drop' })` with no bound at all.
 * The entry stayed for the life of the process, every `broadcast` walked it,
 * and the application never heard the client leave.  The `connected` signal had
 * the same door and the same fate under a throttle — a client served without
 * ever appearing in `clients`.
 *
 * Pinned here:
 *
 *   - under a bounded hub, a flood that is shed around a queued `disconnected`
 *     does not shed it;
 *   - under a dropping throttle, `connected` and `disconnected` both arrive;
 *   - a `disconnected` lost anyway — a mailbox of the caller's own that drops
 *     it at both doors — is made good once the connection actor has stopped:
 *     the hub reaps the entry, runs `onClientDisconnected`, and warns;
 *   - a healthy disconnect runs the hook exactly once, the reaper adding
 *     nothing;
 *   - a body that only spells the reaper's notice evicts nobody.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorOptions } from '../../../../src/ActorOptions.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import { wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import type { WebsocketListeners, WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import type { WebsocketCloseInfo } from '../../../../src/http/websocket/Types.js';
import { jsonCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketConnection } from '../../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketServerMessage, WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';
import { DEFAULT_WEBSOCKET_POLICY } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import { LogLevel } from '../../../../src/Logger.js';
import type { LocalActorRef } from '../../../../src/internal/LocalActorRef.js';
import { Mailbox, type Envelope } from '../../../../src/internal/Mailbox.js';
import { ControlAwareMailbox } from '../../../../src/mailbox/ControlAwareMailbox.js';
import { ThrottleOptions } from '../../../../src/ThrottleOptions.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

type PingMessage = { readonly kind: 'ping'; readonly n: number };
type PongMessage = { readonly kind: 'pong'; readonly n: number };
type HubMessage = WebsocketServerMessage<PongMessage, PingMessage>;

/** In-memory socket: buffers inbound frames until the connection actor attaches. */
class MockSocket implements WebsocketSocketAdapter {
  readyState: 0 | 1 | 2 | 3 = 1;
  remoteAddress = '127.0.0.1';
  private listeners: WebsocketListeners | null = null;
  private readonly pending: Array<(l: WebsocketListeners) => void> = [];

  send(): void { /* nothing under test writes outbound */ }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.deliver((l) => l.onClose(code ?? 1000, reason ?? ''));
  }
  setListeners(l: WebsocketListeners): void {
    this.listeners = l;
    for (const callback of this.pending.splice(0)) callback(l);
  }
  emit(n: number): void {
    const data = JSON.stringify({ kind: 'ping', n } satisfies PingMessage);
    this.deliver((l) => l.onMessage(data));
  }
  hangUp(): void {
    this.readyState = 3;
    this.deliver((l) => l.onClose(1000, 'bye'));
  }
  private deliver(callback: (l: WebsocketListeners) => void): void {
    if (this.listeners !== null) callback(this.listeners);
    else this.pending.push(callback);
  }
}

/** What the hub did, owned by the test. */
type HubRecord = {
  readonly events: string[];
  readonly disconnectInfo: Map<string, WebsocketCloseInfo>;
  parkNext: boolean;
  parked: boolean;
  readonly gate: Promise<void>;
  /** Reads `clients` straight off the hub — no message, so neither a bound nor a throttle sits between. */
  clients: () => string[];
};

class RecordingHub extends WebsocketServerActor<PongMessage, PingMessage> {
  constructor(private readonly record: HubRecord, private readonly throttled: boolean) {
    super();
  }

  override preStart(): void {
    this.record.clients = () => [...this.clients.keys()];
    if (this.throttled) {
      // One token, and a refill nobody waits for: everything past the first
      // user message is dropped.
      const throttleOptions = ThrottleOptions.create()
        .withQps(0.001)
        .withBurst(1)
        .withOnExcess('drop');
      this.context.throttle(throttleOptions);
    }
  }

  async onMessage(message: PingMessage): Promise<void> {
    if (this.record.parkNext) {
      this.record.parkNext = false;
      this.record.parked = true;
      await this.record.gate;
      this.record.parked = false;
    }
    this.record.events.push(`message:${this.connection.id}:${message.n}`);
  }

  protected override onClientConnected(client: WebsocketConnection<PongMessage>): void {
    this.record.events.push(`connected:${client.id}`);
  }

  protected override onClientDisconnected(client: WebsocketConnection<PongMessage>, info: WebsocketCloseInfo): void {
    this.record.events.push(`disconnected:${client.id}`);
    this.record.disconnectInfo.set(client.id, info);
  }
}

/**
 * A caller's own mailbox that loses every `disconnected`, through either door —
 * a stand-in for any loss the framework cannot see from the hub's side.
 */
class LosingMailbox extends Mailbox<HubMessage> {
  override enqueue(envelope: Envelope<HubMessage>): void {
    if ((envelope.message as { kind?: unknown }).kind === 'websocket-disconnected') return;
    super.enqueue(envelope);
  }
}

const systems: ActorSystem[] = [];
const openGates: Array<() => void> = [];
afterEach(async () => {
  for (const open of openGates.splice(0)) open();
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

const request: HttpRequest = {
  method: 'GET', path: '/ws', headers: {}, query: {}, params: {}, body: null,
};

type HubHarness = {
  readonly system: ActorSystem;
  readonly hub: WebsocketServerRef<PongMessage, PingMessage>;
  readonly record: HubRecord;
  readonly logger: RecordingLogger;
  readonly openGate: () => void;
};

function spawnHub(name: string, options?: ActorOptions<HubMessage>, throttled = false): HubHarness {
  const logger = new RecordingLogger(LogLevel.Debug);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Debug);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  let openGate = (): void => { /* replaced below */ };
  const opened = new Promise<void>((resolve) => { openGate = () => resolve(); });
  openGates.push(openGate);
  const record: HubRecord = {
    events: [], disconnectInfo: new Map(), parkNext: false, parked: false, gate: opened, clients: () => [],
  };
  const hub = system.spawn(() => new RecordingHub(record, throttled), 'hub', options);
  return { system, hub, record, logger, openGate };
}

function wire(h: HubHarness): MockSocket {
  const socket = new MockSocket();
  wireConnection<PongMessage, PingMessage>(
    h.system, h.hub, request, socket, jsonCodec<PongMessage, PingMessage>(), DEFAULT_WEBSOCKET_POLICY,
  );
  return socket;
}

async function connect(h: HubHarness): Promise<{ socket: MockSocket; id: string }> {
  const before = h.record.events.filter((event) => event.startsWith('connected:')).length;
  const socket = wire(h);
  await awaitCondition(
    () => h.record.events.filter((event) => event.startsWith('connected:')).length > before,
    { timeoutMs: 4_000, label: 'the hub announced the new connection' },
  );
  const connected = h.record.events.filter((event) => event.startsWith('connected:'));
  return { socket, id: connected[connected.length - 1]!.slice('connected:'.length) };
}

function cellOf(h: HubHarness): ReturnType<LocalActorRef<HubMessage>['getCell']> {
  return (h.hub as LocalActorRef<HubMessage>).getCell();
}

describe('a client that went away leaves the hub, whatever its queue sheds (#986)', () => {
  test('under a bound, a flood shed around a queued disconnected does not shed it', async () => {
    const h = spawnHub('hub-lifecycle-bound', ActorOptions.create<HubMessage>().withMailboxCapacity(4));
    const x = await connect(h);
    const victim = await connect(h);
    expect(cellOf(h)._mailboxForTest()).toBeInstanceOf(ControlAwareMailbox);

    h.record.parkNext = true;
    x.socket.emit(0);
    await awaitCondition(() => h.record.parked, { timeoutMs: 4_000, label: 'the hub parked inside onMessage' });
    victim.socket.hangUp();
    // Its `disconnected`, then the hub's stop notice for its actor.
    await awaitCondition(() => cellOf(h).mailboxSize === 2, {
      timeoutMs: 4_000,
      label: "the victim's disconnected was queued",
    });
    for (let n = 1; n <= 60; n++) x.socket.emit(n);
    expect((cellOf(h)._mailboxForTest() as ControlAwareMailbox<HubMessage>).droppedCount).toBeGreaterThan(0);
    h.openGate();

    await awaitCondition(() => h.record.events.includes(`disconnected:${victim.id}`), {
      timeoutMs: 4_000,
      label: 'the victim was reported disconnected',
    });
    await awaitCondition(() => cellOf(h).mailboxSize === 0, { timeoutMs: 4_000, label: 'the hub drained' });
    expect(h.record.clients()).toEqual([x.id]);
    expect(h.record.disconnectInfo.get(victim.id)).toEqual({ code: 1000, reason: 'bye', initiatedBy: 'client' });
    // Once, from the signal itself — the stop notice queued behind it found
    // nothing left to reap.
    expect(h.record.events.filter((event) => event === `disconnected:${victim.id}`)).toHaveLength(1);
    expect(h.logger.records.filter((r) => r.level === 'warn')).toEqual([]);
  });

  test('under a dropping throttle, connected and disconnected both arrive', async () => {
    const h = spawnHub('hub-lifecycle-throttle', undefined, true);
    const x = wire(h);
    // The one token goes to whatever user message comes first; nothing refills it.
    await awaitCondition(() => h.record.events.length >= 1, { timeoutMs: 4_000, label: 'the hub handled something' });
    x.emit(1);
    x.emit(2);
    const y = wire(h);
    await awaitCondition(() => h.record.events.filter((event) => event.startsWith('connected:')).length === 2, {
      timeoutMs: 4_000,
      label: 'both clients were connected',
    });
    expect(h.record.clients()).toHaveLength(2);
    x.hangUp();
    y.hangUp();
    await awaitCondition(() => h.record.events.filter((event) => event.startsWith('disconnected:')).length === 2, {
      timeoutMs: 4_000,
      label: 'both clients were reported disconnected',
    });
    expect(h.record.clients()).toEqual([]);
  });

  test('a disconnected lost anyway is reaped once the connection actor has stopped', async () => {
    const h = spawnHub('hub-lifecycle-reaper', ActorOptions.create<HubMessage>().withMailbox(() => new LosingMailbox()));
    const x = await connect(h);
    const victim = await connect(h);
    victim.socket.hangUp();

    await awaitCondition(() => h.record.events.includes(`disconnected:${victim.id}`), {
      timeoutMs: 4_000,
      label: 'the lost disconnect was made good',
    });
    expect(h.record.clients()).toEqual([x.id]);
    expect(h.record.disconnectInfo.get(victim.id)).toEqual({ code: 1006, reason: '', initiatedBy: 'error' });
    expect(h.logger.records.some((r) => r.level === 'warn' && r.message.includes(victim.id))).toBe(true);
  });

  test('a healthy disconnect runs the hook exactly once', async () => {
    const h = spawnHub('hub-lifecycle-once');
    const x = await connect(h);
    x.socket.emit(1);
    x.socket.hangUp();
    await awaitCondition(() => h.record.events.includes(`disconnected:${x.id}`), {
      timeoutMs: 4_000,
      label: 'the client was reported disconnected',
    });
    // Let the stop notice that follows the disconnect reach the hub, too.
    const probe = await connect(h);
    probe.socket.hangUp();
    await awaitCondition(() => h.record.events.includes(`disconnected:${probe.id}`), {
      timeoutMs: 4_000,
      label: 'the probe was reported disconnected',
    });
    await awaitCondition(() => cellOf(h).mailboxSize === 0, { timeoutMs: 4_000, label: 'the hub drained' });
    expect(h.record.events.filter((event) => event === `disconnected:${x.id}`)).toHaveLength(1);
    expect(h.record.events).toEqual([
      `connected:${x.id}`,
      `message:${x.id}:1`,
      `disconnected:${x.id}`,
      `connected:${probe.id}`,
      `disconnected:${probe.id}`,
    ]);
    expect(h.logger.records.filter((r) => r.level === 'warn')).toEqual([]);
  });

  test('a body that only spells the stop notice evicts nobody', async () => {
    const h = spawnHub('hub-lifecycle-forged');
    const x = await connect(h);
    (h.hub as ActorRef<unknown>).tell({ kind: 'websocket-connection-stopped', id: x.id });
    (h.hub as ActorRef<unknown>).tell({ kind: 'websocket-connection-stopped', id: x.id, connection: x });
    // The default `onSelfMessage` declines each with a warn — so both were handled.
    await awaitCondition(
      () => h.logger.records.filter((r) => r.level === 'warn' && r.message.includes('unhandled self message')).length === 2,
      { timeoutMs: 4_000, label: 'the hub declined both forgeries' },
    );
    expect(h.record.clients()).toEqual([x.id]);
    expect(h.record.events).toEqual([`connected:${x.id}`]);
  });
});
