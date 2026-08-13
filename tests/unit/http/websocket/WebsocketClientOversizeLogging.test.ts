/**
 * What the oversize-frame warning is allowed to say (#592).
 *
 * The line is remote-driven: a peer decides how often it is written, because
 * the drop path has no latch and no rate limit.  Whatever the URL carries is
 * therefore replayed into the log at the peer's discretion — which is why the
 * warning names a *label* (scheme, host, port, path) rather than
 * `options.url`, and why the query string goes with the userinfo: a WebSocket
 * endpoint is commonly authenticated with a `?token=…`.
 *
 * Driven through a fake socket rather than a real server: the size branch sits
 * in `handleInbound`, before the codec, so a real round-trip would have to
 * push a megabyte through a backend to reach one `if`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import type { LogContextData } from '../../../../src/LogContext.js';
import { LogLevel, type Logger } from '../../../../src/Logger.js';
import { WebsocketClientActor } from '../../../../src/http/websocket/WebsocketClientActor.js';
import { WebsocketClientOptions } from '../../../../src/http/websocket/WebsocketClientOptions.js';
import {
  websocketClientConstructor,
  type WebsocketClientConstructor,
  type WebsocketLike,
} from '../../../../src/http/websocket/websocketConstructor.js';

type Emitted = { readonly level: string; readonly message: string };

/** Collects every line the system logger was told, including via `withSource`. */
class RecordingLogger implements Logger {
  readonly records: Emitted[] = [];

  constructor(
    readonly level: LogLevel = LogLevel.Debug,
    private readonly root: RecordingLogger | null = null,
  ) {}

  private get sink(): RecordingLogger { return this.root ?? this; }
  private record(level: string, message: string): void { this.sink.records.push({ level, message }); }

  debug(message: string): void { this.record('debug', message); }
  info(message: string): void { this.record('info', message); }
  warn(message: string): void { this.record('warn', message); }
  error(message: string): void { this.record('error', message); }
  withSource(_source: string): Logger { return new RecordingLogger(this.level, this.sink); }
  withFields(_fields: LogContextData): Logger { return new RecordingLogger(this.level, this.sink); }
}

/**
 * Enough of a socket for `connectImplementation`: it hands back the listeners
 * so the test can play the peer, and reports when the `message` listener has
 * been wired (which happens only after `open` has been delivered).
 */
class FakeSocket {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(event: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(_data: string | Uint8Array): void {}
  close(): void {}

  fire(event: string, payload?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
  }

  get isOpen(): boolean { return (this.listeners.get('message') ?? []).length > 0; }
}

/** The URL under test: userinfo AND a query token, both of which must go. */
const URL_WITH_SECRETS = 'wss://reader:hunter2@feed.example.com/ws/orders?token=s3cr3t';

class OversizeClient extends WebsocketClientActor<string, string> {
  constructor() {
    const clientOptions = WebsocketClientOptions.create<string, string>()
      .withUrl(URL_WITH_SECRETS)
      .withMaxFrameBytes(8);
    super(clientOptions);
  }
  onMessage(_message: string): void {}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await sleep(10);
  }
}

describe('WebsocketClientActor — oversize-frame warning (#592)', () => {
  const systems: ActorSystem[] = [];

  afterEach(async () => {
    websocketClientConstructor.reset();
    await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => {})));
  });

  /** Spawns the client against a fake socket; resolves once it is open. */
  async function connectedClient(name: string): Promise<{ socket: FakeSocket; log: RecordingLogger }> {
    const socket = new FakeSocket();
    const constructor: WebsocketClientConstructor = {
      create: (): WebsocketLike => {
        // The actor registers its 'open' listener after `create` returns, so
        // the handshake has to land on a later turn.
        queueMicrotask(() => socket.fire('open'));
        return socket as unknown as WebsocketLike;
      },
    };
    websocketClientConstructor.setOverride(Promise.resolve(constructor));

    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create()
      .withLogger(log)
      .withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create(name, systemOptions);
    systems.push(system);
    system.spawn(OversizeClient, 'client');

    await waitUntil(() => socket.isOpen);
    return { socket, log };
  }

  const oversizeWarning = (log: RecordingLogger): Emitted => {
    const warning = log.records.find((record) => record.message.includes('dropped oversize inbound frame'));
    if (warning === undefined) {
      throw new Error(`no oversize warning among ${log.records.length} records`);
    }
    return warning;
  };

  test('names a redacted label instead of the configured URL', async () => {
    const { socket, log } = await connectedClient('ws-oversize');
    socket.fire('message', { data: 'x'.repeat(64) });

    await waitUntil(() => log.records.some((r) => r.message.includes('dropped oversize inbound frame')));
    const warning = oversizeWarning(log);
    expect(warning.level).toBe('warn');
    expect(warning.message).toBe(
      'WebsocketClientActor: dropped oversize inbound frame (> 8 bytes) from wss://feed.example.com/ws/orders',
    );
  });

  test('leaks neither the userinfo nor the query token, on any line', async () => {
    const { socket, log } = await connectedClient('ws-oversize-secrets');
    socket.fire('message', { data: 'x'.repeat(64) });

    await waitUntil(() => log.records.some((r) => r.message.includes('dropped oversize inbound frame')));
    // Every line, not just the warning: the point is that this connection
    // produced no copy of the secret anywhere in the log.
    const everything = log.records.map((record) => record.message).join('\n');
    expect(everything).not.toContain('hunter2');
    expect(everything).not.toContain('s3cr3t');
    expect(everything).not.toContain(URL_WITH_SECRETS);
    // The guard guards itself: an empty log would satisfy every assertion above.
    expect(log.records.length).toBeGreaterThan(0);
  });

  test('keeps the host and path, so the line still identifies the connection', async () => {
    const { socket, log } = await connectedClient('ws-oversize-identity');
    socket.fire('message', { data: 'x'.repeat(64) });

    await waitUntil(() => log.records.some((r) => r.message.includes('dropped oversize inbound frame')));
    const warning = oversizeWarning(log);
    expect(warning.message).toContain('feed.example.com');
    expect(warning.message).toContain('/ws/orders');
  });

  test('a frame within the cap is not warned about', async () => {
    const { socket, log } = await connectedClient('ws-oversize-under');
    socket.fire('message', { data: '"ok"' });

    await sleep(100);
    expect(log.records.some((r) => r.message.includes('dropped oversize inbound frame'))).toBe(false);
  });
});
