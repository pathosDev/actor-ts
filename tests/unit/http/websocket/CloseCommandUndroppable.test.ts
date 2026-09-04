/**
 * #985 — a bounded WebSocket connection may not lose the command that closes
 * its socket.
 *
 * `WebsocketConnection.close()` used to be an ordinary user `tell` into the
 * per-connection actor's mailbox — the same queue every outbound frame uses.
 * A bound on that queue destroyed it in three different ways: `drop-head`
 * evicted it as the oldest entry, `drop-new` discarded it on arrival, and
 * `reject` threw `MailboxFullError` out of `close()` on the caller's stack,
 * which for `closeAll()` aborted the loop on the first backlogged client and
 * left every later one connected.  What is lost there is not a message but a
 * decision about a socket: nothing retries, and a `closeAll(1008, …)` that
 * returns normally while the peers stay connected is a control that silently
 * did nothing.
 *
 * Not reachable under the shipped configuration.  #1148 made the unbounded
 * mailbox the default again, and this actor is spawned with no `ActorOptions`
 * at all (`WebsocketServerActor.onWebsocketAccept`), so no public API can
 * bound it — these tests spawn the connection actor themselves to set the
 * bound.  The defect is one global default capacity away from applying to
 * every connection in a process at once (#862), which is why the door is shut
 * now rather than when it opens.
 *
 * The fix reuses #729's seam, exactly as `websocket-accept` does (#717): the
 * command goes through `ActorCell.postSignalEnvelope`, so it carries
 * `Envelope.undroppable` and takes `Mailbox.enqueueSignal`.
 *
 * **How the queue is held at capacity.**  Not by parking the actor —
 * `WebsocketConnectionActor.onReceive` is synchronous and cannot await.  Every
 * burst below is issued inside ONE synchronous tick instead: `tell` enqueues
 * on the caller's stack and only *schedules* a drain (`ActorCell.schedule` →
 * `Dispatcher.execute`, a microtask or `setImmediate`), so nothing is dequeued
 * until the test yields.
 *
 * Refs #717, #729, #862, #985, #1148.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { ActorOptions } from '../../../../src/ActorOptions.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { MailboxFullError } from '../../../../src/mailbox/DroppingMailbox.js';
import { WebsocketReadyState, type WebsocketListeners, type WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import { WebsocketConnectionActor } from '../../../../src/http/websocket/WebsocketConnectionActor.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import { jsonCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import { DEFAULT_WEBSOCKET_POLICY } from '../../../../src/http/websocket/WebsocketPolicy.js';
import type { WebsocketConnection, WebsocketOutboundCommand } from '../../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketServerMessage, WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';
import type { WebsocketUpgradeInfo } from '../../../../src/http/websocket/Types.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type In = { kind: 'ping'; n: number };
type Out = { kind: 'pong'; n: number };

/**
 * Ask the hub to broadcast one frame and then close every client — the
 * `closeAll()` shape, on the hub's own stack.
 *
 * Both halves in ONE hub turn on purpose.  Filling the connection queues from
 * the test instead would prove nothing: the connection actors drain on the
 * dispatcher, and by the time a separately-told `closeAll` reached the hub
 * their queues were empty again, so `closeAll` never met the bound at all.
 */
type KickCommand = { readonly kind: 'kick'; readonly code: number; readonly reason: string };
/** Ask the hub to run a `broadcast` whose filter only records who was selected. */
type ProbeBroadcastCommand = { readonly kind: 'probe-broadcast' };
type HubCommand = KickCommand | ProbeBroadcastCommand;

type HubMessage = WebsocketServerMessage<Out, In, HubCommand>;
type ConnectionMessage = WebsocketOutboundCommand<Out>;

/** How many frames one burst offers the queue.  Comfortably above capacity 1. */
const BURST = 6;

/**
 * Minimal socket adapter.  `closeCalls` is what every test here turns on, and
 * `sent` is the control: it says how much of a burst the bound let through, so
 * a capacity that stopped biting shows up as a frame count instead of passing
 * silently.
 */
