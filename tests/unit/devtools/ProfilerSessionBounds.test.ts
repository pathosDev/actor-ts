/**
 * Bounds on a profiling session (#973).
 *
 * A `profiler.start` with no `durationMs` — the frame the panel's Start button
 * sends — used to install a dispatch observer nothing but Stop or a detach
 * would ever remove, folding every message into a bucket map keyed per actor
 * path and so, under sharding, per entity.  Three bounds close it: a session
 * stops itself after `MAXIMUM_DURATION_MS` whether or not a duration was
 * asked for, the bucket map stops growing at `MAXIMUM_PROFILER_BUCKETS` and
 * the result says how much fell outside it, and a session ends when the
 * DevTools connection that started it closes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorPath } from '../../../src/ActorPath.js';
import { ActorRef } from '../../../src/ActorRef.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { MAXIMUM_DURATION_MS, MAXIMUM_PROFILER_BUCKETS } from '../../../src/devtools/Constants.js';
import {
  DevToolsServer,
  type DevToolsRequestHandler,
} from '../../../src/devtools/DevToolsServer.js';
import {
  DevToolsHubActor,
  type DevToolsHubCommand,
  type DevToolsHubContext,
} from '../../../src/devtools/internal/DevToolsHubActor.js';
import { ProfilerTap } from '../../../src/devtools/taps/ProfilerTap.js';
import {
  helloFrame,
  type DevToolsRequestMethod,
  type DevToolsServerFrame,
  type DevToolsStreamId,
  type DevToolsStreamPayload,
  type ProfilerStopResult,
  type WelcomeFrame,
} from '../../../src/devtools/protocol/index.js';
import type { WebsocketConnection } from '../../../src/http/websocket/WebsocketConnection.js';
import {
  websocketConnectedSignal,
  websocketDataSignal,
  websocketDisconnectedSignal,
  type WebsocketServerMessage,
} from '../../../src/http/websocket/WebsocketMessages.js';
import type { WebsocketFrame, WebsocketUpgradeInfo } from '../../../src/http/websocket/Types.js';
import type { DispatchObservation } from '../../../src/internal/Instrumentation.js';
import { ManualScheduler } from '../../../src/testkit/ManualScheduler.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

const systems: ActorSystem[] = [];
afterEach(async () => {
  await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => {})));
});

function newSystem(name: string, scheduler?: ManualScheduler): ActorSystem {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  if (scheduler !== undefined) options.withScheduler(scheduler);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

/** A server stand-in holding the two seams the tap registers on. */
function fakeServer(): {
  server: DevToolsServer;
  invoke: <T>(method: DevToolsRequestMethod, parameters?: unknown, connectionId?: string) => Promise<T>;
  closeConnection: (connectionId: string) => void;
} {
  const handlers = new Map<DevToolsRequestMethod, DevToolsRequestHandler>();
  const closeListeners: Array<(connectionId: string) => void> = [];
  const server = {
    registerMethod(method: DevToolsRequestMethod, handler: DevToolsRequestHandler): void {
      handlers.set(method, handler);
    },
    registerConnectionCloseListener(listener: (connectionId: string) => void): void {
      closeListeners.push(listener);
    },
  } as unknown as DevToolsServer;
  return {
    server,
    invoke: <T>(method: DevToolsRequestMethod, parameters?: unknown, connectionId?: string): Promise<T> => {
      const handler = handlers.get(method);
      if (handler === undefined) throw new Error(`not registered: ${method}`);
      return handler(parameters, connectionId) as Promise<T>;
    },
    closeConnection: (connectionId) => { for (const listener of closeListeners) listener(connectionId); },
  };
}

