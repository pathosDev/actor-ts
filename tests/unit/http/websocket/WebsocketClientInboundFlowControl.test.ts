import { afterEach, describe, expect, test } from 'bun:test';
import { ActorSystem } from '../../../../src/ActorSystem.js';
import { ActorSystemOptions } from '../../../../src/ActorSystemOptions.js';
import { LogLevel } from '../../../../src/Logger.js';
import { WebsocketClientActor } from '../../../../src/http/websocket/WebsocketClientActor.js';
import {
  WebsocketClientOptions,
  WebsocketClientOptionsValidator,
} from '../../../../src/http/websocket/WebsocketClientOptions.js';
import { rawCodec } from '../../../../src/http/websocket/WebsocketCodec.js';
import type { WebsocketFrame } from '../../../../src/http/websocket/Types.js';
import {
  websocketClientConstructor,
  type WebsocketClientConstructor,
  type WebsocketLike,
} from '../../../../src/http/websocket/WebsocketConstructor.js';
import { MetricsExtensionId } from '../../../../src/metrics/MetricsExtension.js';
import type { MetricsRegistry } from '../../../../src/metrics/Metrics.js';
import { OptionsError } from '../../../../src/util/OptionsValidator.js';
import { awaitCondition } from '../../../util/AwaitCondition.js';
import { RecordingLogger } from '../../../util/RecordingLogger.js';

/**
 * #1523 — receiver-side flow control on the WebSocket client.
 *
 * Before this the backpressure story was send-side only: `BackpressurePolicy`
 * governs the outbound buffer, and every inbound frame was decoded and
 * `tell`'d onward the instant it arrived.  A peer publishing faster than
 * `onMessage` drains had nowhere to push back to; the frames piled into the
 * mailbox, and a bounded mailbox then dropped *decoded application messages*
 * rather than pausing the socket.
 *
 * The tests drive a fake socket rather than a real one because the property
 * is about *when* `pause()` and `resume()` are called relative to the mailbox
 * backlog, and a real peer cannot be made to stop at exactly the eighth frame.
 * The consumer is gated by hand so the backlog is under the test's control.
 */

const HIGH_WATER_MARK = 8;
const LOW_WATER_MARK = 2;

/** A WHATWG `WebSocket` as Node and Deno ship it: no way to pause it. */
class UnpausableSocket {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  binaryType: 'blob' | 'arraybuffer' | 'nodebuffer' = 'blob';

  addEventListener(event: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
  }

  send(): void {}
  close(): void { this.fire('close'); }

  fire(event: string, payload?: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload);
  }

  private delivered = 0;

  /** Deliver `count` text frames, back to back, as a fast peer would — numbered across calls. */
  deliver(count: number): void {
    for (let i = 0; i < count; i++) this.fire('message', { data: `frame-${this.delivered++}` });
  }

  get isOpen(): boolean { return (this.listeners.get('message') ?? []).length > 0; }
}

/** Bun 1.4.1+'s socket: the same, plus `pause()` / `resume()` / `isPaused`, recorded. */
class PausableSocket extends UnpausableSocket {
  /** Every transition, in order — `'pause'` or `'resume'`. */
  readonly transitions: Array<'pause' | 'resume'> = [];
  isPaused = false;
  pause(): void { this.isPaused = true; this.transitions.push('pause'); }
  resume(): void { this.isPaused = false; this.transitions.push('resume'); }
}

/**
 * A consumer that holds every frame until the test lets it go, one at a time,
 * and records what it has been handed.
 */
class GatedClient extends WebsocketClientActor<WebsocketFrame, WebsocketFrame> {
  /** Static so the test can reach the instance the system spawned. */
  static current: GatedClient | null = null;
  readonly handled: string[] = [];
  private release: (() => void) | null = null;
  /** Once open, frames pass straight through — set by teardown so terminate() can finish. */
  private gateOpen = false;

  constructor(highWaterMark: number | undefined, lowWaterMark: number | undefined) {
    const clientOptions = WebsocketClientOptions.create<WebsocketFrame, WebsocketFrame>()
      .withUrl('wss://feed.example.com/ws')
      .withCodec(rawCodec())
      .withReconnect(false);
    if (highWaterMark !== undefined) clientOptions.withInboundHighWaterMark(highWaterMark);
    if (lowWaterMark !== undefined) clientOptions.withInboundLowWaterMark(lowWaterMark);
    super(clientOptions);
    GatedClient.current = this;
  }

  onMessage(frame: WebsocketFrame): Promise<void> {
    this.handled.push(String(frame.data));
    if (this.gateOpen) return Promise.resolve();
    return new Promise<void>((resolve) => { this.release = resolve; });
  }

  /** Stop gating: release whatever is held and let every later frame through. */
  open(): void {
    this.gateOpen = true;
    this.releaseOne();
  }