class ProbeSocket implements WebsocketSocketAdapter {
  readyState: 0 | 1 | 2 | 3 = WebsocketReadyState.OPEN;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  readonly sent: Array<string | Uint8Array> = [];
  remoteAddress = '127.0.0.1';
  private listeners: WebsocketListeners | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === WebsocketReadyState.CLOSED) return;
    this.readyState = WebsocketReadyState.CLOSED;
    this.closeCalls.push({ code, reason });
    this.listeners?.onClose(code ?? 1000, reason ?? '');
  }
  setListeners(listeners: WebsocketListeners): void {
    this.listeners = listeners;
  }
}

/** What the test reads back out of the hub. */
type HubState = {
  /** Connections the hub has seen through `onClientConnected`. */
  readonly connections: Map<string, WebsocketConnection<Out>>;
  /** Ids `broadcast` selected — i.e. the ones whose `isOpen` read `true`. */
  readonly broadcastSelected: string[];
};

/**
 * A hub that records its clients and exposes `closeAll` / `broadcast` through
 * self messages, so both run on the hub's own stack the way real code does.
 */
class RecordingHub extends WebsocketServerActor<Out, In, HubCommand> {
  constructor(private readonly state: HubState) {
    super();
  }

  onMessage(): void { /* no inbound frame is emitted in these tests */ }

  protected override onClientConnected(client: WebsocketConnection<Out>): void {
    this.state.connections.set(client.id, client);
  }

  protected override onSelfMessage(command: HubCommand): void {
    match(command)
      .with({ kind: 'kick' }, (c) => this.onKick(c))
      .with({ kind: 'probe-broadcast' }, () => this.onProbeBroadcast())
      .exhaustive();
  }

  private onKick(command: KickCommand): void {
    // One frame to each client first, so a capacity-1 queue is exactly full
    // when `closeAll` reaches it — a hub mid-broadcast that decides to
    // disconnect everyone.  Nothing drains between these two statements.
    this.broadcast({ kind: 'pong', n: 0 });
    this.closeAll(command.code, command.reason);
    // Still the same hub turn, so no connection actor has run and every socket
    // is still OPEN.  That makes this the only window in which the `isOpen`
    // latch, and nothing else, decides whether `broadcast` selects a
    // connection the hub has already disconnected.
    this.recordBroadcastSelection();
  }

  private onProbeBroadcast(): void {
    this.recordBroadcastSelection();
  }

  /**
   * `broadcast` consults the filter only for a client whose `isOpen` is
   * `true`, so recording from inside the filter is a direct read of which
   * connections the hub still considers live.  `false` keeps the probe from
   * writing anything.
   */
  private recordBroadcastSelection(): void {
    this.broadcast({ kind: 'pong', n: 0 }, (client) => {
      this.state.broadcastSelected.push(client.id);
      return false;
    });
  }
}

const systems: ActorSystem[] = [];
function newSystem(name: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  return system;
}

afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

const upgrade: WebsocketUpgradeInfo = {
  path: '/ws', params: {}, query: {}, headers: {}, remoteAddress: '127.0.0.1',
};

type Harness = {
  readonly system: ActorSystem;
  readonly hub: WebsocketServerRef<Out, In, HubCommand>;
  readonly state: HubState;
  /**
   * Spawn one connection actor with `options` and wait until the hub has
   * registered it.  The `WebsocketConnection` is minted inside the actor's own
   * `preStart` and published only through `websocket-connected`, so the hub is
   * the only place a test can get one.
   */
  readonly connect: (id: string, options?: ActorOptions<ConnectionMessage>) => Promise<{
    readonly connection: WebsocketConnection<Out>;
    readonly socket: ProbeSocket;
  }>;
};

