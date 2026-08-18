/**
 * #717 — a bounded WebSocket hub may not lose the command that spawns a
 * connection's actor.
 *
 * `wireConnection` runs on the backend's upgrade stack: it builds the
 * per-connection actor's factory, closes the only reference to the
 * freshly-upgraded socket into it, hands the hub a `websocket-accept` and
 * returns.  Nothing retries.  So if that one envelope is shed, the socket is
 * upgraded and orphaned — no listeners are ever attached to it, its pre-attach
 * buffer accumulates frames nothing will drain, and it holds its
 * `maxConnections` slot until the client gives up.
 *
 * Unreachable by default since #1148 made the unbounded mailbox the default
 * again: nothing is evicted from a hub nobody bounded.  Every test here
 * therefore *configures* a bound, which is the whole remaining premise of the
 * issue — and bounding a hub is exactly what
 * `fundamentals/mailboxes.mdx` recommends for "any actor exposed to a producer
 * you do not control".
 *
 * The fix reuses #729's seam rather than adding a second one: the command goes
 * through `ActorCell.postSignalEnvelope`, so it carries `Envelope.undroppable`
 * and takes `Mailbox.enqueueSignal`.  Each test below pins one policy that
 * destroyed it before, plus the guard for the one case that can still refuse.
 *
 * Refs #717, #729, #1148.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { ActorOptions } from '../../../../src/ActorOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { Mailbox, type Envelope } from '../../../../src/internal/Mailbox.js';
import { PriorityMailbox } from '../../../../src/mailbox/PriorityMailbox.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import { wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import { DEFAULT_WEBSOCKET_POLICY, type ResolvedWebsocketPolicy } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { jsonCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketListeners, WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import type { WebsocketServerMessage, WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type In = { kind: 'ping'; n: number };
type Out = { kind: 'pong'; n: number };

/** The hub's app-level traffic — the flood that competes for its queue. */
type FillerCommand = { readonly kind: 'filler' };
const filler: FillerCommand = { kind: 'filler' };

type HubMessage = WebsocketServerMessage<Out, In, FillerCommand>;

/**
 * Minimal socket adapter.  `listenersAttached` is the assertion every test
 * here turns on: `setListeners` is called from the connection actor's
 * `preStart`, so it is true if and only if the hub actually processed the
 * accept command and spawned the child.
 *
 * Deliberately *not* `rec.connections`-style bookkeeping through
 * `onClientConnected`: that arrives as a second, ordinary `tell` from the
 * child's `preStart` and a bounded hub may shed *that* one for unrelated
 * reasons (#986).  Asserting on it would conflate two defects.
 */
class ProbeSocket implements WebsocketSocketAdapter {
  readyState: 0 | 1 | 2 | 3 = 1;
  listenersAttached = false;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  remoteAddress = '127.0.0.1';
  private listeners: WebsocketListeners | null = null;

  send(): void { /* nothing under test writes outbound here */ }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.listeners?.onClose(code ?? 1000, reason ?? '');
  }
  setListeners(l: WebsocketListeners): void {
    this.listeners = l;
    this.listenersAttached = true;
  }
}

/** Observable state of the gated hub, owned by the test. */
type HubState = {
  /** Set once the hub is inside a handler and therefore no longer draining. */
  entered: boolean;
  /** How many app messages survived the bound and were handled. */
  handled: number;
  /** Resolved by the test to let the hub drain. */
  readonly gate: Promise<void>;
};

/**
 * A hub that stops draining on its first app message and stays stopped until
 * the test opens the gate.
 *
 * That is what makes the bound observable at all: `BoundedMailbox` sheds on
 * arrival, so the queue has to be *held* at capacity while the accept arrives.
 * A hub that kept draining would empty the queue between two `tell`s and the
 * overflow policy would never run.
 */
class GatedHub extends WebsocketServerActor<Out, In, FillerCommand> {
  constructor(private readonly state: HubState) {
    super();
  }
  onMessage(): void { /* no inbound frame is emitted in these tests */ }
  protected override async onSelfMessage(_command: FillerCommand): Promise<void> {
    this.state.entered = true;
    await this.state.gate;
    this.state.handled += 1;
  }
}

/**
 * Same hub, but rate-limited instead of bounded — the throttle gate is the
 * second place a shedding policy sees a user envelope, and `onExcess: 'drop'`
 * consumed whatever it metered.
 */
