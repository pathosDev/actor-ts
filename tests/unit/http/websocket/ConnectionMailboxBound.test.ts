/**
 * #1432 — a `websocket()` route bounds the mailbox of every connection actor it
 * spawns, and a route that sets nothing still falls through to the global bound.
 *
 * Each connection is an internal actor the hub spawns as its child, and its
 * mailbox is the queue `connection.tell`, `sendRaw` and `close` go into.  The
 * hub used to spawn it with no `ActorOptions`, so the only lever on that queue
 * was `actor-ts.mailbox.default.*` (#862), which bounds every application actor
 * at once — and once that was on, no route could size its connections apart
 * from the rest of the program.  `withConnectionMailboxCapacity` /
 * `withConnectionMailboxOverflow` and their `actor-ts.http.websocket` leaves are
 * that lever: resolved with the rest of the route policy, carried to the hub on
 * the accept command, and handed to its `context.spawn`.
 *
 * Everything here goes through the path a backend drives: `HttpExtension.bind`
 * against a backend that only records the registration, then the
 * registration's `onConnection` with a socket — which runs `wireConnection`,
 * posts the accept command, and lets the hub spawn the actor.  The sibling
 * `CloseCommandUndroppable.test.ts` holds the close guarantees on a connection
 * actor it spawns itself; what it cannot show is that a bound set on a route
 * reaches that actor at all.
 *
 * **How the queue is held at capacity.**  The hub writes the whole burst in ONE
 * turn of its own, so nothing drains in between — a connection actor runs only
 * after the hub yields.  The burst ends with a close, which travels a lane no
 * overflow policy sheds (#985) and arrives at the tail of the queue, so once
 * the socket has closed every frame that survived has been written: `sent` is
 * then a complete count, and the frames in it say which overflow policy chose
 * them.
 *
 * Refs #862, #985, #1432.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { match } from 'ts-pattern';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { ConfigObject } from '../../../../src/config/HoconParser.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import type {
  HttpServerBackend,
  RouteRegistration,
  ServerBinding,
  WebsocketRouteRegistration,
} from '../../../../src/http/backend/HttpServerBackend.js';
import { HttpExtensionId } from '../../../../src/http/HttpExtension.js';
import type { HttpRequest } from '../../../../src/http/Types.js';
import {
  WebsocketReadyState,
  type WebsocketListeners,
  type WebsocketSocketAdapter,
} from '../../../../src/http/websocket/SocketAdapter.js';
import type { WebsocketConnection } from '../../../../src/http/websocket/WebsocketConnection.js';
import type { WebsocketServerRef } from '../../../../src/http/websocket/WebsocketMessages.js';
import { websocket } from '../../../../src/http/websocket/WebsocketRoute.js';
import { WebsocketRouteOptions } from '../../../../src/http/websocket/WebsocketRouteOptions.js';
import { WebsocketServerActor } from '../../../../src/http/websocket/WebsocketServerActor.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

type In = { readonly kind: 'ping'; readonly n: number };
type Out = { readonly kind: 'pong'; readonly n: number };

/** Write `frames` frames to every connection, then `closeAll`, in one hub turn. */
type BurstThenCloseAllCommand = {
  readonly kind: 'burst-then-close-all';
  readonly frames: number;
  readonly code: number;
  readonly reason: string;
};
/** The same burst to one connection through `tell`, then its own `close()`. */
type BurstThenCloseCommand = {
  readonly kind: 'burst-then-close';
  readonly id: string;
  readonly frames: number;
  readonly code: number;
  readonly reason: string;
};
type HubCommand = BurstThenCloseAllCommand | BurstThenCloseCommand;

/** How many frames one burst offers a queue — above every capacity used here. */
const BURST = 6;

/** A hub that records who connected and writes bursts on its own stack. */
class BurstHub extends WebsocketServerActor<Out, In, HubCommand> {
  constructor(private readonly connected: string[]) {
    super();
  }

  onMessage(): void { /* no inbound frame is emitted in these tests */ }

  protected override onClientConnected(client: WebsocketConnection<Out>): void {
    this.connected.push(client.id);
  }

  protected override onSelfMessage(command: HubCommand): void {
    match(command)
      .with({ kind: 'burst-then-close-all' }, (c) => this.onBurstThenCloseAll(c))
      .with({ kind: 'burst-then-close' }, (c) => this.onBurstThenClose(c))
      .exhaustive();
  }

  private onBurstThenCloseAll(command: BurstThenCloseAllCommand): void {
    for (let n = 0; n < command.frames; n++) this.broadcast({ kind: 'pong', n });
    this.closeAll(command.code, command.reason);
  }