/** Let the promise chain behind an auto-stop or an abort run out. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function observation(actorPath: string, messageType: string): DispatchObservation {
  return {
    actorPath,
    className: 'EntityActor',
    messageType,
    handleTimeMs: 1,
    outcome: 'ok',
  } as DispatchObservation;
}

describe('ProfilerTap — a session with no durationMs stops itself (#973)', () => {
  test('the observer comes off at MAXIMUM_DURATION_MS and not before', async () => {
    const scheduler = new ManualScheduler();
    const system = newSystem('prof-bound-default', scheduler);
    const emitted: DevToolsStreamPayload[] = [];
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install((payload) => emitted.push(payload));
    tap.installMethods(server);
    try {
      await invoke('profiler.start', {});
      expect(system._dispatchObserver).not.toBeNull();

      scheduler.advance(MAXIMUM_DURATION_MS - 1);
      await drainMicrotasks();
      expect(system._dispatchObserver).not.toBeNull();

      scheduler.advance(1);
      await drainMicrotasks();
      expect(system._dispatchObserver).toBeNull();
      expect(emitted.some((payload) => payload.kind === 'profiler-completed')).toBe(true);
    } finally {
      tap.uninstall();
    }
  });

  test('the panel can still collect an auto-stopped profile with profiler.stop, once', async () => {
    // The panel answers `profiler-completed` by calling `profiler.stop`; with
    // the session already finished that call used to fail and the profile was
    // lost — which every session the panel starts would now hit at the limit.
    const scheduler = new ManualScheduler();
    const system = newSystem('prof-bound-collect', scheduler);
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      const started = await invoke<{ sessionId: string }>('profiler.start', {});
      scheduler.advance(MAXIMUM_DURATION_MS);
      await drainMicrotasks();
      expect(system._dispatchObserver).toBeNull();

      const result = await invoke<ProfilerStopResult>('profiler.stop');
      expect(result.sessionId).toBe(started.sessionId);
      await expect(invoke('profiler.stop')).rejects.toThrow(/no profiling session/);
    } finally {
      tap.uninstall();
    }
  });
});

describe('ProfilerTap — the bucket map is capped (#973)', () => {
  test('stops adding pairs at MAXIMUM_PROFILER_BUCKETS and reports what it left out', async () => {
    const system = newSystem('prof-bound-buckets');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      await invoke('profiler.start', {});
      const observer = system._dispatchObserver!;
      for (let i = 0; i < MAXIMUM_PROFILER_BUCKETS + 50; i++) {
        observer.onMessageProcessed(observation(`/user/region/shard/entity-${i}`, 'Deposit'));
      }
      // A pair the map already holds keeps counting past the cap.
      observer.onMessageProcessed(observation('/user/region/shard/entity-0', 'Deposit'));
      const result = await invoke<ProfilerStopResult>('profiler.stop');

      const profile = result.profile as {
        actorTs: { buckets: Array<{ actorPath: string; count: number }>; droppedSamples: number };
      };
      expect(profile.actorTs.buckets).toHaveLength(MAXIMUM_PROFILER_BUCKETS);
      expect(profile.actorTs.buckets.find((b) => b.actorPath.endsWith('/entity-0'))!.count).toBe(2);
      expect(profile.actorTs.droppedSamples).toBe(50);
      expect(result.droppedSamples).toBe(50);
      expect(result.sampleCount).toBe(MAXIMUM_PROFILER_BUCKETS + 1);
    } finally {
      tap.uninstall();
    }
  });

  test('a profile under the cap reports nothing dropped', async () => {
    const system = newSystem('prof-bound-under');
    const tap = new ProfilerTap(system);
    const { server, invoke } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      await invoke('profiler.start', {});
      system._dispatchObserver!.onMessageProcessed(observation('/user/a', 'Ping'));
      const result = await invoke<ProfilerStopResult>('profiler.stop');
      expect(result.droppedSamples).toBe(0);
    } finally {
      tap.uninstall();
    }
  });
});

describe('ProfilerTap — a session ends with the connection that started it (#973)', () => {
  test('closing the owning connection stops the session; closing another does not', async () => {
    const system = newSystem('prof-bound-owner');
    const tap = new ProfilerTap(system);
    const { server, invoke, closeConnection } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      await invoke('profiler.start', {}, 'connection-1');
      closeConnection('connection-2');
      await drainMicrotasks();
      expect(system._dispatchObserver).not.toBeNull();

      closeConnection('connection-1');
      await drainMicrotasks();
      expect(system._dispatchObserver).toBeNull();
      // Nobody is left to collect it, so the profile is discarded, not kept.
      await expect(invoke('profiler.stop')).rejects.toThrow(/no profiling session/);
    } finally {
      tap.uninstall();
    }
  });
});

describe('ProfilerTap — an auto-stopped profile is not held for a connection that left (#973)', () => {
  test('the owner closing drops the uncollected result', async () => {
    const scheduler = new ManualScheduler();
    const system = newSystem('prof-bound-owner-gone', scheduler);
    const tap = new ProfilerTap(system);
    const { server, invoke, closeConnection } = fakeServer();
    tap.install(() => {});
    tap.installMethods(server);
    try {
      await invoke('profiler.start', {}, 'connection-1');
      scheduler.advance(MAXIMUM_DURATION_MS);
      await drainMicrotasks();
      closeConnection('connection-1');
      await expect(invoke('profiler.stop')).rejects.toThrow(/no profiling session/);
    } finally {
      tap.uninstall();
    }
  });
});

describe('DevToolsServer — the requesting connection reaches the handler (#973)', () => {
  test('invoke hands the connection id to the handler, and connectionClosed reaches every listener', async () => {
    const system = newSystem('prof-bound-server');
    const server = new DevToolsServer(system, {});
    const seen: Array<string | undefined> = [];
    server.registerMethod('profiler.capabilities', async (_parameters, connectionId) => {
      seen.push(connectionId);
      return null;
    });
    const closed: string[] = [];
    server.registerConnectionCloseListener((connectionId) => closed.push(connectionId));

    await server.invoke('profiler.capabilities', {}, 'connection-7');
    server.connectionClosed('connection-7');

    expect(seen).toEqual(['connection-7']);
    expect(closed).toEqual(['connection-7']);
  });
});

/* ------------------------------ hub wiring ------------------------------ */

