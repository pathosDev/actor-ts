import { afterEach, describe, expect, test } from 'bun:test';
import { ClusterClient } from '../../../src/cluster/ClusterClient.js';
import { ClusterClientOptions, type ClusterClientOptionsBuilder } from '../../../src/cluster/ClusterClientOptions.js';
import type {
  ClusterClientEnvelopeMessage,
  ClusterClientReplyMessage,
} from '../../../src/cluster/ClusterClientReceptionist.js';
import { NodeAddress } from '../../../src/cluster/NodeAddress.js';
import {
  encodeFrame,
  FrameDecoder,
  type HelloAcknowledgmentMessage,
  type WireMessage,
} from '../../../src/cluster/Protocol.js';
import { Config } from '../../../src/config/Config.js';
import { getTcpBackend, type TcpListener, type TcpSocketLike } from '../../../src/runtime/tcp/index.js';
import { MAX_TIMER_DELAY_MS } from '../../../src/util/Constants.js';
import { assertDoesNotCompleteWithin } from '../../util/AsyncAssertions.js';
import { awaitCondition } from '../../util/AwaitCondition.js';

/**
 * A `ClusterClient` deadline past the host timer ceiling waits in full.
 *
 * `setTimeout` cannot hold a delay above {@link MAX_TIMER_DELAY_MS} (~24.9
 * days): Bun and Node arm it as 1 ms behind a `TimeoutOverflowWarning`, Deno
 * wraps it modulo 2^32.  The client armed its ask and connect deadlines as one
 * host timer each, and `ask-timeout` / `connect-timeout` are refused only when
 * they are not positive — so on bun 1.4.2 a 30-day ask deadline rejected the
 * ask about 2.5 ms after it was sent, and a 30-day connect deadline gave up on
 * a contact point before its `hello-ack` could arrive.
 *
 * Each case also asserts the deadline is *cleared* when the ask or the dial
 * ends some other way — by a reply, `close()`, a dropped connection or the
 * `hello-ack`.  Nothing in-process shows a deadline left armed: its callback
 * finds the ask gone and does nothing.  What it does do is hold the process
 * open for up to 24.9 days per link, so the clear is what is checked, on the
 * runtime's own `setTimeout` and `clearTimeout`, recorded for the length of a
 * case.  A chain's first link is armed at exactly the ceiling, which no other
 * timer in these cases is, and that is how the deadline is told apart.
 */

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

/** How long a deadline that overflowed would have taken to fire, many times over. */
const OVERFLOW_WINDOW_MS = 150;

/** One call the runtime's `setTimeout` received while it was recorded. */
type RecordedTimeout = {
  readonly callback: unknown;
  readonly delayMs: unknown;
  readonly handle: ReturnType<typeof setTimeout>;
};

/**
 * The runtime's `setTimeout` and `clearTimeout`, recorded and passed through
 * until {@link restore}.  Across `await`s, because a deadline here is armed and
 * cleared on either side of a network round trip.
 */
class RuntimeTimerRecording {
  readonly armed: RecordedTimeout[] = [];
  readonly cleared: unknown[] = [];
  private readonly realSetTimeout = globalThis.setTimeout;
  private readonly realClearTimeout = globalThis.clearTimeout;

  constructor() {
    const { realSetTimeout, realClearTimeout, armed, cleared } = this;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const handle = realSetTimeout(...args);
      armed.push({ callback: args[0], delayMs: args[1], handle });
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(handle);
      realClearTimeout(handle);
    }) as typeof clearTimeout;
  }

  /** The first links of every chain armed so far: the timers armed at exactly the ceiling. */
  get ceilingLinks(): RecordedTimeout[] {
    return this.armed.filter((timeout) => timeout.delayMs === MAX_TIMER_DELAY_MS);
  }

  /**
   * Stand in for `timeout` elapsing — 24.9 days nobody can wait for: clear the
   * real timer so it can never also fire, run its callback now, and hand back
   * whatever that armed next.  A deadline merely held to the ceiling fires
   * here; a chain arms the rest of itself.
   */
  elapseByHand(timeout: RecordedTimeout): readonly RecordedTimeout[] {
    this.realClearTimeout(timeout.handle);
    const before = this.armed.length;
    (timeout.callback as () => void)();
    return this.armed.slice(before);
  }

  restore(): void {
    globalThis.setTimeout = this.realSetTimeout;
    globalThis.clearTimeout = this.realClearTimeout;
  }
}

