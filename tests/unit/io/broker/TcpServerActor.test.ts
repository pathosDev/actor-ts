/**
 * Unit tests for `TcpServerActor` (#158) — the TCP listener half.
 *
 * These bind a real socket on `127.0.0.1:0` and dial it with `node:net`
 * rather than stubbing `runtime/tcp`.  A listener is exactly the kind of
 * thing a mock cannot vouch for: the accept path, the framing across chunk
 * boundaries and the FIN handling are the behaviour under test, and all three
 * live below any seam a mock could occupy.  Port 0 keeps them parallel-safe.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { Actor } from '../../../../src/Actor.js';
import type { ActorRef } from '../../../../src/ActorRef.js';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel, NoopLogger } from '../../../../src/Logger.js';
import { TcpServerActor, type TcpServerCommand, type TcpServerMessage } from '../../../../src/io/broker/TcpServerActor.js';
import { TcpServerOptions, type TcpServerOptionsBuilder } from '../../../../src/io/broker/TcpServerOptions.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';

/** Records everything the listener pushes at its target. */
class CollectingTarget extends Actor<TcpServerMessage> {
  readonly received: TcpServerMessage[] = [];
  override onReceive(message: TcpServerMessage): void {
    this.received.push(message);
  }
  /** Ids seen opening, in arrival order. */
  openedIds(): string[] {
    return this.received.filter((m) => m.kind === 'connectionOpened').map((m) => m.connectionId);
  }
  /** Frame payloads decoded to text, in arrival order. */
  frameTexts(): string[] {
    return this.received
      .filter((m): m is Extract<TcpServerMessage, { kind: 'frame' }> => m.kind === 'frame')
      .map((m) => typeof m.payload === 'string' ? m.payload : new TextDecoder().decode(m.payload));
  }
  closedIds(): string[] {
    return this.received.filter((m) => m.kind === 'connectionClosed').map((m) => m.connectionId);
  }
}

type Harness = {
  readonly system: ActorSystem;
  readonly serverRef: ActorRef<TcpServerCommand>;
  readonly server: TcpServerActor;
  readonly target: CollectingTarget;
  readonly port: number;
};

const openHarnesses: Harness[] = [];
const openClients: net.Socket[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) client.destroy();
  for (const harness of openHarnesses.splice(0)) await harness.system.terminate();
});

function newSystem(name: string): ActorSystem {
  const systemOptions = ActorSystemOptions.create()
    .withLogger(new NoopLogger())
    .withLogLevel(LogLevel.Off);
  return ActorSystem.create(name, systemOptions);
}

/** Boot a listener on an OS-picked port and wait until it is actually bound. */
async function boot(name: string, customize: (o: TcpServerOptionsBuilder) => TcpServerOptionsBuilder = (o) => o): Promise<Harness> {
  const system = newSystem(name);
  const target = new CollectingTarget();
  const targetRef = system.spawn(() => target, 'target') as ActorRef<TcpServerMessage>;
  const serverOptions = customize(
    TcpServerOptions.create()
      .withBindHost('127.0.0.1')
      .withBindPort(0)
      .withTarget(targetRef),
  );
  const held = { current: null as TcpServerActor | null };
  const serverRef = system.spawn(() => {
    const created = new TcpServerActor(serverOptions);
    held.current = created;
    return created;
  }, 'tcp-server') as ActorRef<TcpServerCommand>;
  // boundPort is the strongest observable "listening" signal — it is written
  // from the resolved listen(), so a non-zero value cannot precede the bind.
  await awaitCondition(() => (held.current?.boundPort ?? 0) > 0, {
    label: 'TcpServerActor bound its listening port',
  });
  const harness: Harness = {
    system, serverRef, server: held.current!, target, port: held.current!.boundPort,
  };
  openHarnesses.push(harness);
  return harness;
}

