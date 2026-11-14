/**
 * #1303 — a `ClusterClient` decodes its contact points' frames through the
 * same tag allow-list a node does, and takes it the same two ways: from its
 * own options (`withWireDecode`) and from `actor-ts.serialization.wire` in
 * HOCON, through the registered `readWireDecodeOptionsFromConfig`.  A cluster
 * that widens the list for its nodes can then widen it for its clients, where
 * before the client always ran the built-in list.  The decode ceilings in
 * `actor-ts.serialization.read-constraints` reach it from HOCON as well.
 *
 * Driven through a fake `TcpBackend` in the client's private `backend` seam:
 * the frames are the real encoder's, decoded by the client's real decoder.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { LogLevel, type Logger } from '../../../src/Logger.js';
import type { LogContextData } from '../../../src/LogContext.js';
import { ClusterClient } from '../../../src/cluster/ClusterClient.js';
import { ClusterClientOptions, type ClusterClientOptionsBuilder } from '../../../src/cluster/ClusterClientOptions.js';
import type { ClusterClientReplyMessage } from '../../../src/cluster/ClusterClientReceptionist.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import { encodeFrame, FrameDecoder, type WireMessage } from '../../../src/cluster/Protocol.js';
import { CLUSTER_WIRE_VERSION } from '../../../src/cluster/WireVersion.js';
import { Config } from '../../../src/config/Config.js';
import type { TcpSocketHandlers, TcpSocketLike } from '../../../src/runtime/tcp/TcpBackend.js';
import { DEFAULT_WIRE_ADMITTED_TAGS, WireDecodeOptions } from '../../../src/serialization/WireDecodeOptions.js';
import { OptionsError } from '../../../src/util/OptionsValidator.js';

const PORT = 2551;

class RecordingLogger implements Logger {
  readonly level = LogLevel.Warn;
  readonly warnings: string[] = [];
  debug(): void {}
  info(): void {}
  warn(message: string): void { this.warnings.push(message); }
  error(): void {}
  withSource(): Logger { return this; }
  withFields(_fields: LogContextData): Logger { return this; }
}

class RecordingSocket implements TcpSocketLike {
  readonly writes: Uint8Array[] = [];
  ended = false;
  write(data: Uint8Array): boolean { this.writes.push(data); return true; }
  end(): void { this.ended = true; }
  destroy(): void { this.ended = true; }

  /** The askId of the one envelope the client wrote. */
  askId(): string {
    const decoder = new FrameDecoder();
    const frames = this.writes.flatMap((chunk) => decoder.push(chunk)) as unknown as Array<{ kind: string; askId?: string }>;
    return frames.find((frame) => frame.kind === 'cluster-client-envelope')!.askId!;
  }
}

/** A backend whose single dial opens, acknowledges the hello and hands its handlers to the test. */
class FakeBackend {
  readonly socket = new RecordingSocket();
  handlers: TcpSocketHandlers | null = null;

  connect(options: { handlers: TcpSocketHandlers }): Promise<TcpSocketLike> {
    this.handlers = options.handlers;
    options.handlers.onOpen(this.socket);
    options.handlers.onData(this.socket, encodeFrame({
      kind: 'hello-ack',
      wireVersion: CLUSTER_WIRE_VERSION,
      self: new NodeAddress('contact-point', '127.0.0.1', PORT, 'test-run').toJSON(),
    }));
    return Promise.resolve(this.socket);
  }

  listen(): never { throw new Error('a ClusterClient never listens'); }

  receive(bytes: Uint8Array): void { this.handlers!.onData(this.socket, bytes); }
}

