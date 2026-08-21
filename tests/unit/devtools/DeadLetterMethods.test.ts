import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import { DeadLetterMethods } from '../../../src/devtools/deadletters/DeadLetterMethods.js';
import { DEAD_LETTER_ROWS } from '../../../src/devtools/protocol/index.js';
import type {
  DeadLettersResult,
  DevToolsRequestMethod,
} from '../../../src/devtools/protocol/index.js';
import type { DevToolsRequestHandler, DevToolsServer } from '../../../src/devtools/DevToolsServer.js';

/** Minimal stand-in that only collects the registered handlers. */
function fakeServer(): {
  server: DevToolsServer;
  invoke: (parameters?: unknown) => Promise<DeadLettersResult>;
} {
  const handlers = new Map<DevToolsRequestMethod, DevToolsRequestHandler>();
  const server = {
    registerMethod(method: DevToolsRequestMethod, handler: DevToolsRequestHandler): void {
      handlers.set(method, handler);
    },
  } as unknown as DevToolsServer;
  return {
    server,
    invoke: (parameters?: unknown): Promise<DeadLettersResult> => {
      const handler = handlers.get('deadletters.list');
      if (handler === undefined) throw new Error('not registered: deadletters.list');
      return handler(parameters) as Promise<DeadLettersResult>;
    },
  };
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
});

function newSystem(name: string, store: 'off' | 'memory', maxEntries = 500): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off)
    .withDeadLetters({ store, maxEntries });
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

/**
 * Put a letter in the queue by telling a path that has no actor.
 *
 * Goes through the real capture path rather than reaching into the ring:
 * what the panel shows is whatever the queue actually recorded, and a test
 * that wrote entries directly would pass even if capture were unwired.
 */
async function bury(system: ActorSystem, path: string, message: unknown): Promise<void> {
  const before = (await system.deadLetterQueue.list()).length;
  system.actorSelection(path).tell(message);
  await awaitCondition(
    async () => (await system.deadLetterQueue.list()).length > before,
    { label: `the letter to ${path} was captured` },
  );
}

describe('DeadLetterMethods', () => {
  test('lists captured letters newest first, with sender and recipient', async () => {
    const system = newSystem('dl-order', 'memory');
    const { server, invoke } = fakeServer();
    new DeadLetterMethods(system).install(server);

    await bury(system, '/user/gone-first', { kind: 'first' });
    await bury(system, '/user/gone-second', { kind: 'second' });

    const result = await invoke();
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]!.recipientPath).toContain('gone-second');
    expect(result.entries[1]!.recipientPath).toContain('gone-first');
    expect(result.total).toBe(2);
    expect(result.capacity).toBe(500);
  });

  test('carries the payload and names the message type', async () => {
    const system = newSystem('dl-payload', 'memory');
    const { server, invoke } = fakeServer();
    new DeadLetterMethods(system).install(server);

    await bury(system, '/user/gone', { kind: 'order', total: 42 });

    const [entry] = (await invoke()).entries;
    expect(entry!.payload).toEqual({ kind: 'order', total: 42 });
    expect(entry!.messageType).toBe('Object');
    expect(entry!.truncated).toBe(false);
    expect(entry!.degradedReason).toBeNull();
    expect(entry!.replayCount).toBe(0);
  });

  test('names a class-valued message by its constructor', async () => {
    class PlaceOrderCommand {
      constructor(readonly total: number) {}
    }
    const system = newSystem('dl-class', 'memory');
    const { server, invoke } = fakeServer();
    new DeadLetterMethods(system).install(server);

    await bury(system, '/user/gone', new PlaceOrderCommand(7));

    expect((await invoke()).entries[0]!.messageType).toBe('PlaceOrderCommand');
  });

  test('sanitises a payload the wire cannot carry', async () => {
    const system = newSystem('dl-cycle', 'memory');
    const { server, invoke } = fakeServer();
    new DeadLetterMethods(system).install(server);

    const cyclic: { kind: string; self?: unknown } = { kind: 'loop' };
    cyclic.self = cyclic;
    await bury(system, '/user/gone', cyclic);

    // The assertion that matters is that this survives JSON at all — an
    // unsanitised cycle throws in the frame encoder, i.e. on the socket,
    // where the failure is a dropped connection rather than a bad cell.
    const [entry] = (await invoke()).entries;
    expect(() => JSON.stringify(entry!.payload)).not.toThrow();
  });

  test('filters by recipient prefix, and counts only what it selected', async () => {
    const system = newSystem('dl-filter', 'memory');
    const { server, invoke } = fakeServer();
    new DeadLetterMethods(system).install(server);

    await bury(system, '/user/orders/a', { kind: 'a' });
    await bury(system, '/user/orders/b', { kind: 'b' });
    await bury(system, '/user/billing/c', { kind: 'c' });

    expect((await invoke()).total).toBe(3);
    const orders = await invoke({ recipient: '/user/orders' });
    expect(orders.entries).toHaveLength(2);
    // `total` counts the selection, not the ring: a panel showing two rows
    // must not report three, or the filter looks broken.
    expect(orders.total).toBe(2);
  });

  test('caps the page at DEAD_LETTER_ROWS while still counting the rest', async () => {
    const system = newSystem('dl-cap', 'memory', DEAD_LETTER_ROWS + 10);
    const { server, invoke } = fakeServer();
    new DeadLetterMethods(system).install(server);

    for (let index = 0; index < DEAD_LETTER_ROWS + 5; index++) {
      system.actorSelection('/user/gone').tell({ kind: 'x', index });
    }
    // Safe to poll on the count here, unlike the explain ring: the queue
    // is sized ABOVE what this sends, so nothing is dropped and the total
    // settles at exactly what was told rather than at the cap.
    await awaitCondition(
      async () => (await system.deadLetterQueue.list()).length >= DEAD_LETTER_ROWS + 5,
      { label: 'every message reached the queue' },
    );

    const result = await invoke();
    expect(result.entries).toHaveLength(DEAD_LETTER_ROWS);
    expect(result.total).toBe(DEAD_LETTER_ROWS + 5);
  });

  test('refuses a limit that is not a positive integer', async () => {
    const system = newSystem('dl-limit', 'memory');
    const { server, invoke } = fakeServer();
    new DeadLetterMethods(system).install(server);

    await expect(invoke({ limit: 0 })).rejects.toThrow('`limit` must be an integer >= 1');
    await expect(invoke({ limit: 1.5 })).rejects.toThrow('`limit` must be an integer >= 1');
    await expect(invoke({ recipient: 7 })).rejects.toThrow('`recipient` must be an actor path');
  });

  test('reports not-recording when the queue is off, and still answers', async () => {
    const system = newSystem('dl-off', 'off');
    const { server, invoke } = fakeServer();
    const methods = new DeadLetterMethods(system);
    methods.install(server);

    expect(methods.recording).toBe(false);
    system.actorSelection('/user/gone').tell({ kind: 'dropped' });
    // A fixed wait because the assertion IS an absence: there is no state
    // to poll for when the whole point is that nothing gets captured.
    await Bun.sleep(20);

    // An empty answer, not a thrown one: the panel is marked unavailable
    // by its status, and a client that asks anyway deserves a real reply.
    const result = await invoke();
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
  });

  test('reports recording when the queue keeps letters', () => {
    const system = newSystem('dl-on', 'memory');
    expect(new DeadLetterMethods(system).recording).toBe(true);
  });
});
