import { afterEach, describe, expect, test } from 'bun:test';
import { Actor } from '../../../src/Actor.js';
import { ActorSystem } from '../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../src/Logger.js';
import { SendMethods } from '../../../src/devtools/send/SendMethods.js';
import { SEND_MESSAGE_MAX_BYTES } from '../../../src/devtools/protocol/index.js';
import { awaitCondition } from '../../util/AwaitCondition.js';
import type {
  DevToolsRequestMethod,
  SendMessageResult,
} from '../../../src/devtools/protocol/index.js';
import type { DevToolsRequestHandler, DevToolsServer } from '../../../src/devtools/DevToolsServer.js';

type Received = { readonly message: unknown; readonly hadSender: boolean };

class RecordingActor extends Actor<Record<string, unknown>> {
  static received: Received[] = [];
  override onReceive(message: Record<string, unknown>): void {
    // `sender` is an `Option<ActorRef>`, not a ref — a `tell` that carried
    // none yields `None`, which is neither null nor a ref with a path.
    RecordingActor.received.push({ message, hadSender: this.sender.isSome() });
  }
}

/** Minimal stand-in that only collects the registered handlers. */
function fakeServer(): {
  server: DevToolsServer;
  registered: () => DevToolsRequestMethod[];
  invoke: (parameters?: unknown) => Promise<SendMessageResult>;
} {
  const handlers = new Map<DevToolsRequestMethod, DevToolsRequestHandler>();
  const server = {
    registerMethod(method: DevToolsRequestMethod, handler: DevToolsRequestHandler): void {
      handlers.set(method, handler);
    },
  } as unknown as DevToolsServer;
  return {
    server,
    registered: () => [...handlers.keys()],
    invoke: (parameters?: unknown): Promise<SendMessageResult> => {
      const handler = handlers.get('actors.send');
      if (handler === undefined) throw new Error('not registered: actors.send');
      return handler(parameters) as Promise<SendMessageResult>;
    },
  };
}

const systems: ActorSystem[] = [];
afterEach(async () => {
  for (const system of systems.splice(0)) await system.terminate();
  RecordingActor.received = [];
});

function newSystem(name: string): ActorSystem {
  const options = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  const system = ActorSystem.create(name, options);
  systems.push(system);
  return system;
}

describe('SendMethods', () => {
  test('delivers a JSON message to a user actor', async () => {
    const system = newSystem('send-ok');
    system.spawn(RecordingActor, 'target');
    const { server, invoke } = fakeServer();
    new SendMethods(system).install(server);

    const result = await invoke({
      path: '/user/target',
      body: JSON.stringify({ kind: 'increment', by: 2 }),
    });

    await awaitCondition(() => RecordingActor.received.length >= 1,
      { label: 'the message was handled' });
    expect(RecordingActor.received[0]!.message).toEqual({ kind: 'increment', by: 2 });
    expect(result.path).toContain('/user/target');
    // Named by its `kind`, which is this project's discriminant — every
    // panel that lists messages shows a type, and "Object" for all of them
    // would be no answer at all.
    expect(result.messageType).toBe('increment');
  });

  test('sends with no sender, rather than forging one', async () => {
    const system = newSystem('send-nosender');
    system.spawn(RecordingActor, 'target');
    const { server, invoke } = fakeServer();
    new SendMethods(system).install(server);

    await invoke({ path: '/user/target', body: '{"kind":"ping"}' });
    await awaitCondition(() => RecordingActor.received.length >= 1,
      { label: 'the message was handled' });

    // A forged sender would point the recipient's `sender` at an actor that
    // never sent anything, and a reply would go somewhere nobody expects.
    expect(RecordingActor.received[0]!.hadSender).toBe(false);
  });

  test('refuses a recipient outside the user guardian', async () => {
    const system = newSystem('send-system');
    const { server, invoke } = fakeServer();
    new SendMethods(system).install(server);

    // System actors are the framework's own machinery, and this is a write
    // endpoint reachable from a browser.
    await expect(invoke({ path: '/system/devtools', body: '{"kind":"x"}' }))
      .rejects.toThrow('only actors under /user');
  });

  test('refuses an actor that does not exist', async () => {
    const system = newSystem('send-missing');
    const { server, invoke } = fakeServer();
    new SendMethods(system).install(server);

    await expect(invoke({ path: '/user/nobody', body: '{"kind":"x"}' }))
      .rejects.toThrow('no such actor');
  });

  test('refuses a body that is not valid JSON', async () => {
    const system = newSystem('send-badjson');
    system.spawn(RecordingActor, 'target');
    const { server, invoke } = fakeServer();
    new SendMethods(system).install(server);

    await expect(invoke({ path: '/user/target', body: '{not json' }))
      .rejects.toThrow('not valid JSON');
    expect(RecordingActor.received).toEqual([]);
  });

  test('refuses a bare value, which is almost always a mistyped body', async () => {
    const system = newSystem('send-bare');
    system.spawn(RecordingActor, 'target');
    const { server, invoke } = fakeServer();
    new SendMethods(system).install(server);

    await expect(invoke({ path: '/user/target', body: '42' }))
      .rejects.toThrow('must be a JSON object or array');
    await expect(invoke({ path: '/user/target', body: '"hello"' }))
      .rejects.toThrow('must be a JSON object or array');
    await expect(invoke({ path: '/user/target', body: 'null' }))
      .rejects.toThrow('must be a JSON object or array');
  });

  test('refuses a body past the size cap', async () => {
    const system = newSystem('send-huge');
    system.spawn(RecordingActor, 'target');
    const { server, invoke } = fakeServer();
    new SendMethods(system).install(server);

    // An unbounded field on a write endpoint is a way to push arbitrary
    // amounts of memory into a mailbox from a browser.
    const body = JSON.stringify({ kind: 'big', filler: 'x'.repeat(SEND_MESSAGE_MAX_BYTES) });
    await expect(invoke({ path: '/user/target', body }))
      .rejects.toThrow('the limit is');
    expect(RecordingActor.received).toEqual([]);
  });

  test('refuses a missing path or body', async () => {
    const system = newSystem('send-missing-args');
    const { server, invoke } = fakeServer();
    new SendMethods(system).install(server);

    await expect(invoke({ body: '{"kind":"x"}' })).rejects.toThrow('`path` is required');
    await expect(invoke({ path: '/user/target' })).rejects.toThrow('`body` is required');
    await expect(invoke({ path: '/user/target', body: '   ' })).rejects.toThrow('`body` is required');
  });

  test('accepts an array body, and names it', async () => {
    const system = newSystem('send-array');
    system.spawn(RecordingActor, 'target');
    const { server, invoke } = fakeServer();
    new SendMethods(system).install(server);

    const result = await invoke({ path: '/user/target', body: '[1,2,3]' });
    expect(result.messageType).toBe('Array');
  });

  test('registers exactly one method, and only that one', async () => {
    const system = newSystem('send-surface');
    const { server, registered } = fakeServer();
    new SendMethods(system).install(server);

    // The write surface is one method wide; anything else here would be a
    // capability nobody acknowledged.
    expect(registered()).toEqual(['actors.send']);
  });
});