  /** Let the frame currently held in `onMessage` go. */
  releaseOne(): boolean {
    const release = this.release;
    if (release === null) return false;
    this.release = null;
    release();
    return true;
  }
}

class FlowControlledClient extends GatedClient {
  constructor() { super(HIGH_WATER_MARK, LOW_WATER_MARK); }
}

class DefaultLowWaterMarkClient extends GatedClient {
  constructor() { super(HIGH_WATER_MARK, undefined); }
}

class UnboundedClient extends GatedClient {
  constructor() { super(undefined, undefined); }
}

type ClientClass = new () => GatedClient;

const sampleOf = (registry: MetricsRegistry, name: string): number | undefined =>
  registry.collect().find((sample) => sample.name === name)?.value;

describe('WebsocketClientActor — inbound flow control (#1523)', () => {
  const systems: ActorSystem[] = [];

  afterEach(async () => {
    websocketClientConstructor.reset();
    GatedClient.current?.open();
    GatedClient.current = null;
    await Promise.all(systems.splice(0).map((system) => system.terminate().catch(() => {})));
  });

  /** Spawn `clientClass` against `socket`; resolves once the socket is open. */
  async function connected(
    name: string,
    socket: UnpausableSocket,
    clientClass: ClientClass,
    withMetrics = false,
  ): Promise<{ client: GatedClient; log: RecordingLogger; registry: MetricsRegistry | null }> {
    const constructor: WebsocketClientConstructor = {
      create: (): WebsocketLike => {
        queueMicrotask(() => socket.fire('open'));
        return socket as unknown as WebsocketLike;
      },
    };
    websocketClientConstructor.setOverride(Promise.resolve(constructor));

    const log = new RecordingLogger();
    const systemOptions = ActorSystemOptions.create().withLogger(log).withLogLevel(LogLevel.Debug);
    const system = ActorSystem.create(name, systemOptions);
    systems.push(system);
    const registry = withMetrics ? system.extension(MetricsExtensionId).enable() : null;
    system.spawn(clientClass, 'client');
    await awaitCondition(() => socket.isOpen && GatedClient.current !== null, {
      timeoutMs: 4_000, label: 'the client actor opened its socket',
    });
    return { client: GatedClient.current!, log, registry };
  }

  /** Let the consumer through `count` frames, waiting for each to be picked up. */
  async function drain(client: GatedClient, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await awaitCondition(() => client.releaseOne(), {
        timeoutMs: 4_000, intervalMs: 5, label: `frame ${i + 1} of ${count} reached onMessage`,
      });
    }
  }

  test('a producer that outruns the consumer pauses the socket at the high-water mark, once', async () => {
    const socket = new PausableSocket();
    const { client } = await connected('ws-flow-pause', socket, FlowControlledClient);

    // Frames arrive on the socket's own event path, ahead of the mailbox, so
    // the backlog is counted the moment each is queued: the eighth frame is
    // what tips it, synchronously, before the consumer has seen any of them.
    socket.deliver(HIGH_WATER_MARK - 1);
    expect(socket.transitions).toEqual([]);
    socket.deliver(1);
    expect(socket.transitions).toEqual(['pause']);
    expect(socket.isPaused).toBe(true);

    // More frames while paused change nothing — the socket is already stopped,
    // and a second pause() would be a second timestamp on one pause.
    socket.deliver(3);
    expect(socket.transitions).toEqual(['pause']);

    // Eleven queued.  A frame leaves the mailbox when the actor picks it up,
    // and the first is picked up without a release — so after seven releases
    // eight have been handed on and three wait; the eighth release hands on
    // the ninth, leaving two, which is the low-water mark.
    await drain(client, 7);
    expect(socket.transitions).toEqual(['pause']);
    await drain(client, 1);
    await awaitCondition(() => socket.transitions.length === 2, {
      timeoutMs: 4_000, label: 'the socket resumed at the low-water mark',
    });
    expect(socket.transitions).toEqual(['pause', 'resume']);
    expect(socket.isPaused).toBe(false);

    // Everything that was accepted is delivered — pausing lost nothing.
    await drain(client, 2);
    client.open();
    await awaitCondition(() => client.handled.length === 11, {
      timeoutMs: 4_000, label: 'every accepted frame reached onMessage',
    });
    expect(client.handled).toEqual(Array.from({ length: 11 }, (_, i) => `frame-${i}`));
  });

  test('the low-water mark defaults to a quarter of the high-water mark', async () => {
    const socket = new PausableSocket();
    const { client } = await connected('ws-flow-default-low', socket, DefaultLowWaterMarkClient);

    socket.deliver(HIGH_WATER_MARK);
    expect(socket.transitions).toEqual(['pause']);
    // 8 / 4 = 2: resume once the backlog is down to two, i.e. once six have
    // been handed on — the first without a release, so after five releases.
    await drain(client, 4);
    expect(socket.transitions).toEqual(['pause']);
    await drain(client, 1);
    await awaitCondition(() => socket.transitions.length === 2, {
      timeoutMs: 4_000, label: 'the socket resumed at a quarter of the high-water mark',
    });
    expect(socket.transitions).toEqual(['pause', 'resume']);
  });

  test('a socket that cannot pause keeps every frame flowing and says so once', async () => {
    // Node and Deno.  The mark is configured, the runtime cannot honour it,
    // and the honest outcome is today's behaviour plus one line saying so —
    // not a limit that looks applied and is not.
    const socket = new UnpausableSocket();
    const { client, log } = await connected('ws-flow-unpausable', socket, FlowControlledClient);

    socket.deliver(HIGH_WATER_MARK * 3);
    await drain(client, HIGH_WATER_MARK * 3);
    await awaitCondition(() => client.handled.length === HIGH_WATER_MARK * 3, {
      timeoutMs: 4_000, label: 'every frame was delivered on the unpausable socket',
    });

    const warnings = log.records
      .filter((record) => record.message.includes('inboundHighWaterMark is set'))
      .map((record) => record.message);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`(${HIGH_WATER_MARK})`);
    expect(warnings[0]).toContain('no pause()/resume()');
    expect(warnings[0]).toContain('Bun 1.4.1+');
    // The endpoint is named through the redacting label, never the raw URL.
    expect(warnings[0]).toContain('feed.example.com');
  });

  test('with no high-water mark configured a pausable socket is never paused', async () => {
    const socket = new PausableSocket();
    await connected('ws-flow-unbounded', socket, UnboundedClient);

    // An absence cannot be polled for, so it is checked after a presence that
    // orders it: once every one of the 200 frames has been handed on, any
    // pause that was going to happen has happened.
    const client = GatedClient.current!;
    client.open();
    socket.deliver(200);
    await awaitCondition(() => client.handled.length === 200, {
      timeoutMs: 4_000, label: 'all 200 frames were handed on without a pause',
    });
    expect(socket.transitions).toEqual([]);
    expect(socket.isPaused).toBe(false);
  });

  test('time spent paused is booked to websocket_client_inbound_paused_seconds_total', async () => {
    const socket = new PausableSocket();
    const { client, registry } = await connected('ws-flow-metric', socket, FlowControlledClient, true);

    socket.deliver(HIGH_WATER_MARK);
    expect(socket.isPaused).toBe(true);
    await drain(client, HIGH_WATER_MARK - LOW_WATER_MARK);
    await awaitCondition(() => socket.transitions.length === 2, {
      timeoutMs: 4_000, label: 'the socket resumed',
    });

    const paused = sampleOf(registry!, 'websocket_client_inbound_paused_seconds_total');
    expect(paused).toBeDefined();
    // The pause lasted the whole drain — several polled releases — so a zero
    // here would mean it was never timed, not that it was short.
    expect(paused!).toBeGreaterThan(0);
  });

  test('a connection that drops while paused settles the pause instead of counting forever', async () => {
    const socket = new PausableSocket();
    const { registry } = await connected('ws-flow-drop-while-paused', socket, FlowControlledClient, true);

    socket.deliver(HIGH_WATER_MARK);
    expect(socket.isPaused).toBe(true);
    socket.fire('close');

    // The counter is only ever touched by the settle path, so the sample's
    // existence is the proof that the drop booked the pause.
    await awaitCondition(
      () => sampleOf(registry!, 'websocket_client_inbound_paused_seconds_total') !== undefined,
      { timeoutMs: 4_000, label: 'the pause was booked when the connection went' },
    );
    // No resume() on a socket that is gone — the flag was cleared, not the peer.
    expect(socket.transitions).toEqual(['pause']);
  });

  test('the validator refuses a low-water mark without a high one, or at or above it', () => {
    const validator = new WebsocketClientOptionsValidator<WebsocketFrame, WebsocketFrame>();
    const base = { url: 'wss://feed.example.com/ws' };

    expect(() => validator.validate({ ...base, inboundLowWaterMark: 2 }))
      .toThrow(/needs inboundHighWaterMark/);
    expect(() => validator.validate({ ...base, inboundHighWaterMark: 8, inboundLowWaterMark: 8 }))
      .toThrow(/must be below inboundHighWaterMark \(8\)/);
    expect(() => validator.validate({ ...base, inboundHighWaterMark: 8, inboundLowWaterMark: 9 }))
      .toThrow(OptionsError);
    expect(() => validator.validate({ ...base, inboundHighWaterMark: 0 }))
      .toThrow(/inboundHighWaterMark/);
    // The documented shape, and a zero low-water mark: resume only once the
    // backlog is empty is a legitimate choice.
    expect(() => validator.validate({ ...base, inboundHighWaterMark: 256, inboundLowWaterMark: 64 })).not.toThrow();
    expect(() => validator.validate({ ...base, inboundHighWaterMark: 8, inboundLowWaterMark: 0 })).not.toThrow();
  });
});