/** Dial the listener and resolve once the TCP connection is up. */
function dial(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    openClients.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('TcpServerActor — accept and frame', () => {
  test('binds, accepts a connection and announces it with the peer address', async () => {
    const harness = await boot('tcp-server-accept');
    await dial(harness.port);

    await awaitCondition(() => harness.target.openedIds().length === 1, {
      label: 'the listener announced the accepted connection',
    });
    const opened = harness.target.received[0]!;
    expect(opened.kind).toBe('connectionOpened');
    expect(harness.server.connectionCount).toBe(1);
    if (opened.kind === 'connectionOpened') {
      expect(opened.remoteAddress).toContain('127.0.0.1');
    }
  });

  test('lines framing cuts inbound frames per connection, across chunks', async () => {
    const harness = await boot('tcp-server-lines', (o) => o.withFraming({ kind: 'lines' }));
    const client = await dial(harness.port);

    // Split mid-frame on purpose: re-assembly is the whole point of framing.
    client.write('alpha\nbe');
    client.write('ta\ngamma');   // 'gamma' stays pending — no terminator yet

    await awaitCondition(() => harness.target.frameTexts().length === 2, {
      label: 'both terminated lines arrived as frames',
    });
    expect(harness.target.frameTexts()).toEqual(['alpha', 'beta']);
  });

  test('two connections get distinct ids and their own frame buffers', async () => {
    const harness = await boot('tcp-server-two', (o) => o.withFraming({ kind: 'lines' }));
    const first = await dial(harness.port);
    const second = await dial(harness.port);

    await awaitCondition(() => harness.target.openedIds().length === 2, {
      label: 'both connections were announced',
    });
    const [firstId, secondId] = harness.target.openedIds();
    expect(firstId).not.toBe(secondId);

    // Interleave partial writes: a shared buffer would splice them together.
    first.write('one-');
    second.write('two-');
    first.write('a\n');
    second.write('b\n');

    await awaitCondition(() => harness.target.frameTexts().length === 2, {
      label: 'both connections completed their line',
    });
    expect(harness.target.frameTexts().sort()).toEqual(['one-a', 'two-b']);
  });
});

describe('TcpServerActor — outbound commands', () => {
  test('send writes to exactly the addressed connection', async () => {
    const harness = await boot('tcp-server-send');
    const first = await dial(harness.port);
    const second = await dial(harness.port);
    await awaitCondition(() => harness.target.openedIds().length === 2, {
      label: 'both connections were announced',
    });
    const [firstId] = harness.target.openedIds();

    const firstSaw: string[] = [];
    const secondSaw: string[] = [];
    first.on('data', (chunk) => firstSaw.push(chunk.toString('utf8')));
    second.on('data', (chunk) => secondSaw.push(chunk.toString('utf8')));

    harness.serverRef.tell({ kind: 'send', connectionId: firstId!, payload: 'hello\n' });

    await awaitCondition(() => firstSaw.join('') === 'hello\n', {
      label: 'the addressed client received the payload',
    });
    expect(secondSaw).toEqual([]);
  });

  test('close ends one connection and announces it; the listener stays up', async () => {
    const harness = await boot('tcp-server-close');
    const first = await dial(harness.port);
    await awaitCondition(() => harness.target.openedIds().length === 1, {
      label: 'the first connection was announced',
    });
    const [firstId] = harness.target.openedIds();

    let firstEnded = false;
    first.on('close', () => { firstEnded = true; });
    harness.serverRef.tell({ kind: 'close', connectionId: firstId! });

    await awaitCondition(() => firstEnded, { label: 'the closed client saw its FIN' });
    await awaitCondition(() => harness.target.closedIds().length === 1, {
      label: 'the listener announced the close',
    });
    expect(harness.server.connectionCount).toBe(0);

    // The port is still serving: a fresh dial is accepted.
    await dial(harness.port);
    await awaitCondition(() => harness.target.openedIds().length === 2, {
      label: 'the listener accepted a connection after the close',
    });
  });

  test('a peer hanging up is announced as connectionClosed', async () => {
    const harness = await boot('tcp-server-peer-closed');
    const client = await dial(harness.port);
    await awaitCondition(() => harness.target.openedIds().length === 1, {
      label: 'the connection was announced',
    });

    client.end();
    await awaitCondition(() => harness.target.closedIds().length === 1, {
      label: 'the peer close was announced',
    });
    expect(harness.server.connectionCount).toBe(0);
  });

  test('a send naming an unknown connection is dropped, not fatal', async () => {
    const harness = await boot('tcp-server-unknown-id');
    await dial(harness.port);
    await awaitCondition(() => harness.target.openedIds().length === 1, {
      label: 'the connection was announced',
    });

    harness.serverRef.tell({ kind: 'send', connectionId: 'tcp-does-not-exist', payload: 'x' });

    // The listener must still be serving — a throw out of dispatchOutgoing
    // would have torn it down and rebound it.
    await dial(harness.port);
    await awaitCondition(() => harness.target.openedIds().length === 2, {
      label: 'the listener still accepts after an unknown-id send',
    });
    expect(harness.server.connectionCount).toBe(2);
  });
});

describe('TcpServerActor — bounds', () => {
  test('maxConnections refuses the connection past the cap', async () => {
    const harness = await boot('tcp-server-cap', (o) => o.withMaxConnections(1));
    await dial(harness.port);
    await awaitCondition(() => harness.target.openedIds().length === 1, {
      label: 'the first connection was admitted',
    });

    const refused = await dial(harness.port);
    let refusedClosed = false;
    refused.on('close', () => { refusedClosed = true; });

    await awaitCondition(() => refusedClosed, { label: 'the over-cap connection was closed' });
    expect(harness.server.connectionCount).toBe(1);
    expect(harness.target.openedIds().length).toBe(1);
  });

  test('a frame past maxLineLen drops that connection only', async () => {
    const harness = await boot(
      'tcp-server-overlong',
      (o) => o.withFraming({ kind: 'lines', maxLineLen: 8 }),
    );
    const offender = await dial(harness.port);
    const bystander = await dial(harness.port);
    await awaitCondition(() => harness.target.openedIds().length === 2, {
      label: 'both connections were announced',
    });

    let offenderClosed = false;
    offender.on('close', () => { offenderClosed = true; });
    offender.write('x'.repeat(40));   // no delimiter, well past the cap

    await awaitCondition(() => offenderClosed, { label: 'the offending connection was dropped' });
    expect(harness.server.connectionCount).toBe(1);

    // The bystander is untouched and still framing.
    bystander.write('fine\n');
    await awaitCondition(() => harness.target.frameTexts().includes('fine'), {
      label: 'the other connection kept working',
    });
  });
});

describe('TcpServerActor — teardown', () => {
  // Only the listener is stopped, not the system: the target has to outlive it
  // to observe the announcement at all — during a full `terminate()` the
  // target is being stopped too and the tell lands in dead letters.
  test('stopping the listener unbinds the port and announces every connection closed', async () => {
    const harness = await boot('tcp-server-unbind');
    await dial(harness.port);
    await awaitCondition(() => harness.target.openedIds().length === 1, {
      label: 'the connection was announced',
    });
    const port = harness.port;

    harness.system.stop(harness.serverRef);

    await awaitCondition(() => harness.target.closedIds().length === 1, {
      label: 'unbinding announced the connection closed',
    });
    // The port is free again: a fresh listener can take it.
    await awaitCondition(
      () => new Promise<boolean>((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
      }),
      { label: 'the listening port was released' },
    );
  });
});
