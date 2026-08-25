import { afterEach, describe, expect, test } from 'bun:test';
import { ActorPath } from '../../../src/ActorPath.js';
import { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import {
  MAXIMUM_HUB_CONNECTIONS,
  MAXIMUM_IN_FLIGHT_REQUESTS,
  MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION,
} from '../../../src/devtools/Constants.js';
import { DevToolsServer } from '../../../src/devtools/DevToolsServer.js';
import type { DevToolsOptionsType } from '../../../src/devtools/DevToolsOptions.js';
import {
  DevToolsHubActor,
  type DevToolsHubCommand,
  type DevToolsHubContext,
} from '../../../src/devtools/internal/DevToolsHubActor.js';
import {
  helloFrame,
  type DevToolsRequestMethod,
  type DevToolsServerFrame,
  type DevToolsStreamId,
  type DevToolsStreamPayload,
  type ErrorFrame,
  type WelcomeFrame,
} from '../../../src/devtools/protocol/index.js';
import { compile } from '../../../src/http/Route.js';
import type { WebsocketConnection } from '../../../src/http/websocket/WebsocketConnection.js';
import {
  websocketConnectedSignal,
  websocketDataSignal,
  websocketDisconnectedSignal,
  type WebsocketServerMessage,
} from '../../../src/http/websocket/WebsocketMessages.js';
import type { WebsocketFrame, WebsocketUpgradeInfo } from '../../../src/http/websocket/Types.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

type HubRef = ActorRef<WebsocketServerMessage<DevToolsServerFrame, unknown, DevToolsHubCommand>>;

/**
 * A connection with no socket behind it.  The hub only ever asks a
 * connection for its `id`, whether it is open, and to `tell` a frame, so a
 * recording stand-in exercises the real dispatch path — signals through
 * the real mailbox, in real order — without a port.
 */
class FakeConnection extends ActorRef<DevToolsServerFrame> implements WebsocketConnection<DevToolsServerFrame> {
  readonly path: ActorPath;
  readonly received: DevToolsServerFrame[] = [];
  readonly upgrade: WebsocketUpgradeInfo = { path: '/api/ws', params: {}, query: {}, headers: {} };
  isOpen = true;

  constructor(readonly id: string) {
    super();
    this.path = new ActorPath(`ws-conn-${id}`, null, 'devtools-in-flight');
  }

  override tell(message: DevToolsServerFrame): void {
    this.received.push(message);
  }

  sendRaw(_frame: WebsocketFrame): void {}

  close(): void {
    this.isOpen = false;
  }

  /** Frames answering `requestId`, in arrival order. */
  answersTo(requestId: number): DevToolsServerFrame[] {
    return this.received.filter(
      (frame) => (frame.kind === 'response' || frame.kind === 'error') && frame.requestId === requestId,
    );
  }
}

/**
 * A hub context whose `invoke` never settles on its own — the shape the
 * issue is about.  A real `replay.diff` folds a whole journal; here the
 * test decides when each one finishes, so "in flight" is exact rather
 * than a race against a timer.
 */
class ManualHub implements DevToolsHubContext {
  /** One entry per dispatched invocation, each settleable on demand. */
  readonly dispatched: Array<() => void> = [];

  welcome(): Omit<WelcomeFrame, 'kind' | 'protocolVersion'> {
    return {
      serverVersion: '0.0.0-test',
      systemName: 'devtools-in-flight',
      startedAtMs: 0,
      streams: [],
      panels: [],
    };
  }

  isStreamAvailable(_stream: DevToolsStreamId): boolean {
    return false;
  }

  snapshot(_stream: DevToolsStreamId): ReadonlyArray<DevToolsStreamPayload> {
    return [];
  }

  isMethodAvailable(_method: DevToolsRequestMethod): boolean {
    return true;
  }

  invoke(_method: DevToolsRequestMethod, _parameters: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve) => {
      this.dispatched.push(() => resolve(null));
    });
  }

  streamSubscribersChanged(_stream: DevToolsStreamId, _count: number): void {}

  /** Finish every outstanding invocation and let the hub release the slots. */
  async settleAll(): Promise<void> {
    for (const settle of this.dispatched.splice(0)) settle();
    // Settlement runs in a `.finally`, a microtask behind the resolve.
    await Promise.resolve();
    await Promise.resolve();
  }
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => {})));
});

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