/** A stand-in contact point: answers the handshake, records envelopes, replies on request. */
type ContactPoint = {
  readonly port: number;
  readonly envelopes: readonly ClusterClientEnvelopeMessage[];
  /** Whether a `hello` has arrived. */
  readonly helloReceived: boolean;
  /** Send the `hello-ack` a point built with `holdHelloAcknowledgment` is holding back. */
  acknowledgeHello(): void;
  /** Answer the ask behind `askId`, on the connection its envelope came in on. */
  reply(askId: string, body: unknown): void;
  /** Abort every open connection. */
  dropConnections(): void;
};

const listeners: TcpListener[] = [];
const clients: ClusterClient[] = [];
const recordings: RuntimeTimerRecording[] = [];

afterEach(async () => {
  // Restored first, so a case that failed mid-way cannot leave the globals
  // replaced under the cleanup below or the next case.
  for (const recording of recordings.splice(0)) recording.restore();
  for (const client of clients.splice(0)) await client.close();
  for (const listener of listeners.splice(0)) await listener.close();
});

function recordRuntimeTimers(): RuntimeTimerRecording {
  const recording = new RuntimeTimerRecording();
  recordings.push(recording);
  return recording;
}

async function contactPoint(options: { readonly holdHelloAcknowledgment: boolean }): Promise<ContactPoint> {
  const backend = await getTcpBackend();
  // One decoder per connection: `FrameDecoder` holds the partial-frame buffer.
  const decoders = new Map<TcpSocketLike, FrameDecoder>();
  const envelopes: ClusterClientEnvelopeMessage[] = [];
  const envelopeSockets = new Map<string, TcpSocketLike>();
  let heldHello: TcpSocketLike | null = null;
  let helloReceived = false;
  let boundPort = 0;
  const acknowledge = (socket: TcpSocketLike): void => {
    const acknowledgment: HelloAcknowledgmentMessage = {
      kind: 'hello-ack',
      wireVersion: 2,
      self: new NodeAddress('contact-point', '127.0.0.1', boundPort, 'test-run').toJSON(),
    };
    socket.write(encodeFrame(acknowledgment));
  };
  const listener = await backend.listen({
    host: '127.0.0.1',
    // Port 0: a Windows host reserves whole port ranges.
    port: 0,
    handlers: {
      onOpen: () => {},
      onData: (socket, chunk) => {
        let decoder = decoders.get(socket);
        if (decoder === undefined) {
          decoder = new FrameDecoder();
          decoders.set(socket, decoder);
        }
        for (const frame of decoder.push(chunk)) {
          const kind = (frame as { kind: string }).kind;
          if (kind === 'hello') {
            helloReceived = true;
            if (options.holdHelloAcknowledgment) heldHello = socket;
            else acknowledge(socket);
          } else if (kind === 'cluster-client-envelope') {
            const envelope = frame as unknown as ClusterClientEnvelopeMessage;
            envelopes.push(envelope);
            if (envelope.askId !== undefined) envelopeSockets.set(envelope.askId, socket);
          }
        }
      },
      onClose: (socket) => { decoders.delete(socket); },
      onError: () => {},
    },
  });
  boundPort = listener.port;
  listeners.push(listener);
  return {
    port: listener.port,
    envelopes,
    get helloReceived() { return helloReceived; },
    acknowledgeHello: () => {
      if (heldHello === null) throw new Error('no hello is being held');
      acknowledge(heldHello);
      heldHello = null;
    },
    reply: (askId, body) => {
      const socket = envelopeSockets.get(askId);
      if (socket === undefined) throw new Error(`no envelope arrived for ask ${askId}`);
      const reply: ClusterClientReplyMessage = { kind: 'cluster-client-reply', askId, ok: true, body };
      socket.write(encodeFrame(reply as unknown as WireMessage));
    },
    dropConnections: () => {
      for (const socket of decoders.keys()) {
        if (socket.destroy !== undefined) socket.destroy();
        else socket.end();
      }
    },
  };
}

/**
 * A client of `point`.  Always handed a `Config`, so nothing in the working
 * directory's `application.conf` can decide a deadline here.
 */
function clientOf(
  point: ContactPoint,
  options: ClusterClientOptionsBuilder = ClusterClientOptions.create(),
  config: Config = Config.empty(),
): ClusterClient {
  const clientOptions = options.withContactPoints([`contact-point@127.0.0.1:${point.port}`]);
  const client = new ClusterClient(clientOptions, config);
  clients.push(client);
  return client;
}

