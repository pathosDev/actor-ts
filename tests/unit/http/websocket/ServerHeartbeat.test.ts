/**
 * #651 — the server side of a WebSocket notices a peer that has gone without
 * a close frame, and a route can close connections that stay quiet.
 *
 * Before this, only the client had a heartbeat.  A peer that vanished — a
 * pulled cable, a sleeping laptop, a NAT that forgot the mapping — left a
 * socket nothing ever read from or wrote to again, and its connection actor,
 * its entry in the hub's `clients` and its `maxConnections` slot stayed for
 * the life of the process.
 *
 * Pinned here, on virtual time:
 *
 *   - a peer that answers no ping is dropped on the second tick — not on the
 *     first — the hub hears `1001 'heartbeat timeout'` as the server's, and
 *     the route's `maxConnections` slot comes back;
 *   - a peer that answers every ping stays, and so does one that sends frames
 *     but no pongs;
 *   - `heartbeatIntervalMs = 0` sends no ping at all;
 *   - a transport that cannot ping leaves the heartbeat off and warns once per
 *     route, not once per connection;
 *   - `idleTimeoutMs` closes with `1001 'idle timeout'` exactly that long
 *     after the last message, and a pong does not count as one;
 *   - a body that only spells a timer's kind does not act as the timer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import { wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import type { WebsocketListeners, WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import type { WebsocketCloseInfo } from '../../../../src/http/websocket/Types.js';
import { jsonCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketConnection } from '../../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';
import { DEFAULT_WEBSOCKET_POLICY, type ResolvedWebsocketPolicy } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import { LogLevel } from '../../../../src/Logger.js';
import type { LocalActorRef } from '../../../../src/internal/LocalActorRef.js';
import { ManualScheduler } from '../../../../src/testkit/ManualScheduler.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

type PingMessage = { readonly kind: 'ping'; readonly n: number };
type PongMessage = { readonly kind: 'pong'; readonly n: number };

/** How the fake peer treats a heartbeat ping. */
type PeerBehaviour = 'answers' | 'silent';

/** In-memory socket with a protocol ping, whose peer answers it or not. */
class HeartbeatSocket implements WebsocketSocketAdapter {
  readyState: 0 | 1 | 2 | 3 = 1;
  remoteAddress = '127.0.0.1';
  pings = 0;
  terminated = false;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private listeners: WebsocketListeners | null = null;
  /** Assigned in the constructor when the transport can ping, so `'ping' in socket` tells the two apart. */
  ping?: () => void;

  constructor(public behaviour: PeerBehaviour, canPing = true) {
    if (canPing) {
      this.ping = (): void => {
        this.pings += 1;
        if (this.behaviour === 'answers') this.listeners?.onPong?.();
      };
    }
  }

  /** Outbound frames written — the FIFO marker that a queued timer message was handled. */
  sent = 0;
  send(): void {
    this.sent += 1;
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.listeners?.onClose(code ?? 1000, reason ?? '');
  }
  terminate(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.terminated = true;
    this.listeners?.onClose(1006, '');
  }
  setListeners(l: WebsocketListeners): void {
    this.listeners = l;
  }
  emit(n: number): void {
    this.listeners?.onMessage(JSON.stringify({ kind: 'ping', n } satisfies PingMessage));
  }
  get attached(): boolean {
    return this.listeners !== null;
  }
}

type HubRecord = {
  readonly connected: Array<WebsocketConnection<PongMessage>>;
  readonly disconnected: Map<string, WebsocketCloseInfo>;
  readonly messages: number[];
};