function newHub(): { hub: HubRef; manual: ManualHub } {
  const manual = new ManualHub();
  const hub = newSystem('devtools-in-flight').spawn(() => new DevToolsHubActor(manual), 'devtools-hub');
  return { hub, manual };
}

/** Complete the handshake, so the hub will accept request frames. */
async function connect(hub: HubRef, id: string): Promise<FakeConnection> {
  const connection = new FakeConnection(id);
  hub.tell(websocketConnectedSignal(connection));
  hub.tell(websocketDataSignal(connection, helloFrame(id)));
  await awaitCondition(() => connection.received.some((frame) => frame.kind === 'welcome'), {
    label: `connection ${id} completed the DevTools handshake`,
  });
  return connection;
}

function disconnect(hub: HubRef, connection: FakeConnection): void {
  connection.close();
  hub.tell(websocketDisconnectedSignal(connection, { code: 1000, reason: '', initiatedBy: 'client' }));
}

/** Send `count` request frames, numbered from `firstRequestId`. */
function requestMany(hub: HubRef, connection: FakeConnection, firstRequestId: number, count: number): void {
  for (let offset = 0; offset < count; offset++) {
    hub.tell(websocketDataSignal(connection, {
      kind: 'request',
      requestId: firstRequestId + offset,
      method: 'journal.ids' satisfies DevToolsRequestMethod,
    }));
  }
}

/** The single frame answering `requestId`, once the hub has produced one. */
async function answerTo(connection: FakeConnection, requestId: number): Promise<DevToolsServerFrame> {
  await awaitCondition(() => connection.answersTo(requestId).length > 0, {
    label: `the hub answered request ${requestId}`,
  });
  return connection.answersTo(requestId)[0]!;
}

/**
 * Fill the hub-wide ceiling from fresh sessions, each taking as much of
 * its own budget as is still needed, and return them.  `alreadyInFlight`
 * says how many slots the caller believes are already taken — passing 0
 * and reaching the ceiling is itself the assertion that none were.
 */
async function saturateHubCeiling(
  hub: HubRef,
  manual: ManualHub,
  namePrefix: string,
): Promise<FakeConnection[]> {
  const connections: FakeConnection[] = [];
  const before = manual.dispatched.length;
  let dispatched = 0;
  while (dispatched < MAXIMUM_IN_FLIGHT_REQUESTS) {
    const connection = await connect(hub, `${namePrefix}-${connections.length + 1}`);
    connections.push(connection);
    const count = Math.min(MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION, MAXIMUM_IN_FLIGHT_REQUESTS - dispatched);
    requestMany(hub, connection, 1, count);
    dispatched += count;
    await awaitCondition(() => manual.dispatched.length === before + dispatched, {
      label: `the hub dispatched ${dispatched} requests`,
    });
  }
  return connections;
}