async function harness(name: string): Promise<Harness> {
  const system = newSystem(name);
  const state: HubState = { connections: new Map(), broadcastSelected: [] };
  // Factory form, not the class form: the hub takes a constructor argument
  // (the state record the test reads back).
  const hub = system.spawn(() => new RecordingHub(state), 'hub') as WebsocketServerRef<Out, In, HubCommand>;

  const connect = async (
    id: string,
    options?: ActorOptions<ConnectionMessage>,
  ): Promise<{ connection: WebsocketConnection<Out>; socket: ProbeSocket }> => {
    const socket = new ProbeSocket();
    system.spawn(
      () => new WebsocketConnectionActor<Out, In, HubCommand>({
        socket, codec: jsonCodec<Out, In>(), policy: DEFAULT_WEBSOCKET_POLICY, hub, id, upgrade,
      }),
      `conn-${id}`,
      options,
    );
    await awaitCondition(() => state.connections.has(id), {
      timeoutMs: 4_000,
      label: `the hub registered connection ${id}`,
    });
    return { connection: state.connections.get(id)!, socket };
  };

  return { system, hub, state, connect };
}

function boundedAt(overflow: 'drop-head' | 'drop-new' | 'reject'): ActorOptions<ConnectionMessage> {
  return ActorOptions.create<ConnectionMessage>()
    .withMailboxCapacity(1)
    .withMailboxOverflow(overflow);
}

async function expectClosedWith(socket: ProbeSocket, code: number, reason: string, label: string): Promise<void> {
  await awaitCondition(() => socket.closeCalls.length > 0, { timeoutMs: 4_000, label });
  expect(socket.closeCalls).toEqual([{ code, reason }]);
}

describe('a close survives a bounded connection actor (#985)', () => {
  test('drop-head does not evict the close once newer frames push it to the head', async () => {
    const h = await harness('ws-close-drop-head');
    const { connection, socket } = await h.connect('ws-1', boundedAt('drop-head'));

    // The close goes in FIRST, so it is the oldest queued envelope — precisely
    // the one `drop-head` evicts.  Queueing it exempt from the bound is only
    // half the guarantee; `removeOldest` stepping over it is the half this
    // test binds.  Whole burst in one tick, so nothing drains in between.
    connection.close(1008, 'rate limited');
    for (let frame = 0; frame < BURST; frame++) connection.tell({ kind: 'pong', n: frame });

    await expectClosedWith(socket, 1008, 'rate limited', 'the socket closed despite drop-head');
  });

  test('drop-head admits a close arriving at a full queue, and sheds the frames', async () => {
    const h = await harness('ws-close-drop-head-tail');
    const { connection, socket } = await h.connect('ws-1', boundedAt('drop-head'));

    // The other half: the close arrives LAST, at a queue already at capacity,
    // so this binds `enqueueSignal` going past the capacity check rather than
    // `removeOldest` stepping over it.
    for (let frame = 0; frame < BURST; frame++) connection.tell({ kind: 'pong', n: frame });
    connection.close(1000, 'goodbye');

    await expectClosedWith(socket, 1000, 'goodbye', 'the socket closed despite a full queue');
    // The control, and the one this file's *other* drop-head test leans on:
    // capacity 1 means exactly one of six frames survived the burst.  If this
    // ever reads 6, the bound stopped biting and neither test proves anything.
    expect(socket.sent.length).toBe(1);
  });

  test('drop-new does not discard the close arriving at a full queue', async () => {
    const h = await harness('ws-close-drop-new');
    const { connection, socket } = await h.connect('ws-1', boundedAt('drop-new'));

    for (let frame = 0; frame < BURST; frame++) connection.tell({ kind: 'pong', n: frame });
    connection.close(1008, 'rate limited');

    await expectClosedWith(socket, 1008, 'rate limited', 'the socket closed despite drop-new');
    // Same control: five of six frames were discarded on arrival.
    expect(socket.sent.length).toBe(1);
  });

  test('reject does not refuse the close, and nothing throws out of close()', async () => {
    const h = await harness('ws-close-reject');
    const { connection, socket } = await h.connect('ws-1', boundedAt('reject'));

    connection.tell({ kind: 'pong', n: 0 });                 // depth 1 == capacity
    // The control, stated as the behaviour that made this defect: an ordinary
    // frame at a full `reject` queue still raises on the caller's stack.
    expect(() => connection.tell({ kind: 'pong', n: 1 })).toThrow(MailboxFullError);
    // `close()` used to do the same — on `closeAll`'s stack, inside the hub.
    expect(() => connection.close(1008, 'rate limited')).not.toThrow();

    await expectClosedWith(socket, 1008, 'rate limited', 'the socket closed despite reject');
    expect(socket.sent.length).toBe(1);
  });

  test('closeAll closes every backlogged client, not just the ones before the first full queue', async () => {
    const h = await harness('ws-close-all-reject');
    const first = await h.connect('ws-1', boundedAt('reject'));
    const second = await h.connect('ws-2', boundedAt('reject'));

    // `kick` broadcasts one frame and then calls `closeAll`, both inside the
    // one hub turn — so every capacity-1 queue is exactly full when `closeAll`
    // reaches it, starting with the first.  A `MailboxFullError` there aborted
    // the loop mid-iteration and failed the hub, leaving every later client
    // connected: the shape #919 reports generally, and the one a global
    // default capacity would arm for every connection at once (#862).
    h.hub.tell({ kind: 'kick', code: 1008, reason: 'rate limited' });

    await expectClosedWith(first.socket, 1008, 'rate limited', 'the first client was closed');
    await expectClosedWith(second.socket, 1008, 'rate limited', 'the second client was closed too');
    // The bound really was in the way: each connection wrote the one broadcast
    // frame that fitted, and the close came in past a full queue.
    expect(first.socket.sent.length).toBe(1);
    expect(second.socket.sent.length).toBe(1);
  });
});

