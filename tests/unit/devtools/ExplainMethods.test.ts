import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { Props } from '../../../src/Props.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { ExplainMethods } from '../../../src/devtools/taps/ExplainTap.js';
import type { DevToolsRequestMethod } from '../../../src/devtools/protocol/index.js';
import type {
  ExplainEntriesPayload,
  ExplainStatusResult,
} from '../../../src/devtools/protocol/index.js';
import type { DevToolsRequestHandler, DevToolsServer } from '../../../src/devtools/DevToolsServer.js';

class WorkerActor extends Actor<string> {
  override onReceive(): void {}
}

/** Minimal stand-in that only collects the registered handlers. */
function fakeServer(): {
  server: DevToolsServer;
  invoke: <T>(method: DevToolsRequestMethod, parameters?: unknown) => Promise<T>;
} {
  const handlers = new Map<DevToolsRequestMethod, DevToolsRequestHandler>();
  const server = {
    registerMethod(method: DevToolsRequestMethod, handler: DevToolsRequestHandler): void {
      handlers.set(method, handler);
    },
  } as unknown as DevToolsServer;
  return {
    server,
    invoke: <T>(method: DevToolsRequestMethod, parameters?: unknown): Promise<T> => {
      const handler = handlers.get(method);
      if (handler === undefined) throw new Error(`not registered: ${method}`);
      return handler(parameters) as Promise<T>;
    },
  };
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create().withLogger(new NoopLogger()).withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('ExplainMethods', () => {
  test('enables recording on a named actor', async () => {
    const system = newSystem('rpc-enable');
    const ref = system.spawn(Props.create(() => new WorkerActor()), 'target');
    const { server, invoke } = fakeServer();
    new ExplainMethods(system).install(server);

    const status = await invoke<ExplainStatusResult>('explain.enable', {
      path: ref.path.toString(),
    });
    expect(status).toEqual({ path: ref.path.toString(), enabled: true, capacity: 100 });
  });

  test('records and returns what the actor handled', async () => {
    const system = newSystem('rpc-fetch');
    const ref = system.spawn(Props.create(() => new WorkerActor()), 'target');
    const { server, invoke } = fakeServer();
    new ExplainMethods(system).install(server);

    await invoke('explain.enable', { path: ref.path.toString() });
    ref.tell('one');
    ref.tell('two');
    await settle();

    const payload = await invoke<ExplainEntriesPayload>('explain.fetch', {
      path: ref.path.toString(),
    });
    expect(payload.kind).toBe('explain-entries');
    expect(payload.capacity).toBe(100);
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0]!.messageType).toBe('String');
    expect(payload.entries[0]!.outcome).toBe('ok');
  });

  test('honours a requested capacity', async () => {
    const system = newSystem('rpc-capacity');
    const ref = system.spawn(Props.create(() => new WorkerActor()), 'target');
    const { server, invoke } = fakeServer();
    new ExplainMethods(system).install(server);

    await invoke('explain.enable', { path: ref.path.toString(), capacity: 2 });
    for (let i = 0; i < 5; i++) ref.tell(`m${i}`);
    await settle();

    const payload = await invoke<ExplainEntriesPayload>('explain.fetch', {
      path: ref.path.toString(),
    });
    expect(payload.entries).toHaveLength(2);
  });

  test('caps an absurd capacity rather than letting a ring become a log', async () => {
    const system = newSystem('rpc-cap');
    const ref = system.spawn(Props.create(() => new WorkerActor()), 'target');
    const { server, invoke } = fakeServer();
    new ExplainMethods(system).install(server);

    const status = await invoke<ExplainStatusResult>('explain.enable', {
      path: ref.path.toString(),
      capacity: 5_000_000,
    });
    expect(status.capacity).toBe(10_000);
  });

  test('disabling stops recording', async () => {
    const system = newSystem('rpc-disable');
    const ref = system.spawn(Props.create(() => new WorkerActor()), 'target');
    const { server, invoke } = fakeServer();
    new ExplainMethods(system).install(server);

    await invoke('explain.enable', { path: ref.path.toString() });
    ref.tell('recorded');
    await settle();
    await invoke('explain.disable', { path: ref.path.toString() });

    const payload = await invoke<ExplainEntriesPayload>('explain.fetch', {
      path: ref.path.toString(),
    });
    expect(payload.entries).toEqual([]);
    expect(payload.capacity).toBe(0);
  });

  test('uninstall leaves no actor recording behind', async () => {
    // A ring left running because a browser tab closed is a leak the
    // developer never asked for.
    const system = newSystem('rpc-cleanup');
    const ref = system.spawn(Props.create(() => new WorkerActor()), 'target');
    const { server, invoke } = fakeServer();
    const methods = new ExplainMethods(system);
    methods.install(server);

    await invoke('explain.enable', { path: ref.path.toString() });
    methods.uninstall();

    const payload = await invoke<ExplainEntriesPayload>('explain.fetch', {
      path: ref.path.toString(),
    });
    expect(payload.capacity).toBe(0);
  });

  test('rejects an unknown actor with a usable message', async () => {
    const system = newSystem('rpc-missing');
    const { server, invoke } = fakeServer();
    new ExplainMethods(system).install(server);

    await expect(invoke('explain.enable', {
      path: 'actor-ts://rpc-missing/user/nope',
    })).rejects.toThrow(/no such actor/);
  });

  test('rejects a missing or malformed path', async () => {
    const system = newSystem('rpc-badpath');
    const { server, invoke } = fakeServer();
    new ExplainMethods(system).install(server);

    await expect(invoke('explain.fetch', {})).rejects.toThrow(/path/);
    await expect(invoke('explain.enable', { path: 42 })).rejects.toThrow(/path/);
  });

  test('rejects a nonsensical capacity', async () => {
    const system = newSystem('rpc-badcapacity');
    const ref = system.spawn(Props.create(() => new WorkerActor()), 'target');
    const { server, invoke } = fakeServer();
    new ExplainMethods(system).install(server);

    await expect(invoke('explain.enable', { path: ref.path.toString(), capacity: 0 }))
      .rejects.toThrow(/capacity/);
    await expect(invoke('explain.enable', { path: ref.path.toString(), capacity: 1.5 }))
      .rejects.toThrow(/capacity/);
  });
});