function drain(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

const clients: ClusterClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

/** Ask once, answer with `body`, and report what the ask did and what the client logged. */
async function askAnsweredWith(
  body: unknown,
  options: ClusterClientOptions,
  config: Config,
): Promise<{ settled: boolean; value: unknown; warnings: string[]; ended: boolean }> {
  const log = new RecordingLogger();
  const client = new ClusterClient({ ...(options as object), logger: log } as ClusterClientOptions, config);
  clients.push(client);
  const backend = new FakeBackend();
  (client as unknown as { backend: unknown }).backend = backend;
  const state = { settled: false, value: undefined as unknown };
  void client.ask('/user/service', { kind: 'ping' }, 60_000).then(
    (value) => { state.settled = true; state.value = value; },
    (error: unknown) => { state.settled = true; state.value = error; },
  );
  for (let turn = 0; turn < 20 && backend.socket.writes.length < 2; turn++) await drain();
  const reply: ClusterClientReplyMessage = { kind: 'cluster-client-reply', askId: backend.socket.askId(), ok: true, body };
  backend.receive(encodeFrame(reply as unknown as WireMessage));
  await drain();
  return { ...state, warnings: log.warnings, ended: backend.socket.ended };
}

const contactPoints = (): ClusterClientOptionsBuilder =>
  ClusterClientOptions.create().withContactPoints([`contact-point@127.0.0.1:${PORT}`]);

const ADMITTING_REGEXP = [...DEFAULT_WIRE_ADMITTED_TAGS, 'regexp'] as const;

describe('ClusterClient wire decode options (#1303)', () => {
  test('on the built-in list a reply carrying a RegExp is refused, and the line names the tag', async () => {
    const outcome = await askAnsweredWith({ pattern: /x/ }, contactPoints(), Config.empty());
    expect(outcome.settled).toBe(false);
    expect(outcome.warnings.some((warning) => warning.includes("'regexp'"))).toBe(true);
    expect(outcome.ended).toBe(false);
  });

  test('withWireDecode widens the list for this client', async () => {
    const wireDecode = WireDecodeOptions.create().withAdmittedTags(ADMITTING_REGEXP);
    const options = contactPoints().withWireDecode(wireDecode);
    const outcome = await askAnsweredWith({ pattern: /x/ }, options, Config.empty());
    expect(outcome.settled).toBe(true);
    expect((outcome.value as { pattern: unknown }).pattern).toBeInstanceOf(RegExp);
  });

  test('actor-ts.serialization.wire.admitted-tags widens it from HOCON', async () => {
    const config = Config.parseString(`actor-ts.serialization.wire.admitted-tags = [${ADMITTING_REGEXP.join(', ')}]`);
    const outcome = await askAnsweredWith({ pattern: /x/ }, contactPoints(), config);
    expect(outcome.settled).toBe(true);
    expect((outcome.value as { pattern: unknown }).pattern).toBeInstanceOf(RegExp);
  });

  test('the explicit option beats HOCON', async () => {
    const config = Config.parseString(`actor-ts.serialization.wire.admitted-tags = [${ADMITTING_REGEXP.join(', ')}]`);
    const wireDecode = WireDecodeOptions.create().withAdmittedTags(DEFAULT_WIRE_ADMITTED_TAGS);
    const outcome = await askAnsweredWith({ pattern: /x/ }, contactPoints().withWireDecode(wireDecode), config);
    expect(outcome.settled).toBe(false);
  });

  test('an unknown tag name is refused when the client is built, not at the first reply', () => {
    const options = contactPoints().withWireDecode({ admittedTags: ['regex' as never] });
    expect(() => new ClusterClient(options, Config.empty())).toThrow(OptionsError);
  });

  test('read-constraints from HOCON reach the client decoder too', async () => {
    const config = Config.parseString('actor-ts.serialization.read-constraints.max-nesting-depth = 8');
    let deep: unknown = 1;
    for (let level = 0; level < 20; level++) deep = [deep];
    const outcome = await askAnsweredWith(deep, contactPoints(), config);
    expect(outcome.ended).toBe(true);
    expect(outcome.warnings.some((warning) => warning.includes('nesting deeper than 8'))).toBe(true);
  });
});