type HubRef = ActorRef<WebsocketServerMessage<DevToolsServerFrame, unknown, DevToolsHubCommand>>;

/** A connection with no socket behind it, as in `HubInFlightCap.test.ts`. */
class FakeConnection extends ActorRef<DevToolsServerFrame> implements WebsocketConnection<DevToolsServerFrame> {
  readonly path: ActorPath;
  readonly received: DevToolsServerFrame[] = [];
  readonly upgrade: WebsocketUpgradeInfo = { path: '/api/ws', params: {}, query: {}, headers: {} };
  isOpen = true;

  constructor(readonly id: string) {
    super();
    this.path = new ActorPath(`ws-conn-${id}`, null, 'devtools-profiler-bounds');
  }

  override tell(message: DevToolsServerFrame): void {
    this.received.push(message);
  }

  sendRaw(_frame: WebsocketFrame): void {}

  close(): void {
    this.isOpen = false;
  }

  abort(): void {
    this.isOpen = false;
  }
}

class RecordingHub implements DevToolsHubContext {
  readonly invokedBy: string[] = [];
  readonly closed: string[] = [];

  welcome(): Omit<WelcomeFrame, 'kind' | 'protocolVersion'> {
    return { serverVersion: '0.0.0-test', systemName: 'x', startedAtMs: 0, streams: [], panels: [] };
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

  invoke(_method: DevToolsRequestMethod, _parameters: unknown, connectionId: string): Promise<unknown> {
    this.invokedBy.push(connectionId);
    return Promise.resolve(null);
  }

  streamSubscribersChanged(_stream: DevToolsStreamId, _count: number): void {}

  connectionClosed(connectionId: string): void {
    this.closed.push(connectionId);
  }
}

describe('DevToolsHubActor — tells the server which connection asked and which one left (#973)', () => {
  test('a request carries its connection id, and a disconnect is reported by id', async () => {
    const context = new RecordingHub();
    const hub: HubRef = newSystem('prof-bound-hub')
      .spawn(() => new DevToolsHubActor(context), 'devtools-hub');
    const connection = new FakeConnection('ws-9');
    hub.tell(websocketConnectedSignal(connection));
    hub.tell(websocketDataSignal(connection, helloFrame('ws-9')));
    hub.tell(websocketDataSignal(connection, {
      kind: 'request', requestId: 1, method: 'profiler.capabilities' satisfies DevToolsRequestMethod,
    }));
    await awaitCondition(() => context.invokedBy.length === 1, { label: 'the hub dispatched the request' });

    connection.close();
    hub.tell(websocketDisconnectedSignal(connection, { code: 1000, reason: '', initiatedBy: 'client' }));
    await awaitCondition(() => context.closed.length === 1, { label: 'the hub reported the disconnect' });

    expect(context.invokedBy).toEqual(['ws-9']);
    expect(context.closed).toEqual(['ws-9']);
  });
});
