/**
 * #717 AC-2 — the accept path is self-healing.
 *
 * `AcceptCommandUndroppable.test.ts` covers the half that is decided inside
 * the queue: no shedding policy may delete the command.  This file covers the
 * half that is not, and is the reason a "the queue cannot lose it" guarantee
 * was never the whole fix — everything past `postAcceptCommand` is the hub's
 * business, and a hub can fail to produce a connection actor without anything
 * throwing on the upgrade stack:
 *
 *   - it has **terminated**.  `ActorCell.postSignalEnvelope` dead-letters and
 *     returns normally, so `wireConnection`'s `catch` never runs and the
 *     socket is orphaned with its admission slot burned.  Synchronous, so it
 *     is answered synchronously.
 *   - it terminates, stalls or ignores the command **after** the send.  Not
 *     visible from the wiring layer at any instant, so it is answered by a
 *     watchdog: no `setListeners` inside `acceptTimeoutMs` and the socket is
 *     closed and the slot returned.
 *
 * Both leave the same wreck as an evicted accept did — an upgraded socket with
 * no listeners, a `maxConnections` slot nothing will ever release — which is
 * why the issue asks for them together.
 *
 * Refs #717.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { ManualScheduler } from '../../../../src/testkit/ManualScheduler.js';
import { gracefulStop } from '../../../../src/pattern/GracefulStop.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import { wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import { DEFAULT_WEBSOCKET_POLICY, type ResolvedWebsocketPolicy } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { jsonCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketListeners, WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import type { WebsocketConnection } from '../../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type In = { kind: 'ping' };
type Out = { kind: 'pong' };

const request: HttpRequest = {
  method: 'GET', path: '/ws', headers: {}, query: {}, params: {}, body: null,
};

/**
 * A socket that behaves like the real adapters in the one respect these tests
 * turn on: a close arriving before `setListeners` is **held** and replayed at
 * attach (#570), so an actor that spawns late still learns the connection is
 * gone.  `attachCount` separates the connection actor's attach from the no-op
 * one `wireConnection` performs when it gives up.
 */
class ProbeSocket implements WebsocketSocketAdapter {
  readyState: 0 | 1 | 2 | 3 = 1;
  attachCount = 0;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readonly received: Array<{ code: number; reason: string }> = [];
  remoteAddress = '127.0.0.1';
  private listeners: WebsocketListeners | null = null;
  private pendingClose: { code: number; reason: string } | null = null;

  send(): void { /* nothing outbound under test */ }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    const event = { code: code ?? 1000, reason: reason ?? '' };
    if (this.listeners) this.listeners.onClose(event.code, event.reason);
    else this.pendingClose = event;
  }
  setListeners(l: WebsocketListeners): void {
    this.attachCount += 1;
    this.listeners = {
      onMessage: (data) => l.onMessage(data),
      onClose: (code, reason) => { this.received.push({ code, reason }); l.onClose(code, reason); },
      onError: (error) => l.onError(error),
    };
    const pending = this.pendingClose;
    this.pendingClose = null;
    if (pending) this.listeners.onClose(pending.code, pending.reason);
  }
}

/**
 * A hub that reports what it saw, so "no actor spawned" is provable.
 *
 * The field is `observed`, not `log`: `Actor` already has a `log`, and a
 * private one here shadows it into a type nothing can spawn — `bun test`
 * transpiles without noticing and only `typecheck:dev` reports it.
 */
class RecordingHub extends WebsocketServerActor<Out, In> {
  constructor(private readonly observed: string[]) { super(); }
  onMessage(): void { /* no inbound frames here */ }
  protected override onClientConnected(connection: WebsocketConnection<Out>): void {
    this.observed.push(`connected:${connection.id}`);
  }
  protected override onClientDisconnected(): void {
    this.observed.push('disconnected');
  }
}

/**
 * A hub that stops draining until the test lets it, so the accept can be sent
 * and then left un-handled for as long as the watchdog needs.
 */
