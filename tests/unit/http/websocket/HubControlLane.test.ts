/**
 * #1431 — an actor that declares control messages gets a queue that can serve
 * them, without being asked to spawn itself differently.
 *
 * The capability is a mailbox type, `ControlAwareMailbox`: control messages
 * are handed over ahead of everything ordinary already queued, and a bound
 * never sheds them.  An application opts into it with `withMailbox`.  An
 * actor whose control traffic is part of its *contract* cannot wait for every
 * spawn site to opt in — the WebSocket hub is spawned by the application, in
 * the class form or through a factory, and the framework only ever sees its
 * ref — so the actor says it instead, through the internal
 * `Actor._controlMessages()` hook, and the cell acts on the answer.
 *
 * The cell has to act late.  It builds its queue in its constructor, before
 * the instance exists, because `tell` works the moment `spawn` returns; so the
 * first start — the instance just built, its first message not yet handed
 * over — is where the queue is swapped, once, envelopes and all.  The first
 * half of this file pins that swap on a plain `Actor` subclass:
 *
 *   - it happens once, at the first start, and keeps what was told before it;
 *   - it keeps the bound the queue it replaces had, and the cell still hears
 *     about every drop;
 *   - it loses nothing the old queue admitted, carries a suspension over, and
 *     moves the system commands queued behind the `create` too;
 *   - a restart keeps the swapped queue and asks nothing again;
 *   - a caller's own `withMailbox` is never swapped, and an actor that
 *     declares nothing keeps the queue it was built with.
 *
 * The second half is the hub, which declares its accept command and its
 * `connected` signal.  Measured before the hub declared anything: a second
 * client's accept and `onClientConnected` waited behind all 101 frames
 * another client had queued, and under a bound the `connected` was shed like
 * any frame.  Pinned here:
 *
 *   - in the factory form and the class form alike, with no mailbox option,
 *     the second client is accepted and connected after at most the one frame
 *     the hub was already handling, and the first client's frames keep order;
 *   - `disconnected` does not overtake: it runs after the client's own frames;
 *   - under `withMailboxCapacity`, and under the global default alone, the
 *     flood is shed and the accept and `connected` are not;
 *   - a body that only spells one of those kinds is ordinary traffic, which
 *     the bound sheds like any other;
 *   - a hub on its own `withMailbox` keeps that mailbox and the old order.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { Actor } from '../../../../src/Actor.js';
import { ActorOptions } from '../../../../src/ActorOptions.js';
import { ActorPath } from '../../../../src/ActorPath.js';
import { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import { wireConnection } from '../../../../src/http/websocket/ConnectionWiring.js';
import type { WebsocketListeners, WebsocketSocketAdapter } from '../../../../src/http/websocket/SocketAdapter.js';
import type { WebsocketFrame, WebsocketUpgradeInfo } from '../../../../src/http/websocket/Types.js';
import { jsonCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketConnection } from '../../../../src/http/websocket/WebsocketConnection.js';
import {
  websocketConnectedSignal,
  type WebsocketServerMessage,
  type WebsocketServerRef,
} from '../../../../src/http/websocket/WebsocketMessages.js';
import { DEFAULT_WEBSOCKET_POLICY } from '../../../../src/http/websocket/WebsocketPolicy.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type { LocalActorRef } from '../../../../src/internal/LocalActorRef.js';
import { Mailbox } from '../../../../src/internal/Mailbox.js';
import { BoundedMailbox } from '../../../../src/mailbox/BoundedMailbox.js';
import { ControlAwareMailbox } from '../../../../src/mailbox/ControlAwareMailbox.js';
import type { MetricsRegistry } from '../../../../src/metrics/Metrics.js';
import { MetricsExtensionId } from '../../../../src/metrics/MetricsExtension.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/* ------------------------- a generic declaring actor ------------------------- */

type OrdinaryMessage = { readonly kind: 'ordinary'; readonly n: number };
type UrgentMessage = { readonly kind: 'urgent'; readonly n: number };
/** Parks the actor inside its handler until the test opens the gate. */
type GateMessage = { readonly kind: 'gate' };
/** Fails the handler, so the supervisor restarts the actor. */
type FailMessage = { readonly kind: 'fail' };
type TestMessage = OrdinaryMessage | UrgentMessage | GateMessage | FailMessage;