  private onBurstThenClose(command: BurstThenCloseCommand): void {
    const connection = this.clients.get(command.id);
    if (connection === undefined) throw new Error(`no connection ${command.id}`);
    for (let n = 0; n < command.frames; n++) connection.tell({ kind: 'pong', n });
    connection.close(command.code, command.reason);
  }
}

/** Minimal socket adapter: what was written, and how it was closed. */
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

  /** The `n` of every frame written, in order. */
  get frameNumbers(): number[] {
    return this.sent.map((data) => (JSON.parse(String(data)) as Out).n);
  }
}

/** A backend that binds nothing and only records the registration it is handed. */
class RecordingBackend implements HttpServerBackend {
  readonly name = 'recording';
  readonly websocketRoutes: WebsocketRouteRegistration[] = [];

  registerRoute(_route: RouteRegistration): void { /* no HTTP route here */ }

  registerWebSocket(registration: WebsocketRouteRegistration): void {
    this.websocketRoutes.push(registration);
  }

  async listen(host: string, port: number): Promise<ServerBinding> {
    return { host, port, unbind: async () => {} };
  }
}

const upgradeRequest: HttpRequest = {
  method: 'GET',
  path: '/ws',
  headers: {},
  query: {},
  params: {},
  body: null,
};

const systems: ActorSystem[] = [];

afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate()));
});

function newSystem(name: string, config: ConfigObject): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withConfig(config);
  const system = ActorSystem.create(name, systemOptions);
  systems.push(system);
  return system;
}

type BoundRoute = {
  readonly hub: WebsocketServerRef<Out, In, HubCommand>;
  /** Hand the route one upgraded socket, as a backend does, and wait until the hub has it. */
  readonly connect: () => Promise<{ readonly id: string; readonly socket: ProbeSocket }>;
};

async function bindRoute(
  name: string,
  config: ConfigObject,
  routeOptions?: WebsocketRouteOptions<Out, In>,
): Promise<BoundRoute> {
  const system = newSystem(name, config);
  const connected: string[] = [];
  // Factory form, not the class form: the hub takes a constructor argument.
  const hub = system.spawn(() => new BurstHub(connected), 'hub') as WebsocketServerRef<Out, In, HubCommand>;
  const backend = new RecordingBackend();
  await system.extension(HttpExtensionId)
    .newServerAt('127.0.0.1', 0)
    .useBackend(backend)
    .bind(websocket('/ws', hub, routeOptions));
  const registration = backend.websocketRoutes[0]!;

  const connect = async (): Promise<{ id: string; socket: ProbeSocket }> => {
    const socket = new ProbeSocket();
    const before = connected.length;
    registration.onConnection(upgradeRequest, socket);
    await awaitCondition(() => connected.length > before, {
      timeoutMs: 4_000,
      label: 'the hub registered the new connection',
    });
    return { id: connected[before]!, socket };
  };
  return { hub, connect };
}

/** Burst every connection in one hub turn, close them all, and wait for the close. */
async function burstAndCloseAll(route: BoundRoute, socket: ProbeSocket, label: string): Promise<void> {
  route.hub.tell({ kind: 'burst-then-close-all', frames: BURST, code: 1008, reason: 'rate limited' });
  await awaitCondition(() => socket.closeCalls.length > 0, { timeoutMs: 4_000, label });
  expect(socket.closeCalls).toEqual([{ code: 1008, reason: 'rate limited' }]);
}