class ParkedHub extends RecordingHub {
  constructor(observed: string[], private readonly gate: Promise<void>) { super(observed); }
  override async onReceive(message: never): Promise<void> {
    await this.gate;
    await super.onReceive(message);
  }
}

const systems: ActorSystem[] = [];
const openGates: Array<() => void> = [];
afterEach(async () => {
  // Same reason as in AcceptCommandUndroppable: a parked hub cannot terminate
  // while it is awaiting inside a handler, so a test that fails before its own
  // `openGate()` would hang the file instead of reporting.
  for (const openGate of openGates.splice(0)) openGate();
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

function newSystem(name: string, scheduler?: ManualScheduler): ActorSystem {
  let systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (scheduler) systemOptions = systemOptions.withScheduler(scheduler);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  return system;
}

/* --------------------- (a) the hub has already stopped --------------------- */

describe('wireConnection — a stopped hub cannot orphan a socket (#717)', () => {
  test('an upgrade routed at a terminated hub is closed and gives its slot back', async () => {
    const system = newSystem('ws-accept-terminated-hub');
    const seen: string[] = [];
    const hub = system.spawn(() => new RecordingHub(seen), 'hub') as WebsocketServerRef<Out, In>;
    expect(await gracefulStop(hub, 4_000)).toBe(true);

    const policy: ResolvedWebsocketPolicy = { ...DEFAULT_WEBSOCKET_POLICY, maxConnections: 1 };
    const wire = (socket: ProbeSocket): void => {
      wireConnection<Out, In>(system, hub, request, socket, jsonCodec<Out, In>(), policy);
    };

    // Before the guard this returned normally: the envelope was dead-lettered,
    // nothing threw, and the socket stayed open forever with its slot taken.
    const first = new ProbeSocket();
    expect(() => wire(first)).not.toThrow();
    expect(first.closeCalls).toEqual([{ code: 1011, reason: 'connection setup failed' }]);

    // The slot is the half a `try/catch` could never have reached: the chained
    // release runs from `setListeners`, which no connection actor is going to
    // call.  A second upgrade must be refused for the same reason as the first
    // (1011, the hub is gone) and not for capacity (1013).
    const second = new ProbeSocket();
    wire(second);
    expect(second.closeCalls).toEqual([{ code: 1011, reason: 'connection setup failed' }]);
    expect(seen).toEqual([]);
  });
});

/* ------------------- (b) the hub never produces an actor ------------------- */

describe('wireConnection — the accept watchdog (#717)', () => {
  test('a hub that never spawns loses the socket and returns the slot', async () => {
    const scheduler = new ManualScheduler();
    const system = newSystem('ws-accept-watchdog', scheduler);
    const seen: string[] = [];
    let openGate = (): void => { /* replaced below */ };
    const gate = new Promise<void>((resolve) => { openGate = () => resolve(); });
    openGates.push(openGate);
    const hub = system.spawn(() => new ParkedHub(seen, gate), 'hub') as WebsocketServerRef<Out, In>;

    const policy: ResolvedWebsocketPolicy = {
      ...DEFAULT_WEBSOCKET_POLICY, maxConnections: 1, acceptTimeoutMs: 5_000,
    };
    const wire = (socket: ProbeSocket): void => {
      wireConnection<Out, In>(system, hub, request, socket, jsonCodec<Out, In>(), policy);
    };

    const stalled = new ProbeSocket();
    wire(stalled);
    // The hub took the command — nothing here is about delivery — it simply
    // never gets to it.
    expect(stalled.closeCalls).toEqual([]);

    // Just short of the deadline: still a live connection being set up, and
    // killing it here is exactly the "too short" failure the timeout has to
    // avoid.
    scheduler.advance(4_999);
    expect(stalled.closeCalls).toEqual([]);

    scheduler.advance(1);
    expect(stalled.closeCalls).toEqual([{ code: 1013, reason: 'connection setup timed out' }]);

    // And the slot came back with it: this second upgrade is admitted (it
    // reaches the hub and waits) rather than refused with 1013 'server at
    // capacity' by a cap the first connection burned permanently.
    const next = new ProbeSocket();
    wire(next);
    expect(next.closeCalls).toEqual([]);

    openGate();
    await awaitCondition(() => seen.length >= 1, {
      timeoutMs: 4_000,
      label: 'the un-parked hub drained the accepts it was holding',
    });
  });

  test('an actor that attaches after the deadline is told the connection is gone', async () => {
    const scheduler = new ManualScheduler();
    const system = newSystem('ws-accept-watchdog-late', scheduler);
    const seen: string[] = [];
    let openGate = (): void => { /* replaced below */ };
    const gate = new Promise<void>((resolve) => { openGate = () => resolve(); });
    openGates.push(openGate);
    const hub = system.spawn(() => new ParkedHub(seen, gate), 'hub') as WebsocketServerRef<Out, In>;

    const socket = new ProbeSocket();
    wireConnection<Out, In>(
      system, hub, request, socket, jsonCodec<Out, In>(),
      { ...DEFAULT_WEBSOCKET_POLICY, acceptTimeoutMs: 5_000 },
    );
    scheduler.advance(5_000);
    expect(socket.closeCalls).toEqual([{ code: 1013, reason: 'connection setup timed out' }]);

    // The race the watchdog cannot avoid: the hub drains one tick too late and
    // spawns the actor anyway.  It must be handed the close, not a socket the
    // framework already killed — otherwise it reports a connection that does
    // not exist and never hears a close event, because the real one was
    // consumed by the no-op listeners the watchdog attached.
    openGate();
    await awaitCondition(() => seen.includes('disconnected'), {
      timeoutMs: 4_000,
      label: 'the late connection actor stopped instead of holding a dead socket',
    });
    expect(seen.filter((entry) => entry === 'disconnected').length).toBe(1);
    // The socket saw exactly one attach — the watchdog's no-op listeners on
    // its way out.  The late actor's never reached it: the guard answered it
    // with the close instead, which is the whole point, and the socket is
    // closed once rather than twice.
    expect(socket.attachCount).toBe(1);
    expect(socket.closeCalls.length).toBe(1);
  });

  test('a connection that attaches in time disarms the watchdog', async () => {
    const scheduler = new ManualScheduler();
    const system = newSystem('ws-accept-watchdog-disarm', scheduler);
    const seen: string[] = [];
    const hub = system.spawn(() => new RecordingHub(seen), 'hub') as WebsocketServerRef<Out, In>;

    const socket = new ProbeSocket();
    wireConnection<Out, In>(
      system, hub, request, socket, jsonCodec<Out, In>(),
      { ...DEFAULT_WEBSOCKET_POLICY, acceptTimeoutMs: 5_000 },
    );
    await awaitCondition(() => seen.length === 1, {
      timeoutMs: 4_000,
      label: 'the connection actor spawned and reported itself connected',
    });

    // Far past the deadline.  A watchdog still armed here would close a
    // healthy connection, which is the one way this guard could be worse than
    // the leak it replaces.
    expect(scheduler.pendingCount).toBe(0);
    scheduler.advance(60_000);
    expect(socket.closeCalls).toEqual([]);
    expect(socket.readyState).toBe(1);
  });

  test('acceptTimeoutMs Infinity arms nothing', () => {
    const scheduler = new ManualScheduler();
    const system = newSystem('ws-accept-watchdog-off', scheduler);
    const seen: string[] = [];
    const hub = system.spawn(() => new RecordingHub(seen), 'hub') as WebsocketServerRef<Out, In>;

    wireConnection<Out, In>(
      system, hub, request, new ProbeSocket(), jsonCodec<Out, In>(),
      { ...DEFAULT_WEBSOCKET_POLICY, acceptTimeoutMs: Infinity },
    );
    expect(scheduler.pendingCount).toBe(0);
  });
});