const ordinary = (n: number): OrdinaryMessage => ({ kind: 'ordinary', n });
const urgent = (n: number): UrgentMessage => ({ kind: 'urgent', n });
const gate: GateMessage = { kind: 'gate' };
const fail: FailMessage = { kind: 'fail' };

/** The control predicate a declaring actor hands the cell — module-level, as the hook asks. */
function isUrgent(message: unknown): boolean {
  return (message as { kind?: unknown } | null)?.kind === 'urgent';
}

/** What the actor did, owned by the test. */
type ActorRecord = {
  starts: number;
  /** How often the cell asked the hook. */
  declarations: number;
  /** Set once the actor is parked inside the gate handler. */
  parked: boolean;
  readonly handled: string[];
  readonly gate: Promise<void>;
};

class PlainActor extends Actor<TestMessage> {
  constructor(protected readonly record: ActorRecord) {
    super();
  }

  override preStart(): void {
    this.record.starts += 1;
  }

  override onReceive(message: TestMessage): void | Promise<void> {
    return match(message)
      .with({ kind: 'ordinary' }, (m) => this.onOrdinary(m))
      .with({ kind: 'urgent' }, (m) => this.onUrgent(m))
      .with({ kind: 'gate' }, () => this.onGate())
      .with({ kind: 'fail' }, () => this.onFail())
      .exhaustive();
  }

  private onOrdinary(message: OrdinaryMessage): void {
    this.record.handled.push(`ordinary:${message.n}`);
  }

  private onUrgent(message: UrgentMessage): void {
    this.record.handled.push(`urgent:${message.n}`);
  }

  private async onGate(): Promise<void> {
    this.record.parked = true;
    await this.record.gate;
    this.record.parked = false;
  }

  private onFail(): void {
    throw new Error('asked to fail');
  }
}

/** The same actor, declaring `urgent` as its control messages. */
class DeclaringActor extends PlainActor {
  override _controlMessages(): (message: unknown) => boolean {
    this.record.declarations += 1;
    return isUrgent;
  }
}