/** `promise`'s rejection message, or a marker when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('a ClusterClient ask deadline past the host timer ceiling', () => {
  test('a 30-day deadline outlasts its first 24.9 days, and the reply clears the rest', async () => {
    const point = await contactPoint({ holdHelloAcknowledgment: false });
    const client = clientOf(point);
    const timers = recordRuntimeTimers();

    const asked = client.ask<string>('/user/slow', { kind: 'ping' }, THIRTY_DAYS_MS);
    await assertDoesNotCompleteWithin(asked, OVERFLOW_WINDOW_MS, 'a ClusterClient ask with a 30-day deadline');
    await awaitCondition(() => point.envelopes.length === 1, {
      timeoutMs: 4_000,
      label: 'the envelope reached the contact point',
    });
    const [firstLink] = timers.ceilingLinks;
    expect(firstLink, 'the deadline was not armed as a chain of host timers').toBeDefined();

    // A deadline held to the ceiling would fire here, five days early.
    const rest = timers.elapseByHand(firstLink!);
    expect(rest.map((timeout) => timeout.delayMs)).toEqual([THIRTY_DAYS_MS - MAX_TIMER_DELAY_MS]);
    await assertDoesNotCompleteWithin(asked, 20, 'a ClusterClient ask 24.9 days into a 30-day deadline');

    point.reply(point.envelopes[0]!.askId!, 'pong');
    expect(await asked).toBe('pong');
    expect(timers.cleared).toContain(rest[0]!.handle);
  });

  test('a 30-day ask-timeout from configuration does not fire at once, and close() clears it', async () => {
    const point = await contactPoint({ holdHelloAcknowledgment: false });
    const client = clientOf(point, ClusterClientOptions.create(), Config.parseString('actor-ts.cluster.client.ask-timeout = 30d'));
    const timers = recordRuntimeTimers();

    // No per-call timeout, so the deadline is the configured one.
    const asked = client.ask('/user/slow', { kind: 'ping' });
    await assertDoesNotCompleteWithin(asked, OVERFLOW_WINDOW_MS, 'a ClusterClient ask under ask-timeout = 30d');
    const [deadline] = timers.ceilingLinks;
    expect(deadline, 'the configured deadline was not armed as a chain of host timers').toBeDefined();

    const outcome = rejectionOf(asked);
    await client.close();
    expect(await outcome).toBe('ClusterClient closed');
    expect(timers.cleared).toContain(deadline!.handle);
  });

  test('a connection that drops before the reply clears a 30-day deadline', async () => {
    const point = await contactPoint({ holdHelloAcknowledgment: false });
    const client = clientOf(point);
    const timers = recordRuntimeTimers();

    const asked = client.ask('/user/slow', { kind: 'ping' }, THIRTY_DAYS_MS);
    const outcome = rejectionOf(asked);
    await awaitCondition(() => point.envelopes.length === 1, {
      timeoutMs: 4_000,
      label: 'the envelope reached the contact point',
    });
    const [deadline] = timers.ceilingLinks;
    expect(deadline, 'the deadline was not armed as a chain of host timers').toBeDefined();

    point.dropConnections();
    expect(await outcome).toBe('ClusterClient: connection closed before reply arrived');
    expect(timers.cleared).toContain(deadline!.handle);
  });
});

describe('a ClusterClient connect deadline past the host timer ceiling', () => {
  test('a 30-day deadline waits for a hello-ack that comes late, and the hello-ack clears it', async () => {
    const point = await contactPoint({ holdHelloAcknowledgment: true });
    const connectOptions = ClusterClientOptions.create().withConnectTimeoutMs(THIRTY_DAYS_MS);
    const client = clientOf(point, connectOptions);
    const timers = recordRuntimeTimers();

    const asked = client.ask<string>('/user/slow', { kind: 'ping' });
    // The dial waits on the held `hello-ack`, so the connect deadline is the
    // only thing that could settle the ask in this window.
    await assertDoesNotCompleteWithin(asked, OVERFLOW_WINDOW_MS, 'a ClusterClient dial with a 30-day connect deadline');
    await awaitCondition(() => point.helloReceived, { timeoutMs: 4_000, label: 'the hello reached the contact point' });
    const [firstLink] = timers.ceilingLinks;
    expect(firstLink, 'the connect deadline was not armed as a chain of host timers').toBeDefined();

    // A deadline held to the ceiling would give up on the dial here.
    const rest = timers.elapseByHand(firstLink!);
    expect(rest.map((timeout) => timeout.delayMs)).toEqual([THIRTY_DAYS_MS - MAX_TIMER_DELAY_MS]);
    await assertDoesNotCompleteWithin(asked, 20, 'a ClusterClient dial 24.9 days into a 30-day connect deadline');

    point.acknowledgeHello();
    await awaitCondition(() => point.envelopes.length === 1, {
      timeoutMs: 4_000,
      label: 'the envelope reached the contact point after the late hello-ack',
    });
    expect(timers.cleared).toContain(rest[0]!.handle);
    point.reply(point.envelopes[0]!.askId!, 'pong');
    expect(await asked).toBe('pong');
  });
});