class ThrottledHub extends WebsocketServerActor<Out, In, FillerCommand> {
  constructor(private readonly state: HubState) {
    super();
  }
  override preStart(): void {
    this.context.throttle({ qps: 1 / 60, burst: 1, onExcess: 'drop' });
  }
  onMessage(): void { /* no inbound frame is emitted in these tests */ }
  protected override onSelfMessage(_command: FillerCommand): void {
    this.state.handled += 1;
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

/**
 * Every gate opened here as well as in the test body.
 *
 * A parked hub is awaiting a promise inside its handler, so `terminate()`
 * cannot settle until the gate opens — and a test that fails *before* its own
 * `openGate()` would hang the whole file instead of reporting. Which is not
 * hypothetical: it is what the revert experiment for this fix produced before
 * this hook existed, and a hang is a far worse signal than a red assertion.
 */
const openGates: Array<() => void> = [];
afterEach(async () => {
  for (const openGate of openGates.splice(0)) openGate();
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

const request: HttpRequest = {
  method: 'GET', path: '/ws', headers: {}, query: {}, params: {}, body: null,
};

type Harness = {
  readonly system: ActorSystem;
  readonly hub: WebsocketServerRef<Out, In, FillerCommand>;
  readonly state: HubState;
  readonly openGate: () => void;
  /** Block the hub and wait until it is genuinely parked inside a handler. */
  readonly park: () => Promise<void>;
};

/**
 * Spawn a gated hub with `options`, then park it.
 *
 * Parking is a wait on `state.entered` rather than a delay: the first app
 * message is *dequeued* before the handler awaits, so the queue is empty again
 * at that point and every later arrival meets the bound with a known depth.
 */
async function harness(name: string, options: ActorOptions<HubMessage>): Promise<Harness> {
  const system = newSystem(name);
  let openGate = (): void => { /* replaced below */ };
  const gate = new Promise<void>((resolve) => { openGate = () => resolve(); });
  openGates.push(openGate);
  const state: HubState = { entered: false, handled: 0, gate };
  // Factory form, not the class form: the hub takes a constructor argument
  // (the state record the test reads back).
  const hub = system.spawn(() => new GatedHub(state), 'hub', options) as WebsocketServerRef<Out, In, FillerCommand>;
  const park = async (): Promise<void> => {
    hub.tell(filler);
    await awaitCondition(() => state.entered, {
      timeoutMs: 4_000,
      label: 'the hub parked inside its handler and stopped draining',
    });
  };
  await park();
  return { system, hub, state, openGate, park };
}

function wire(
  harnessed: Harness,
  socket: ProbeSocket,
  policy: ResolvedWebsocketPolicy = DEFAULT_WEBSOCKET_POLICY,
): void {
  wireConnection<Out, In, FillerCommand>(
    harnessed.system, harnessed.hub, request, socket, jsonCodec<Out, In>(), policy,
  );
}

/** The one assertion that says the accept survived: the child attached. */
async function expectConnectionActorSpawned(socket: ProbeSocket, label: string): Promise<void> {
  await awaitCondition(() => socket.listenersAttached, { timeoutMs: 4_000, label });
  expect(socket.listenersAttached).toBe(true);
  expect(socket.closeCalls).toEqual([]);
}

describe('websocket-accept survives a bounded hub (#717)', () => {
  test("drop-new does not discard the accept arriving at a full hub", async () => {
    const options = ActorOptions.create<HubMessage>()
      .withMailboxCapacity(1)
      .withMailboxOverflow('drop-new');
    const h = await harness('ws-accept-drop-new', options);

    // Queue depth 1 == capacity, so the hub is full and shedding.
    h.hub.tell(filler);
    // Proof the bound is live in this test rather than a mis-set capacity:
    // this one IS discarded, and its absence from `handled` is checked below.
    h.hub.tell(filler);

    const socket = new ProbeSocket();
    wire(h, socket);
    h.openGate();

    await expectConnectionActorSpawned(socket, 'the connection actor attached despite drop-new');
    // Two app messages reached the handler (the parking one and one queued
    // one); the third was shed.  If this ever reads 3 the capacity stopped
    // biting and the test above proves nothing.
    expect(h.state.handled).toBe(2);
  });

  test('drop-head does not evict the accept once newer frames push it to the head', async () => {
    const options = ActorOptions.create<HubMessage>()
      .withMailboxCapacity(1)
      .withMailboxOverflow('drop-head');
    const h = await harness('ws-accept-drop-head', options);

    // The accept goes in first, so it is the OLDEST queued envelope — which is
    // precisely the one `drop-head` evicts.  Queueing it exempt from the bound
    // is only half the guarantee; `removeOldest` stepping over it is the half
    // this test binds.
    const socket = new ProbeSocket();
    wire(h, socket);
    for (let arrival = 0; arrival < 5; arrival++) h.hub.tell(filler);
    h.openGate();

    await expectConnectionActorSpawned(socket, 'the connection actor attached despite drop-head');
  });

  test('reject does not refuse the accept, and nothing throws out of the upgrade stack', async () => {
    const options = ActorOptions.create<HubMessage>()
      .withMailboxCapacity(1)
      .withMailboxOverflow('reject');
    const h = await harness('ws-accept-reject', options);

    h.hub.tell(filler);                       // depth 1 == capacity

    const socket = new ProbeSocket();
    // `reject` used to raise `MailboxFullError` on *this* stack — the
    // backend's upgrade callback, which no backend guards.
    expect(() => wire(h, socket)).not.toThrow();
    h.openGate();

    await expectConnectionActorSpawned(socket, 'the connection actor attached despite reject');
  });

  test("a caller's PriorityMailbox cannot shed the accept as its lowest priority", async () => {
    // `PriorityMailbox` dequeues ASCENDING — 0 is the highest priority — and
    // `drop-lowest-priority` sheds from the tail.  So ranking the app traffic
    // at 0 and everything else at 10 makes the accept the least important
    // entry in the queue and therefore the one the policy picks.  Undroppable
    // is not queue-jumping: it may still be delivered last, it may only not be
    // deleted.
    const options = ActorOptions.create<HubMessage>()
      .withMailbox(() => new PriorityMailbox<HubMessage>({
        priorityFor: (message) => ((message as { kind?: string }).kind === 'filler' ? 0 : 10),
        capacity: 1,
        overflow: 'drop-lowest-priority',
      }));
    const h = await harness('ws-accept-priority', options);

    const socket = new ProbeSocket();
    wire(h, socket);
    for (let arrival = 0; arrival < 5; arrival++) h.hub.tell(filler);
    h.openGate();

    await expectConnectionActorSpawned(socket, 'the connection actor attached despite drop-lowest-priority');
  });

  test("a hub's own throttle with onExcess 'drop' does not consume the accept", async () => {
    // The other place a load-shedding policy sees a user envelope: the cell's
    // throttle gate, one layer above the mailbox.  `onExcess: 'drop'` consumed
    // whatever it metered, so a hub rate-limiting its inbound frames dropped
    // the accept too — the same loss the mailbox bound produced, reached
    // without any mailbox capacity at all.
    const system = newSystem('ws-accept-throttle');
    const state: HubState = { entered: false, handled: 0, gate: Promise.resolve() };
    const hub = system.spawn(
      () => new ThrottledHub(state), 'hub',
    ) as WebsocketServerRef<Out, In, FillerCommand>;
    // One token per minute with no burst: the budget is spent by the first
    // message and cannot refill inside the test.
    hub.tell(filler);
    await awaitCondition(() => state.handled >= 1, {
      timeoutMs: 4_000,
      label: 'the hub spent its only throttle token',
    });

    const socket = new ProbeSocket();
    wireConnection<Out, In, FillerCommand>(
      system, hub, request, socket, jsonCodec<Out, In>(), DEFAULT_WEBSOCKET_POLICY,
    );
    await expectConnectionActorSpawned(socket, 'the connection actor attached despite a spent throttle budget');
  });
});

/**
 * A `Mailbox` subclass that refuses everything and does NOT override
 * `enqueueSignal` — the one shape that can still make the send throw, because
 * the base `enqueueSignal` delegates to `enqueue` by design (a subclass may
 * keep its messages somewhere the base queue cannot reach).
 */
class RefusingMailbox<T> extends Mailbox<T> {
  override enqueue(_envelope: Envelope<T>): void {
    throw new Error('this mailbox refuses every user message');
  }
}

describe('wireConnection cannot leak an admission slot when the hub refuses (#717)', () => {
  test('a refused accept closes the socket and releases its maxConnections slot', async () => {
    const options = ActorOptions.create<HubMessage>()
      .withMailbox(() => new RefusingMailbox<HubMessage>());
    // No parking: this hub cannot accept the app message `harness` would send.
    const system = newSystem('ws-accept-refused');
    const state: HubState = { entered: false, handled: 0, gate: Promise.resolve() };
    const hub = system.spawn(() => new GatedHub(state), 'hub', options) as WebsocketServerRef<Out, In, FillerCommand>;
    const wireOne = (socket: ProbeSocket): void => {
      wireConnection<Out, In, FillerCommand>(
        system, hub, request, socket, jsonCodec<Out, In>(),
        { ...DEFAULT_WEBSOCKET_POLICY, maxConnections: 1 },
      );
    };

    const first = new ProbeSocket();
    expect(() => wireOne(first)).not.toThrow();
    expect(first.listenersAttached).toBe(false);
    expect(first.closeCalls).toEqual([{ code: 1011, reason: 'connection setup failed' }]);

    // The slot the first upgrade took must be back.  `decrementOnClose`'s
    // release is chained onto `setListeners`, which never ran — so if
    // `wireConnection` did not release it by hand, this second socket is
    // refused with 1013 instead of being admitted and refused with 1011.
    const second = new ProbeSocket();
    wireOne(second);
    expect(second.closeCalls).toEqual([{ code: 1011, reason: 'connection setup failed' }]);
  });
});
