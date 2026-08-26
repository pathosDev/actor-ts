/**
 * Binary frames must reach the client actor — and, when they are too big,
 * must reach `rejectOversizeFrame` rather than the drop path (#750 follow-up).
 *
 * #750 made an oversize inbound frame a hard stop instead of a repeatable
 * allocation.  It was pinned entirely with **text** frames, and that is where
 * it stopped working: measured over a real WebSocket connection at cap 8, with
 * one 64-byte binary frame and one 64-byte text frame,
 *
 *   - Bun 1.4.0  — `message.data` is a `Buffer`, `normalizeInbound` returns a
 *     binary frame, the size check runs, 1009 is issued;
 *   - Node 26.7.0 — `message.data` is a **`Blob`**, `normalizeInbound` returns
 *     `null`;
 *   - Deno 2.6.8  — `message.data` is a **`Blob`**, `normalizeInbound` returns
 *     `null`.
 *
 * A `Blob` carries `size`, not `byteLength`, and is neither `ArrayBuffer` nor
 * `Uint8Array` nor an array, so it matches no branch of `normalizeInbound`.
 * `handleInbound` then took its *other* bare `return` — the "unrecognised
 * inbound frame type" one — which is the pre-#750 behaviour verbatim: no close,
 * the socket left open, one warning per frame.
 *
 * The cause is upstream of that `if`: nothing set `binaryType`, so the socket
 * used the runtime default, which is `'blob'` on Node and Deno.  Two of these
 * tests are therefore about a defect **larger** than #750 — on those two
 * runtimes the client could not receive a binary frame *of any size*, while
 * `io/websocket.mdx` shipped a worked `rawCodec()` client example doing exactly
 * that.
 *
 * The fake socket models the measured behaviour rather than one runtime's: it
 * defaults to `'blob'` like Node and Deno and honours whatever the actor
 * assigns, so a fix that only normalises inside `normalizeInbound` and never
 * reaches the socket still fails here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel } from '../../../../src/Logger.js';
import { WebsocketClientActor } from '../../../../src/http/websocket/WebsocketClientActor.js';
import { WebsocketClientOptions } from '../../../../src/http/websocket/WebsocketClientOptions.js';
import { rawCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketFrame } from '../../../../src/http/websocket/Types.js';
import {
  websocketClientConstructor,
  type WebsocketClientConstructor,
  type WebsocketLike,
} from '../../../../src/http/websocket/WebsocketConstructor.js';
import { awaitCondition, sleep } from '../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

/** Every `close(code, reason)` the actor issued, in order. */
type CloseCall = { readonly code?: number; readonly reason?: string };

/**
 * A fake socket that behaves like a real one about `binaryType`: it starts on
 * the Node/Deno default and hands binary payloads to the `message` listener in
 * whichever shape the *current* value selects.  All three measured shapes are
 * modelled, so the fake documents the runtimes rather than merely standing in
 * for them.
 */
class RuntimeSocket {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  binaryType: 'blob' | 'arraybuffer' | 'nodebuffer' = 'blob';
  readonly closeCalls: CloseCall[] = [];

  addEventListener(event: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(_data: string | Uint8Array): void {}
  close(code?: number, reason?: string): void { this.closeCalls.push({ code, reason }); }

  fire(event: string, payload?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
  }

  /** Deliver `bytes` the way a runtime honouring the current `binaryType` would. */
  deliverBinary(bytes: Uint8Array): void {
    if (this.binaryType === 'nodebuffer') {
      this.fire('message', { data: bytes });
      return;
    }
    // A copy, not a view: a runtime hands over the frame's own bytes, never a
    // window into a pooled buffer — which is the other thing 'arraybuffer'
    // buys over Bun's 'nodebuffer' default.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    this.fire('message', { data: this.binaryType === 'arraybuffer' ? buffer : new Blob([buffer]) });
  }

  get isOpen(): boolean { return (this.listeners.get('message') ?? []).length > 0; }
}

const CAP_BYTES = 8;
const IN_CAP_BYTES = new Uint8Array([1, 2, 3, 4]);
const OVERSIZE_BYTES = new Uint8Array(64).fill(7);

/** Raw codec, so an inbound binary frame reaches `onMessage` unchanged. */
class BinaryProbeClient extends WebsocketClientActor<WebsocketFrame, WebsocketFrame> {
  static readonly frames: WebsocketFrame[] = [];
  static readonly disconnects: Array<string | undefined> = [];

  constructor() {
    const clientOptions = WebsocketClientOptions.create<WebsocketFrame, WebsocketFrame>()
      .withUrl('ws://feed.example.com/ws')
      .withCodec(rawCodec())
      .withMaxFrameBytes(CAP_BYTES)
      .withReconnect(false);
    super(clientOptions);
  }