describe('a requested close is visible before the actor runs it (#985)', () => {
  test('isOpen reads false as soon as close() returns, while the socket is still open', async () => {
    const h = await harness('ws-close-is-open');
    const { connection, socket } = await h.connect('ws-1');

    expect(connection.isOpen).toBe(true);
    connection.close(1008, 'rate limited');
    // Same tick: the command is queued and nothing has drained, so the socket
    // itself is untouched.  Only the latch has moved — which is the whole
    // point, since `readyState` alone reads OPEN for as long as the backlog
    // ahead of the close takes to drain.
    expect(socket.readyState).toBe(WebsocketReadyState.OPEN);
    expect(socket.closeCalls).toEqual([]);
    expect(connection.isOpen).toBe(false);

    await expectClosedWith(socket, 1008, 'rate limited', 'the socket closed on the following turn');
  });

  test('broadcast stops selecting a connection closeAll has already kicked', async () => {
    const h = await harness('ws-close-broadcast');
    const { socket } = await h.connect('ws-1');

    // Control: before the kick, the same broadcast does select it.
    h.hub.tell({ kind: 'probe-broadcast' });
    await awaitCondition(() => h.state.broadcastSelected.length === 1, {
      timeoutMs: 4_000,
      label: 'broadcast selected the live connection',
    });
    expect(h.state.broadcastSelected).toEqual(['ws-1']);

    // `kick` calls `closeAll` and then re-runs the same probe inside the ONE
    // hub turn, before any connection actor has had a turn of its own.  Telling
    // the hub a second `probe-broadcast` instead would prove nothing: the
    // connection actor drains in between and the probe would read a socket
    // that has genuinely closed, whatever `isOpen` does with the latch.
    h.hub.tell({ kind: 'kick', code: 1008, reason: 'rate limited' });

    await expectClosedWith(socket, 1008, 'rate limited', 'the kicked socket closed');
    // Still just the one entry from the control probe above.
    expect(h.state.broadcastSelected).toEqual(['ws-1']);
  });
});