const systems: ActorSystem[] = [];
const openGates: Array<() => void> = [];
afterEach(async () => {
  // Open every gate first: a parked actor holds `terminate()` open.
  for (const open of openGates.splice(0)) open();
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

function newSystem(name: string, defaultMailboxCapacity?: number): ActorSystem {
  let systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  if (defaultMailboxCapacity !== undefined) {
    systemOptions = systemOptions.withConfig({
      'actor-ts': { mailbox: { default: { capacity: defaultMailboxCapacity } } },
    });
  }
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  return system;
}

function newRecord(): { record: ActorRecord; openGate: () => void } {
  let openGate = (): void => { /* replaced below */ };
  const opened = new Promise<void>((resolve) => { openGate = () => resolve(); });
  openGates.push(openGate);
  return { record: { starts: 0, declarations: 0, parked: false, handled: [], gate: opened }, openGate };
}

async function parked(record: ActorRecord): Promise<void> {
  await awaitCondition(() => record.parked, { timeoutMs: 4_000, label: 'the actor parked inside its handler' });
}

async function handledCount(record: ActorRecord, count: number): Promise<void> {
  await awaitCondition(() => record.handled.length >= count, {
    timeoutMs: 4_000,
    label: `the actor handled ${count} messages`,
  });
}

/** `actor_mailbox_dropped_total` for one class and reason. */
function droppedFor(registry: MetricsRegistry, className: string, reason: string): number {
  return registry.collect()
    .filter((sample) => sample.name === 'actor_mailbox_dropped_total'
      && sample.labels['class'] === className && sample.labels['reason'] === reason)
    .reduce((total, sample) => total + sample.value, 0);
}

describe('an actor that declares control messages gets a control-aware queue (#1431)', () => {
  test('the framework-built queue is replaced once, at first start, keeping what was told before it', async () => {
    const system = newSystem('control-lane-first-start');
    const { record } = newRecord();
    const ref = system.spawn(() => new DeclaringActor(record), 'declaring') as LocalActorRef<TestMessage>;
    const cell = ref.getCell();
    const built = cell._mailboxForTest();
    // Before the first start the queue is what the spawn options built.
    expect(built).not.toBeInstanceOf(ControlAwareMailbox);

    // All four reach the queue before the actor exists.
    ref.tell(ordinary(1));
    ref.tell(ordinary(2));
    ref.tell(urgent(1));
    ref.tell(ordinary(3));
    await handledCount(record, 4);

    // Nothing lost, ordinary order kept, and the control message first — it
    // was classified when it moved across, like any arrival.
    expect(record.handled).toEqual(['urgent:1', 'ordinary:1', 'ordinary:2', 'ordinary:3']);
    expect(cell._mailboxForTest()).toBeInstanceOf(ControlAwareMailbox);
    expect(record.declarations).toBe(1);
  });

  test('a restart keeps the replaced queue, and the hook is not asked again', async () => {
    const system = newSystem('control-lane-restart');
    const { record, openGate } = newRecord();
    const ref = system.spawn(() => new DeclaringActor(record), 'declaring') as LocalActorRef<TestMessage>;
    const cell = ref.getCell();
    await awaitCondition(() => record.starts === 1, { timeoutMs: 4_000, label: 'the actor started' });
    const adopted = cell._mailboxForTest();
    expect(adopted).toBeInstanceOf(ControlAwareMailbox);

    ref.tell(fail);
    await awaitCondition(() => record.starts === 2, { timeoutMs: 4_000, label: 'the actor restarted' });
    expect(cell._mailboxForTest()).toBe(adopted);
    expect(record.declarations).toBe(1);

    // And it still serves the new incarnation: urgent overtakes the backlog.
    ref.tell(gate);
    await parked(record);
    ref.tell(ordinary(10));
    ref.tell(urgent(10));
    openGate();
    await handledCount(record, 2);
    expect(record.handled).toEqual(['urgent:10', 'ordinary:10']);
  });

  test('the bound of the replaced queue is kept, and its drops still reach the cell', async () => {
    const system = newSystem('control-lane-bound');
    const registry = system.extension(MetricsExtensionId).enable();
    const { record, openGate } = newRecord();
    const options = ActorOptions.create<TestMessage>()
      .withMailboxCapacity(2)
      .withMailboxOverflow('drop-new');
    const ref = system.spawn(() => new DeclaringActor(record), 'declaring', options) as LocalActorRef<TestMessage>;
    const cell = ref.getCell();
    expect(cell._mailboxForTest()).toBeInstanceOf(BoundedMailbox);

    ref.tell(gate);
    await parked(record);
    for (let n = 1; n <= 5; n++) ref.tell(ordinary(n));
    ref.tell(urgent(1));
    openGate();
    await handledCount(record, 3);

    // Two ordinary messages fit the bound and three were shed; the control
    // message was admitted past it and overtook both survivors.
    expect(record.handled).toEqual(['urgent:1', 'ordinary:1', 'ordinary:2']);
    expect(cell._mailboxForTest()).toBeInstanceOf(ControlAwareMailbox);
    expect(droppedFor(registry, 'DeclaringActor', 'drop-new')).toBe(3);
  });

  test('nothing the old queue admitted is shed on the way across', async () => {
    const system = newSystem('control-lane-transfer');
    const { record } = newRecord();
    const options = ActorOptions.create<TestMessage>()
      .withMailboxCapacity(2)
      .withMailboxOverflow('drop-head');
    const ref = system.spawn(() => new DeclaringActor(record), 'declaring', options) as LocalActorRef<TestMessage>;
    const cell = ref.getCell();

    // Before the first start: the bound fills, two envelopes take the exempt
    // door past it, and the next arrival evicts the oldest droppable one.  The
    // old queue now holds more than its capacity in front of its last arrival
    // — which a transfer that re-applied the bound would evict again.
    ref.tell(ordinary(1));
    ref.tell(ordinary(2));
    cell.postSignalEnvelope({ message: ordinary(101), sender: null });
    cell.postSignalEnvelope({ message: ordinary(102), sender: null });
    ref.tell(ordinary(3));
    await handledCount(record, 4);

    expect(record.handled).toEqual(['ordinary:2', 'ordinary:101', 'ordinary:102', 'ordinary:3']);
  });

  test('a suspension and the system commands queued behind the create move across too', async () => {
    const system = newSystem('control-lane-system-lane');
    const { record } = newRecord();
    const ref = system.spawn(() => new DeclaringActor(record), 'declaring') as LocalActorRef<TestMessage>;
    const cell = ref.getCell();

    cell._mailboxForTest().suspend();
    ref.tell(ordinary(1));
    await awaitCondition(() => record.starts === 1, { timeoutMs: 4_000, label: 'the actor started' });
    expect(cell._mailboxForTest()).toBeInstanceOf(ControlAwareMailbox);
    expect(cell._mailboxForTest().suspended).toBe(true);
    expect(record.handled).toEqual([]);

    cell.enqueueSystem({ kind: 'resume' });
    await handledCount(record, 1);
    expect(record.handled).toEqual(['ordinary:1']);

    // A stop queued on the system lane before the first start is not lost.
    const second = newRecord();
    const stopped = system.spawn(() => new DeclaringActor(second.record), 'stopped') as LocalActorRef<TestMessage>;
    stopped.getCell().enqueueSystem({ kind: 'terminate' });
    await awaitCondition(() => stopped.getCell().isTerminated(), {
      timeoutMs: 4_000,
      label: 'the terminate queued before the first start was handled',
    });
  });

  test("a caller's own withMailbox is never replaced, and keeps arrival order", async () => {
    const system = newSystem('control-lane-caller-mailbox');
    const { record, openGate } = newRecord();
    let supplied: Mailbox<TestMessage> | null = null;
    const options = ActorOptions.create<TestMessage>().withMailbox(() => {
      supplied = new Mailbox<TestMessage>();
      return supplied;
    });
    const ref = system.spawn(() => new DeclaringActor(record), 'declaring', options) as LocalActorRef<TestMessage>;
    const cell = ref.getCell();

    ref.tell(gate);
    await parked(record);
    ref.tell(ordinary(1));
    ref.tell(urgent(1));
    openGate();
    await handledCount(record, 2);

    expect(supplied).not.toBeNull();
    expect(cell._mailboxForTest()).toBe(supplied!);
    expect(record.handled).toEqual(['ordinary:1', 'urgent:1']);
  });

  test('an actor that declares nothing keeps the queue it was built with', async () => {
    const system = newSystem('control-lane-plain');
    const { record, openGate } = newRecord();
    const options = ActorOptions.create<TestMessage>().withMailboxCapacity(4);
    const ref = system.spawn(() => new PlainActor(record), 'plain', options) as LocalActorRef<TestMessage>;
    const cell = ref.getCell();
    const built = cell._mailboxForTest();

    ref.tell(gate);
    await parked(record);
    ref.tell(ordinary(1));
    ref.tell(urgent(1));
    openGate();
    await handledCount(record, 2);

    expect(cell._mailboxForTest()).toBe(built);
    expect(built).toBeInstanceOf(BoundedMailbox);
    expect(record.handled).toEqual(['ordinary:1', 'urgent:1']);
  });
});

/* ----------------------------------- the hub ---------------------------------- */

type PingMessage = { readonly kind: 'ping'; readonly n: number };
type PongMessage = { readonly kind: 'pong'; readonly n: number };
/** The hub's one app-level message: snapshot `clients`. */
type ListClientsCommand = { readonly kind: 'list-clients' };
type HubMessage = WebsocketServerMessage<PongMessage, PingMessage, ListClientsCommand>;

/** In-memory socket: buffers inbound frames until the connection actor attaches. */
class MockSocket implements WebsocketSocketAdapter {
  readyState: 0 | 1 | 2 | 3 = 1;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  remoteAddress = '127.0.0.1';
  listenersAttached = false;
  private listeners: WebsocketListeners | null = null;
  private readonly pending: Array<(l: WebsocketListeners) => void> = [];

  send(): void { /* nothing under test writes outbound */ }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.deliver((l) => l.onClose(code ?? 1000, reason ?? ''));
  }
  setListeners(l: WebsocketListeners): void {
    this.listeners = l;
    this.listenersAttached = true;
    for (const callback of this.pending.splice(0)) callback(l);
  }

  /** A frame from the client. */
  emit(n: number): void {
    const data = JSON.stringify({ kind: 'ping', n } satisfies PingMessage);
    this.deliver((l) => l.onMessage(data));
  }
  /** The client hangs up. */
  hangUp(): void {
    this.readyState = 3;
    this.deliver((l) => l.onClose(1000, 'bye'));
  }
  private deliver(callback: (l: WebsocketListeners) => void): void {
    if (this.listeners !== null) callback(this.listeners);
    else this.pending.push(callback);
  }
}

/**
 * A connection with no socket behind it, for the one property a real second
 * client cannot show: a `connected` already queued while the hub is parked.
 * A real connection's actor reports it in the gap between two of the hub's
 * own messages — the hub spawned that actor a moment before — so the hub has
 * always moved on to it before a flood could push it out.
 */
class StandInConnection extends ActorRef<PongMessage> implements WebsocketConnection<PongMessage> {
  readonly path: ActorPath;
  readonly upgrade: WebsocketUpgradeInfo = { path: '/ws', params: {}, query: {}, headers: {} };
  readonly isOpen = true;
  constructor(readonly id: string) {
    super();
    this.path = new ActorPath(`ws-conn-${id}`, null, 'control-lane');
  }
  override tell(): void {}
  sendRaw(_frame: WebsocketFrame): void {}
  close(): void {}
  abort(): void {}
}

/** What the hub did, owned by the test. */
type HubRecord = {
  readonly events: string[];
  /** The next frame handled parks the hub until `gate` opens. */
  parkNext: boolean;
  parked: boolean;
  readonly gate: Promise<void>;
  /** `clients` as the hub last listed it. */
  clients: string[] | null;
};

class RecordingHub extends WebsocketServerActor<PongMessage, PingMessage, ListClientsCommand> {
  constructor(private readonly record: HubRecord) {
    super();
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

  protected override onClientDisconnected(client: WebsocketConnection<PongMessage>): void {
    this.record.events.push(`disconnected:${client.id}`);
  }

  protected override onSelfMessage(message: ListClientsCommand): void {
    match(message as unknown)
      .with({ kind: 'list-clients' }, () => this.onListClients())
      .otherwise((m) => this.onForeign(m));
  }

  private onListClients(): void {
    this.record.clients = [...this.clients.keys()];
  }

  private onForeign(message: unknown): void {
    super.onSelfMessage(message as ListClientsCommand);
  }
}

/** The record the class form reads — its constructor takes no arguments, so it cannot be handed one. */
const classFormRecord: { current: HubRecord | null } = { current: null };

class ClassFormHub extends RecordingHub {
  constructor() {
    super(classFormRecord.current!);
  }
}

function newHubRecord(): { record: HubRecord; openGate: () => void } {
  let openGate = (): void => { /* replaced below */ };
  const opened = new Promise<void>((resolve) => { openGate = () => resolve(); });
  openGates.push(openGate);
  return { record: { events: [], parkNext: false, parked: false, gate: opened, clients: null }, openGate };
}

const request: HttpRequest = {
  method: 'GET', path: '/ws', headers: {}, query: {}, params: {}, body: null,
};

type HubHarness = {
  readonly system: ActorSystem;
  readonly hub: WebsocketServerRef<PongMessage, PingMessage, ListClientsCommand>;
  readonly record: HubRecord;
  readonly openGate: () => void;
};

type HubForm = 'factory' | 'class';

function spawnHub(system: ActorSystem, form: HubForm, options?: ActorOptions<HubMessage>): HubHarness {
  const { record, openGate } = newHubRecord();
  let hub: WebsocketServerRef<PongMessage, PingMessage, ListClientsCommand>;
  if (form === 'class') {
    classFormRecord.current = record;
    hub = system.spawn(ClassFormHub, 'hub', options);
  } else {
    // The shape DevToolsServer and the chat and voice examples spawn their hubs in.
    hub = system.spawn(() => new RecordingHub(record), 'hub', options);
  }
  return { system, hub, record, openGate };
}

function wire(h: HubHarness): MockSocket {
  const socket = new MockSocket();
  wireConnection<PongMessage, PingMessage, ListClientsCommand>(
    h.system, h.hub, request, socket, jsonCodec<PongMessage, PingMessage>(), DEFAULT_WEBSOCKET_POLICY,
  );
  return socket;
}

/** Wire a client and wait until the hub has announced it; returns its socket and connection id. */
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

/** Park the hub inside its handler on the client's next frame, and wait until it is. */
async function parkOn(h: HubHarness, socket: MockSocket, n: number): Promise<void> {
  h.record.parkNext = true;
  socket.emit(n);
  await awaitCondition(() => h.record.parked, { timeoutMs: 4_000, label: 'the hub parked inside onMessage' });
}

/** The frames a client's events say the hub handled, in order. */
function framesOf(record: HubRecord, id: string): number[] {
  return record.events
    .filter((event) => event.startsWith(`message:${id}:`))
    .map((event) => Number(event.slice(`message:${id}:`.length)));
}

/** How many of `id`'s frames the hub handled before the event `marker`. */
function framesBefore(record: HubRecord, id: string, marker: string): number {
  const at = record.events.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return record.events.slice(0, at).filter((event) => event.startsWith(`message:${id}:`)).length;
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

async function listedClients(h: HubHarness): Promise<string[]> {
  h.record.clients = null;
  h.hub.tell({ kind: 'list-clients' });
  await awaitCondition(() => h.record.clients !== null, { timeoutMs: 4_000, label: 'the hub listed its clients' });
  return h.record.clients!;
}

describe("the WebSocket hub's accept and connected ride the control lane (#1431)", () => {
  for (const form of ['factory', 'class'] as const) {
    test(`a second client is accepted and connected ahead of another client's backlog (${form} form)`, async () => {
      const h = spawnHub(newSystem(`hub-lane-${form}`), form);
      const x = await connect(h);
      await parkOn(h, x.socket, 0);
      for (let n = 1; n <= 100; n++) x.socket.emit(n);
      const y = wire(h);
      h.openGate();

      await awaitCondition(() => h.record.events.some((event) => event.startsWith('connected:') && !event.endsWith(x.id)), {
        timeoutMs: 4_000,
        label: 'the second client was connected',
      });
      await awaitCondition(() => framesOf(h.record, x.id).length === 101, {
        timeoutMs: 4_000,
        label: "the first client's backlog drained",
      });
      const yConnected = h.record.events.find((event) => event.startsWith('connected:') && !event.endsWith(x.id))!;

      // At most the frame the hub was already handling when the upgrade came in.
      expect(framesBefore(h.record, x.id, yConnected)).toBeLessThanOrEqual(1);
      expect(framesOf(h.record, x.id)).toEqual(range(0, 100));
      expect(y.listenersAttached).toBe(true);
      expect((h.hub as LocalActorRef<HubMessage>).getCell()._mailboxForTest()).toBeInstanceOf(ControlAwareMailbox);
    });
  }

  test("a client's onClientDisconnected still runs after its own queued frames", async () => {
    const h = spawnHub(newSystem('hub-lane-disconnect'), 'factory');
    const x = await connect(h);
    await parkOn(h, x.socket, 0);
    for (let n = 1; n <= 10; n++) x.socket.emit(n);
    x.socket.hangUp();
    // The connection actor reports the close from its `postStop`, a turn or two
    // after the hang-up; wait for it to be queued behind the frames.
    await awaitCondition(() => (h.hub as LocalActorRef<HubMessage>).getCell().mailboxSize === 11, {
      timeoutMs: 4_000,
      label: 'the disconnect was queued behind the frames',
    });
    h.openGate();

    await awaitCondition(() => h.record.events.includes(`disconnected:${x.id}`), {
      timeoutMs: 4_000,
      label: 'the client was reported disconnected',
    });
    expect(h.record.events).toEqual([
      `connected:${x.id}`,
      ...range(0, 10).map((n) => `message:${x.id}:${n}`),
      `disconnected:${x.id}`,
    ]);
  });

  const bounds: ReadonlyArray<{ readonly name: string; readonly spawn: () => HubHarness }> = [
    {
      name: 'withMailboxCapacity(4)',
      spawn: () => spawnHub(newSystem('hub-lane-bound-spawn'), 'factory', ActorOptions.create<HubMessage>().withMailboxCapacity(4)),
    },
    {
      name: 'actor-ts.mailbox.default.capacity = 4 alone',
      spawn: () => spawnHub(newSystem('hub-lane-bound-global', 4), 'factory'),
    },
  ];
  for (const bound of bounds) {
    test(`under ${bound.name} a flood is shed and the accept and connected are not`, async () => {
      const h = bound.spawn();
      const cell = (h.hub as LocalActorRef<HubMessage>).getCell();
      const x = await connect(h);
      const mailbox = cell._mailboxForTest();
      expect(mailbox).toBeInstanceOf(ControlAwareMailbox);

      await parkOn(h, x.socket, 0);
      // A `connected` already queued when the flood arrives — see `StandInConnection`.
      h.hub.tell(websocketConnectedSignal<PongMessage>(new StandInConnection('stand-in')));
      for (let n = 1; n <= 60; n++) x.socket.emit(n);
      // And an upgrade that completes in the middle of the flood.
      const y = wire(h);
      for (let n = 61; n <= 70; n++) x.socket.emit(n);
      expect((mailbox as ControlAwareMailbox<HubMessage>).droppedCount).toBeGreaterThan(0);
      h.openGate();

      await awaitCondition(() => y.listenersAttached, { timeoutMs: 4_000, label: 'the second client attached' });
      await awaitCondition(() => h.record.events.filter((event) => event.startsWith('connected:')).length === 3, {
        timeoutMs: 4_000,
        label: 'the stand-in and the second client were both connected',
      });
      const clients = await listedClients(h);
      expect(clients).toContain('stand-in');
      expect(clients).toContain(x.id);
      expect(clients).toHaveLength(3);
      expect(y.closeCalls).toEqual([]);
      // The bound held for the flood: only the newest frames survived.
      expect(framesOf(h.record, x.id).length).toBeLessThan(71);
    });
  }

  test('a body that only spells a control kind is ordinary traffic, and a bound sheds it', async () => {
    // The control lane is never shed and never counted, so a predicate that
    // looked at `kind` alone would hand a remote peer an unbounded queue that
    // overtakes every real frame.  The hub classes in the shape it dispatches
    // on, so these meet the bound like any frame.
    const h = spawnHub(newSystem('hub-lane-forged'), 'factory', ActorOptions.create<HubMessage>().withMailboxCapacity(4));
    const x = await connect(h);
    const mailbox = (h.hub as LocalActorRef<HubMessage>).getCell()._mailboxForTest() as ControlAwareMailbox<HubMessage>;
    await parkOn(h, x.socket, 0);
    for (let n = 0; n < 50; n++) {
      (h.hub as ActorRef<unknown>).tell({ kind: 'websocket-connected', connection: { id: `forged-${n}` } });
      (h.hub as ActorRef<unknown>).tell({ kind: 'websocket-accept', actor: {}, name: `forged-${n}` });
    }

    expect(mailbox.droppedCount).toBe(96);
    expect(mailbox.size).toBe(4);
    h.openGate();
    expect(await listedClients(h)).toEqual([x.id]);
  });

  test('a hub spawned with its own withMailbox keeps exactly that mailbox, and the old order', async () => {
    let supplied: Mailbox<HubMessage> | null = null;
    const options = ActorOptions.create<HubMessage>().withMailbox(() => {
      supplied = new Mailbox<HubMessage>();
      return supplied;
    });
    const h = spawnHub(newSystem('hub-lane-own-mailbox'), 'factory', options);
    const x = await connect(h);
    await parkOn(h, x.socket, 0);
    for (let n = 1; n <= 100; n++) x.socket.emit(n);
    wire(h);
    h.openGate();

    await awaitCondition(() => h.record.events.filter((event) => event.startsWith('connected:')).length === 2, {
      timeoutMs: 4_000,
      label: 'the second client was connected',
    });
    const yConnected = h.record.events.filter((event) => event.startsWith('connected:'))[1]!;
    expect((h.hub as LocalActorRef<HubMessage>).getCell()._mailboxForTest()).toBe(supplied!);
    // FIFO: the accept waited behind the whole backlog, as that queue orders everything.
    expect(framesBefore(h.record, x.id, yConnected)).toBe(101);
  });
});