  onMessage(frame: WebsocketFrame): void { BinaryProbeClient.frames.push(frame); }
  protected override onDisconnected(cause?: Error): void {
    BinaryProbeClient.disconnects.push(cause?.message);
  }
}

describe('WebsocketClientActor — binary inbound frames (#750 follow-up)', () => {
  const systems: ActorSystem[] = [];

  afterEach(async () => {
    websocketClientConstructor.reset();
    BinaryProbeClient.frames.length = 0;
    BinaryProbeClient.disconnects.length = 0;
    await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => {})));
  });

  /** Spawns the client against one fake socket; resolves once it is open. */
  async function connectedClient(name: string): Promise<{ socket: RuntimeSocket; log: RecordingLogger }> {
    const socket = new RuntimeSocket();
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
    system.spawn(BinaryProbeClient, 'client');

    await awaitCondition(() => socket.isOpen, {
      timeoutMs: 4_000,
      label: 'the client actor opened its socket',
    });
    return { socket, log };
  }

  test('asks the socket for ArrayBuffer payloads instead of taking the runtime default', async () => {
    const { socket } = await connectedClient('ws-binary-type');

    // The mechanism, pinned on its own.  Both behavioural tests below would
    // also pass if `normalizeInbound` grew an async `Blob` branch — this one
    // says the payload never becomes a `Blob` in the first place, which is
    // what keeps the size check and the frame ordering synchronous.
    expect(socket.binaryType).toBe('arraybuffer');
  });

  test('delivers a binary frame within the cap to onMessage', async () => {
    const { socket } = await connectedClient('ws-binary-receive');
    socket.deliverBinary(IN_CAP_BYTES);

    // The larger half of the defect: on Node and Deno this frame was dropped
    // as "unrecognised" whatever its size, so a `rawCodec()` client — the
    // worked example in io/websocket.mdx — received nothing at all.
    await awaitCondition(() => BinaryProbeClient.frames.length > 0, {
      timeoutMs: 4_000,
      label: 'the binary frame reached onMessage',
    });
    const frame = BinaryProbeClient.frames[0]!;
    expect(frame.kind).toBe('binary');
    expect([...(frame as Extract<WebsocketFrame, { kind: 'binary' }>).data]).toEqual([1, 2, 3, 4]);
    expect(socket.closeCalls).toEqual([]);
  });

  test('closes an oversize binary frame with 1009, exactly as it does a text one', async () => {
    const { socket } = await connectedClient('ws-binary-oversize');
    socket.deliverBinary(OVERSIZE_BYTES);

    // #750's own assertion, restated for the frame kind it was never run
    // against.  Before the fix this frame took the "unrecognised" bare
    // `return`: no close, socket open, one warning — the pre-#750 behaviour.
    await awaitCondition(() => socket.closeCalls.length > 0, {
      timeoutMs: 4_000,
      label: 'the client closed the socket on the oversize binary frame',
    });
    expect(socket.closeCalls[0]).toEqual({ code: 1009, reason: 'message too big' });
    expect(BinaryProbeClient.disconnects[0]).toBe('oversize inbound frame');
    expect(BinaryProbeClient.frames).toEqual([]);
  });

  test('a text frame still arrives, so the fix did not trade one kind for the other', async () => {
    const { socket } = await connectedClient('ws-binary-text-guard');
    socket.fire('message', { data: 'ok' });

    await awaitCondition(() => BinaryProbeClient.frames.length > 0, {
      timeoutMs: 4_000,
      label: 'the text frame reached onMessage',
    });
    expect(BinaryProbeClient.frames[0]).toEqual({ kind: 'text', data: 'ok' });
    expect(socket.closeCalls).toEqual([]);
  });

  test('a genuinely unrecognised payload warns once per connection, not once per frame', async () => {
    const { socket, log } = await connectedClient('ws-binary-unrecognised');
    for (let i = 0; i < 5; i++) socket.fire('message', { data: 42 });

    await awaitCondition(
      () => log.records.some((record) => record.message.includes('unrecognised inbound frame')),
      { timeoutMs: 4_000, label: 'the unrecognised-frame warning was logged' },
    );
    // The channel this bug was hiding in.  A shape we cannot decode is still a
    // peer choosing how often we write a line about it, which is the same
    // unbounded log #750 closed for the oversize path — and five silent drops
    // behind five identical lines is precisely how a `Blob` went unnoticed.
    await sleep(100);
    const warnings = log.records.filter((record) => record.message.includes('unrecognised inbound frame'));
    expect(warnings.length).toBe(1);
    // Bounded is not enough on its own: the line has to name the shape, or the
    // next `Blob`-class defect is again a log entry nobody can act on.
    expect(warnings[0]!.message).toContain('Number');
  });
});