class RecordingHub extends WebsocketServerActor<PongMessage, PingMessage> {
  constructor(private readonly record: HubRecord) {
    super();
  }
  onMessage(message: PingMessage): void {
    this.record.messages.push(message.n);
  }
  protected override onClientConnected(client: WebsocketConnection<PongMessage>): void {
    this.record.connected.push(client);
  }
  protected override onClientDisconnected(client: WebsocketConnection<PongMessage>, info: WebsocketCloseInfo): void {
    this.record.disconnected.set(client.id, info);
  }
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

const request: HttpRequest = { method: 'GET', path: '/ws', headers: {}, query: {}, params: {}, body: null };

type Harness = {
  readonly system: ActorSystem;
  readonly scheduler: ManualScheduler;
  readonly hub: WebsocketServerRef<PongMessage, PingMessage>;
  readonly record: HubRecord;
  readonly logger: RecordingLogger;
};

function newHarness(name: string): Harness {
  const scheduler = new ManualScheduler();
  const logger = new RecordingLogger(LogLevel.Debug);
  const systemOptions = ActorSystemOptions.create()
    .withLogger(logger)
    .withLogLevel(LogLevel.Debug)
    .withScheduler(scheduler);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  const record: HubRecord = { connected: [], disconnected: new Map(), messages: [] };
  const hub = system.spawn(() => new RecordingHub(record), 'hub');
  return { system, scheduler, hub, record, logger };
}

function policyWith(overrides: Partial<ResolvedWebsocketPolicy>): ResolvedWebsocketPolicy {
  return { ...DEFAULT_WEBSOCKET_POLICY, ...overrides };
}

/** Wire `socket` and wait until the hub has it; returns the connection. */
async function connect(
  h: Harness,
  socket: HeartbeatSocket,
  policy: ResolvedWebsocketPolicy,
): Promise<WebsocketConnection<PongMessage>> {
  const before = h.record.connected.length;
  wireConnection<PongMessage, PingMessage>(h.system, h.hub, request, socket, jsonCodec<PongMessage, PingMessage>(), policy);
  await awaitCondition(() => h.record.connected.length > before && socket.attached, {
    timeoutMs: 4_000,
    label: 'the hub announced the connection',
  });
  const connection = h.record.connected[h.record.connected.length - 1]!;
  // Checked before any virtual time passes, on every connection: a heartbeat
  // armed at interval 0 is a 0 ms fixed-delay timer, which the first
  // `advance` would spin on forever — so a wrongly armed timer has to fail
  // here, on an assertion, not later as a hang.
  const expectArmed = policy.heartbeatIntervalMs > 0 && socket.ping !== undefined;
  expect(heartbeatArmed(connection)).toBe(expectArmed);
  return connection;
}

/** Whether the connection actor behind `connection` has its heartbeat timer running. */
function heartbeatArmed(connection: WebsocketConnection<PongMessage>): boolean {
  const actor = (connection as unknown as { connectionRef: LocalActorRef<unknown> }).connectionRef;
  return actor.getCell().timers.isTimerActive('websocket-heartbeat');
}

/**
 * Advance virtual time and let the connection actor handle what fired.
 * The timer only enqueues the tick; the actor runs it on a later turn, so the
 * wait is on the observable the tick should produce — and for a tick that
 * should change nothing, on the ping count it does change.
 */
async function tick(h: Harness, ms: number, settled: () => boolean, label: string): Promise<void> {
  h.scheduler.advance(ms);
  await awaitCondition(settled, { timeoutMs: 4_000, label });
}

describe('server heartbeat (#651)', () => {
  test('a peer that answers no ping is dropped on the second tick, and its slot comes back', async () => {
    const h = newHarness('heartbeat-silent');
    const policy = policyWith({ heartbeatIntervalMs: 1_000, maxConnections: 1 });
    const socket = new HeartbeatSocket('silent');
    const connection = await connect(h, socket, policy);

    await tick(h, 1_000, () => socket.pings === 1, 'the first ping went out');
    // One unanswered interval is not yet a verdict.
    expect(socket.terminated).toBe(false);
    expect(connection.isOpen).toBe(true);

    await tick(h, 1_000, () => h.record.disconnected.has(connection.id), 'the silent peer was dropped');
    expect(socket.terminated).toBe(true);
    expect(socket.closeCalls).toEqual([]);
    expect(socket.pings).toBe(1);
    expect(h.record.disconnected.get(connection.id)).toEqual({
      code: 1001, reason: 'heartbeat timeout', initiatedBy: 'server',
    });

    // The route admits one connection; the reaped one gave its slot back.
    const next = new HeartbeatSocket('answers');
    await connect(h, next, policy);
    expect(next.closeCalls).toEqual([]);
  });

  test('a peer that answers every ping stays connected', async () => {
    const h = newHarness('heartbeat-answers');
    const policy = policyWith({ heartbeatIntervalMs: 1_000 });
    const socket = new HeartbeatSocket('answers');
    const connection = await connect(h, socket, policy);

    for (let n = 1; n <= 5; n++) await tick(h, 1_000, () => socket.pings === n, `ping ${n} went out`);
    expect(socket.terminated).toBe(false);
    expect(socket.closeCalls).toEqual([]);
    expect(h.record.disconnected.has(connection.id)).toBe(false);
  });

  test('a peer that sends frames but no pongs stays connected — any frame is proof of life', async () => {
    const h = newHarness('heartbeat-frames');
    const policy = policyWith({ heartbeatIntervalMs: 1_000 });
    const socket = new HeartbeatSocket('silent');
    const connection = await connect(h, socket, policy);

    for (let n = 1; n <= 4; n++) {
      await tick(h, 1_000, () => socket.pings === n, `ping ${n} went out`);
      socket.emit(n);
    }
    expect(socket.terminated).toBe(false);
    expect(h.record.disconnected.has(connection.id)).toBe(false);
  });

  test('a heartbeat interval of 0 starts no heartbeat timer', async () => {
    // No time passes here at all: the timer's absence is the assertion.
    const h = newHarness('heartbeat-off-timer');
    const socket = new HeartbeatSocket('silent');
    const connection = await connect(h, socket, policyWith({ heartbeatIntervalMs: 0 }));
    expect(heartbeatArmed(connection)).toBe(false);
    expect(socket.pings).toBe(0);
  });

  test('a heartbeat interval of 0 sends no ping', async () => {
    const h = newHarness('heartbeat-off');
    const policy = policyWith({ heartbeatIntervalMs: 0 });
    const socket = new HeartbeatSocket('silent');
    const connection = await connect(h, socket, policy);
    // A second connection on a running heartbeat, as the clock to wait on.
    const witness = new HeartbeatSocket('answers');
    await connect(h, witness, policyWith({ heartbeatIntervalMs: 1_000 }));

    for (let n = 1; n <= 3; n++) await tick(h, 1_000, () => witness.pings === n, `witness ping ${n}`);
    expect(socket.pings).toBe(0);
    expect(socket.terminated).toBe(false);
    expect(h.record.disconnected.has(connection.id)).toBe(false);
  });

  test('a transport that cannot ping leaves the heartbeat off and warns once per route', async () => {
    const h = newHarness('heartbeat-unsupported');
    const policy = policyWith({ heartbeatIntervalMs: 1_000 });
    const first = new HeartbeatSocket('silent', false);
    const second = new HeartbeatSocket('silent', false);
    const a = await connect(h, first, policy);
    const b = await connect(h, second, policy);
    const witness = new HeartbeatSocket('answers');
    await connect(h, witness, policy);

    for (let n = 1; n <= 3; n++) await tick(h, 1_000, () => witness.pings === n, `witness ping ${n}`);
    expect(first.terminated || second.terminated).toBe(false);
    expect(h.record.disconnected.has(a.id) || h.record.disconnected.has(b.id)).toBe(false);
    const warnings = h.logger.records.filter((r) => r.level === 'warn' && r.message.includes('heartbeat-interval'));
    expect(warnings).toHaveLength(1);
  });

  test('a body that only spells the heartbeat tick does not act as one', async () => {
    const h = newHarness('heartbeat-forged');
    const policy = policyWith({ heartbeatIntervalMs: 1_000 });
    const socket = new HeartbeatSocket('silent');
    const connection = await connect(h, socket, policy);
    const actor = (connection as unknown as { connectionRef: ActorRef<unknown> }).connectionRef;

    actor.tell({ kind: 'heartbeat-tick' });
    actor.tell({ kind: 'heartbeat-tick' });
    actor.tell({ kind: 'idle-check' });
    // The real first tick still finds no ping outstanding: the forgeries sent none.
    await tick(h, 1_000, () => socket.pings === 1, 'the first real ping went out');
    expect(socket.terminated).toBe(false);
    expect(h.record.disconnected.has(connection.id)).toBe(false);
  });
});

describe('server idle timeout (#651)', () => {
  test('closes 1001 exactly the timeout after the last message', async () => {
    const h = newHarness('idle-exact');
    const policy = policyWith({ heartbeatIntervalMs: 0, idleTimeoutMs: 1_000 });
    const socket = new HeartbeatSocket('silent');
    const connection = await connect(h, socket, policy);

    h.scheduler.advance(600);
    socket.emit(1);
    await awaitCondition(() => h.record.messages.length === 1, { timeoutMs: 4_000, label: 'the frame reached the hub' });
    // The first check comes due at 1000 and finds 400 ms of quiet: it re-arms.
    h.scheduler.advance(400);
    h.scheduler.advance(599);
    // A frame queued behind whatever the timers fired: once it is written,
    // every check due by 1599 has been handled, so a wrongly-early close
    // would already show.
    connection.tell({ kind: 'pong', n: 0 });
    await awaitCondition(() => socket.sent === 1, { timeoutMs: 4_000, label: 'the marker frame was written' });
    expect(socket.closeCalls).toEqual([]);

    await tick(h, 1, () => h.record.disconnected.has(connection.id), 'the quiet connection was closed');
    expect(socket.closeCalls).toEqual([{ code: 1001, reason: 'idle timeout' }]);
    expect(h.record.disconnected.get(connection.id)).toEqual({
      code: 1001, reason: 'idle timeout', initiatedBy: 'server',
    });
  });

  test('a pong is not a message: a peer that only answers pings is closed as idle', async () => {
    const h = newHarness('idle-pongs');
    const policy = policyWith({ heartbeatIntervalMs: 400, idleTimeoutMs: 1_000 });
    const socket = new HeartbeatSocket('answers');
    const connection = await connect(h, socket, policy);

    await tick(h, 400, () => socket.pings === 1, 'ping 1');
    await tick(h, 400, () => socket.pings === 2, 'ping 2');
    await tick(h, 200, () => h.record.disconnected.has(connection.id), 'the idle connection was closed');
    expect(socket.closeCalls).toEqual([{ code: 1001, reason: 'idle timeout' }]);
    expect(socket.terminated).toBe(false);
  });

  test('an idle timeout of 0 never closes', async () => {
    const h = newHarness('idle-off');
    const policy = policyWith({ heartbeatIntervalMs: 1_000, idleTimeoutMs: 0 });
    const socket = new HeartbeatSocket('answers');
    const connection = await connect(h, socket, policy);
    for (let n = 1; n <= 5; n++) await tick(h, 1_000, () => socket.pings === n, `ping ${n}`);
    expect(socket.closeCalls).toEqual([]);
    expect(h.record.disconnected.has(connection.id)).toBe(false);
  });
});