describe('a route bounds its connection mailboxes (#1432)', () => {
  test('a drop-head bound sheds a one-turn burst, and closeAll() still closes the socket', async () => {
    const routeOptions = WebsocketRouteOptions.create<Out, In>()
      .withConnectionMailboxCapacity(1)
      .withConnectionMailboxOverflow('drop-head');
    const route = await bindRoute('ws-connection-bound-drop-head', {}, routeOptions);
    const { socket } = await route.connect();

    await burstAndCloseAll(route, socket, 'closeAll closed the bounded connection');
    // drop-head keeps the newest: of six frames, the last one survived.
    expect(socket.frameNumbers).toEqual([BURST - 1]);
  });

  test('a drop-new bound sheds a burst told to one connection, and close() still closes it', async () => {
    const routeOptions = WebsocketRouteOptions.create<Out, In>()
      .withConnectionMailboxCapacity(2)
      .withConnectionMailboxOverflow('drop-new');
    const route = await bindRoute('ws-connection-bound-drop-new', {}, routeOptions);
    const { id, socket } = await route.connect();

    route.hub.tell({ kind: 'burst-then-close', id, frames: BURST, code: 1000, reason: 'goodbye' });

    await awaitCondition(() => socket.closeCalls.length > 0, {
      timeoutMs: 4_000,
      label: 'close() closed the bounded connection',
    });
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'goodbye' }]);
    // drop-new keeps the oldest: the first two frames, and nothing after them.
    expect(socket.frameNumbers).toEqual([0, 1]);
  });

  test('the shipped default leaves a connection unbounded', async () => {
    // The control the next case leans on: with nothing configured anywhere,
    // all six frames are written, so a count below six means a bound bit.
    const route = await bindRoute('ws-connection-unbounded', {});
    const { socket } = await route.connect();

    await burstAndCloseAll(route, socket, 'closeAll closed the unbounded connection');
    expect(socket.frameNumbers).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('a route that sets nothing takes actor-ts.mailbox.default (#862)', async () => {
    const route = await bindRoute('ws-connection-global-bound', {
      'actor-ts': { mailbox: { default: { capacity: 1, overflow: 'drop-new' } } },
    });
    const { socket } = await route.connect();

    await burstAndCloseAll(route, socket, 'closeAll closed the globally bounded connection');
    expect(socket.frameNumbers).toEqual([0]);
  });

  test('a route value wins over the global bound, in capacity and in policy', async () => {
    const routeOptions = WebsocketRouteOptions.create<Out, In>()
      .withConnectionMailboxCapacity(4)
      .withConnectionMailboxOverflow('drop-head');
    const route = await bindRoute('ws-connection-route-over-global', {
      'actor-ts': { mailbox: { default: { capacity: 1, overflow: 'drop-new' } } },
    }, routeOptions);
    const { socket } = await route.connect();

    await burstAndCloseAll(route, socket, 'closeAll closed the route-bounded connection');
    // Four frames, and the newest four: both halves came from the route.
    expect(socket.frameNumbers).toEqual([2, 3, 4, 5]);
  });

  test('a route capacity without a policy takes the global overflow, not the built-in one', async () => {
    // The built-in default is drop-head; drop-new from the global block is
    // what keeps the first frames rather than the last.
    const routeOptions = WebsocketRouteOptions.create<Out, In>().withConnectionMailboxCapacity(2);
    const route = await bindRoute('ws-connection-global-overflow', {
      'actor-ts': { mailbox: { default: { overflow: 'drop-new' } } },
    }, routeOptions);
    const { socket } = await route.connect();

    await burstAndCloseAll(route, socket, 'closeAll closed the connection');
    expect(socket.frameNumbers).toEqual([0, 1]);
  });

  test('the HOCON leaves bound a route that sets nothing, and the route still wins over them', async () => {
    const hocon: ConfigObject = {
      'actor-ts': {
        http: { websocket: { 'connection-mailbox-capacity': 2, 'connection-mailbox-overflow': 'drop-new' } },
      },
    };
    const configured = await bindRoute('ws-connection-hocon-bound', hocon);
    const first = await configured.connect();
    await burstAndCloseAll(configured, first.socket, 'closeAll closed the HOCON-bounded connection');
    expect(first.socket.frameNumbers).toEqual([0, 1]);

    const routeOptions = WebsocketRouteOptions.create<Out, In>().withConnectionMailboxCapacity(3);
    const overridden = await bindRoute('ws-connection-route-over-hocon', hocon, routeOptions);
    const second = await overridden.connect();
    await burstAndCloseAll(overridden, second.socket, 'closeAll closed the route-bounded connection');
    // Three from the route, and still drop-new from the HOCON layer beneath it.
    expect(second.socket.frameNumbers).toEqual([0, 1, 2]);
  });

  test('an overflow with no capacity is refused at bind(), before any upgrade', async () => {
    const system = newSystem('ws-connection-overflow-alone', {});
    const hub = system.spawn(() => new BurstHub([]), 'hub') as WebsocketServerRef<Out, In, HubCommand>;
    const routeOptions = WebsocketRouteOptions.create<Out, In>().withConnectionMailboxOverflow('drop-new');
    const backend = new RecordingBackend();
    let refusal: unknown = null;
    try {
      await system.extension(HttpExtensionId)
        .newServerAt('127.0.0.1', 0)
        .useBackend(backend)
        .bind(websocket('/ws', hub, routeOptions));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(OptionsError);
    expect(String(refusal)).toMatch(/connectionMailboxOverflow/);
    // Refused before the backend was handed anything to accept upgrades on.
    expect(backend.websocketRoutes).toEqual([]);
  });
});