// #758 — `onRequest` dispatches `void this.hub.invoke(...)` on purpose, so a
// slow journal read cannot stall the hub's mailbox.  That also removes the
// mailbox as the thing serialising the work: with nothing counting, one
// client can hold thousands of concurrent journal reads and full-state
// replays against a process it shares with the application's own actors.
describe('DevTools hub in-flight request cap (#758)', () => {
  test('the caps stand in the relation the hub relies on', () => {
    // The global cap is the one that binds, and it has to be reachable by
    // fewer sessions than the route admits — otherwise saturating it is
    // impossible and the per-session cap is the only real bound.
    expect(MAXIMUM_IN_FLIGHT_REQUESTS).toBeGreaterThan(MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION);
    expect(MAXIMUM_HUB_CONNECTIONS * MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION)
      .toBeGreaterThan(MAXIMUM_IN_FLIGHT_REQUESTS);
  });

  test('one session may saturate its own cap and no more', async () => {
    const { hub, manual } = newHub();
    const connection = await connect(hub, 'ws-1');

    requestMany(hub, connection, 1, MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION);
    await awaitCondition(() => manual.dispatched.length === MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION, {
      label: 'the hub dispatched a full session\'s worth of requests',
    });

    const overflowId = MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION + 1;
    requestMany(hub, connection, overflowId, 1);
    const answer = await answerTo(connection, overflowId);

    expect(answer.kind).toBe('error');
    expect((answer as ErrorFrame).code).toBe('unavailable');
    expect((answer as ErrorFrame).message).toContain('in flight');
    // Rejected, not queued: the work never reached the hub context.
    expect(manual.dispatched.length).toBe(MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION);
    // And nothing that was admitted was disturbed by the rejection.
    expect(connection.answersTo(1)).toHaveLength(0);
  });

  test('a settled request hands its slot back to the same session', async () => {
    const { hub, manual } = newHub();
    const connection = await connect(hub, 'ws-1');

    requestMany(hub, connection, 1, MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION);
    await awaitCondition(() => manual.dispatched.length === MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION, {
      label: 'the hub dispatched a full session\'s worth of requests',
    });

    manual.dispatched.shift()!();
    await awaitCondition(() => connection.answersTo(1).length > 0, {
      label: 'the hub answered the request it just settled',
    });
    expect(connection.answersTo(1)[0]!.kind).toBe('response');

    const nextId = MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION + 1;
    requestMany(hub, connection, nextId, 1);
    await awaitCondition(() => manual.dispatched.length === MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION, {
      label: 'the freed slot admitted the next request',
    });
    expect(connection.answersTo(nextId)).toHaveLength(0);

    // ...and the cap closes again behind it, so the release is one slot
    // and not an amnesty.
    const overflowId = nextId + 1;
    requestMany(hub, connection, overflowId, 1);
    const answer = await answerTo(connection, overflowId);
    expect((answer as ErrorFrame).code).toBe('unavailable');
    expect(manual.dispatched.length).toBe(MAXIMUM_IN_FLIGHT_REQUESTS_PER_SESSION);
  });

  test('many sessions cannot multiply their way past the hub-wide ceiling', async () => {
    // The per-session cap alone bounds one socket, not the hub: the route
    // used to admit unlimited connections, so N of them meant N times the
    // per-session cap.  This is the bound that does not count sockets.
    const { hub, manual } = newHub();
    await saturateHubCeiling(hub, manual, 'ws');

    // A brand-new session, its own per-session budget untouched.
    const latecomer = await connect(hub, 'ws-latecomer');
    requestMany(hub, latecomer, 1, 1);
    const answer = await answerTo(latecomer, 1);

    expect(answer.kind).toBe('error');
    expect((answer as ErrorFrame).code).toBe('unavailable');
    expect((answer as ErrorFrame).message).toContain('all connections');
    expect(manual.dispatched.length).toBe(MAXIMUM_IN_FLIGHT_REQUESTS);
  });

  test('a session that drops mid-request still gives its hub-wide slots back', async () => {
    // A socket can close while its replay is still folding, so the release
    // has to survive the session being gone.  Releasing only through the
    // session object would wedge the hub at its ceiling for good.
    const { hub, manual } = newHub();
    const saturating = await saturateHubCeiling(hub, manual, 'ws');

    for (const connection of saturating) disconnect(hub, connection);
    await awaitCondition(() => saturating.every((connection) => !connection.isOpen), {
      label: 'every saturating session disconnected',
    });
    await manual.settleAll();
    expect(manual.dispatched).toHaveLength(0);

    // The whole ceiling has to be reachable a second time.  Releasing the
    // hub-wide slot only through the session object would leave every one
    // of those requests counted forever, and the first line below would
    // already come back `unavailable`.
    await saturateHubCeiling(hub, manual, 'ws-second');
    const latecomer = await connect(hub, 'ws-second-latecomer');
    requestMany(hub, latecomer, 1, 1);
    const answer = await answerTo(latecomer, 1);
    expect((answer as ErrorFrame).code).toBe('unavailable');
    expect((answer as ErrorFrame).message).toContain('all connections');
  });

  test('the tap route caps concurrent connections', async () => {
    // The socket half: the hub keeps a session per connection, and the
    // route default is `Infinity`.
    const system = newSystem('devtools-connection-cap');
    const server = new DevToolsServer(
      system,
      { port: 0, host: '127.0.0.1' } as DevToolsOptionsType,
    );
    server.start();
    const endpoint = compile(server.routes()).find((route) => route.kind === 'websocket');
    if (!endpoint || endpoint.kind !== 'websocket') throw new Error('expected a websocket endpoint');

    expect(endpoint.resolvePolicy(system).maxConnections).toBe(MAXIMUM_HUB_CONNECTIONS);
  });
});
