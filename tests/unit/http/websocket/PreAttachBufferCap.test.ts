/**
 * #717 AC-3 — the pre-attach buffer is bounded in count and in bytes.
 *
 * `bufferWebsocketEvents` holds every inbound event between the upgrade
 * completing and the connection actor calling `setListeners`.  `attach` is the
 * only thing that drains it, and `attach` only ever runs if an actor spawns —
 * so on a socket whose actor does not, an attacker's frame stream had nothing
 * standing between it and the heap.  Neither of the caps that look like they
 * would help does: the route's `maxFrameBytes` is enforced in the actor that
 * has not spawned, and the transport's `maxPayload` bounds one frame, not the
 * sum of them.
 *
 * The window is not exotic — it is on **every** connection, on all three
 * backends, with no configured mailbox bound and no flood needed to reach it.
 * That is why the owner comment calls this the residual that carries the
 * security label on its own.
 *
 * Refs #717, #570.
 */
import { describe, expect, test } from 'bun:test';
import {
  bufferWebsocketEvents,
  websocketPackageAdapter,
  DEFAULT_PRE_ATTACH_BUFFER_LIMITS,
  type PreAttachBufferLimits,
  type WebsocketListeners,
  type WebsocketPackageSocket,
} from '../../../../src/http/websocket/SocketAdapter.js';
import {
  DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_BYTES,
  DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_FRAMES,
} from '../../../../src/http/Constants.js';

type Replayed =
  | { readonly kind: 'message'; readonly data: string | Uint8Array }
  | { readonly kind: 'close'; readonly code: number; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string };

/** Collects what `attach` replays, in order. */
function recorder(): { listeners: WebsocketListeners; replayed: Replayed[] } {
  const replayed: Replayed[] = [];
  return {
    replayed,
    listeners: {
      onMessage: (data) => replayed.push({ kind: 'message', data }),
      onClose: (code, reason) => replayed.push({ kind: 'close', code, reason }),
      onError: (error) => replayed.push({ kind: 'error', message: error.message }),
    },
  };
}

function overflowCounter(): { onOverflow: () => void; count: () => number } {
  let count = 0;
  return { onOverflow: () => { count += 1; }, count: () => count };
}

const generous: PreAttachBufferLimits = { maxFrames: 1_000, maxBytes: 1_000_000 };

describe('bufferWebsocketEvents — the frame-count bound (#717)', () => {
  test('holds everything up to the cap and replays it in order', () => {
    const { onOverflow, count } = overflowCounter();
    const buffer = bufferWebsocketEvents({ maxFrames: 3, maxBytes: 1_000_000 }, onOverflow);
    buffer.onMessage('one');
    buffer.onMessage('two');
    buffer.onMessage('three');
    expect(count()).toBe(0);

    const { listeners, replayed } = recorder();
    buffer.attach(listeners);
    expect(replayed).toEqual([
      { kind: 'message', data: 'one' },
      { kind: 'message', data: 'two' },
      { kind: 'message', data: 'three' },
    ]);
  });

  test('the frame past the cap refuses the connection instead of growing', () => {
    const { onOverflow, count } = overflowCounter();
    const buffer = bufferWebsocketEvents({ maxFrames: 3, maxBytes: 1_000_000 }, onOverflow);
    for (const frame of ['one', 'two', 'three', 'four']) buffer.onMessage(frame);
    expect(count()).toBe(1);

    // Everything held is released, and what an actor spawning later gets is
    // the close — replaying a truncated prefix of a stream from a peer the
    // framework just refused would be worse than saying the connection is gone.
    const { listeners, replayed } = recorder();
    buffer.attach(listeners);
    expect(replayed).toEqual([{ kind: 'close', code: 1013, reason: 'connection setup buffer overflow' }]);
  });

  test('a flood past the overflow neither accumulates nor re-fires the callback', () => {
    const { onOverflow, count } = overflowCounter();
    const buffer = bufferWebsocketEvents({ maxFrames: 2, maxBytes: 1_000_000 }, onOverflow);
    for (let frame = 0; frame < 10_000; frame++) buffer.onMessage(`frame-${frame}`);
    expect(count()).toBe(1);

    const { listeners, replayed } = recorder();
    buffer.attach(listeners);
    expect(replayed.length).toBe(1);
  });
});

describe('bufferWebsocketEvents — the byte bound (#717)', () => {
  test('a few large frames overflow while the count is still far from its cap', () => {
    const { onOverflow, count } = overflowCounter();
    const buffer = bufferWebsocketEvents({ maxFrames: 1_000, maxBytes: 64 }, onOverflow);
    buffer.onMessage(new Uint8Array(40));
    expect(count()).toBe(0);
    buffer.onMessage(new Uint8Array(40));
    expect(count()).toBe(1);
  });

  test('a text frame is metered in UTF-8 bytes, not characters', () => {
    const { onOverflow, count } = overflowCounter();
    // Each frame is 10 UTF-16 units but 20 UTF-8 bytes, so at a cap of 30 the
    // pair overflows (40 > 30) while a cap read off `String.length` would
    // admit it (20 <= 30) — and go on admitting four times the bytes it thinks
    // it is holding.
    const fourByteCharacters = '\u{1F600}'.repeat(5);
    expect(fourByteCharacters.length).toBe(10);
    const buffer = bufferWebsocketEvents({ maxFrames: 1_000, maxBytes: 30 }, onOverflow);
    buffer.onMessage(fourByteCharacters);
    buffer.onMessage(fourByteCharacters);
    expect(count()).toBe(1);
  });

  test('the first frame is admitted whatever its size', () => {
    // A route may raise `maxFrameBytes` above `maxPreAttachBytes`; one frame is
    // already bounded by the transport payload limit derived from it, so the
    // opening frame must not be the thing that refuses the connection.
    const { onOverflow, count } = overflowCounter();
    const buffer = bufferWebsocketEvents({ maxFrames: 1_000, maxBytes: 16 }, onOverflow);
    buffer.onMessage(new Uint8Array(1024));
    expect(count()).toBe(0);

    const { listeners, replayed } = recorder();
    buffer.attach(listeners);
    expect(replayed.length).toBe(1);
  });
});

describe('bufferWebsocketEvents — close and error are never metered (#570)', () => {
  test('a close arriving past a spent frame budget is still held and replayed', () => {
    const { onOverflow, count } = overflowCounter();
    const buffer = bufferWebsocketEvents({ maxFrames: 1, maxBytes: 8 }, onOverflow);
    buffer.onMessage('first');
    buffer.onClose(1000, 'bye');
    expect(count()).toBe(0);

    // Dropping this close is the permanent leak #570 was filed for: the
    // connection actor never stops, never leaves the hub, and never gives its
    // `maxConnections` slot back.  A cap that could shed it would reintroduce
    // that defect through the guard meant to close a different one.
    const { listeners, replayed } = recorder();
    buffer.attach(listeners);
    expect(replayed).toEqual([
      { kind: 'message', data: 'first' },
      { kind: 'close', code: 1000, reason: 'bye' },
    ]);
  });

  test('an error is held past the cap too, and the peer close after an overflow is not doubled', () => {
    const { onOverflow } = overflowCounter();
    const buffer = bufferWebsocketEvents({ maxFrames: 1, maxBytes: 1_000_000 }, onOverflow);
    buffer.onError(new Error('transport blew up'));
    buffer.onMessage('one');
    buffer.onMessage('two');            // overflow — replaces the buffer
    buffer.onClose(1006, 'peer gone');  // the answer to the close we just sent

    const { listeners, replayed } = recorder();
    buffer.attach(listeners);
    expect(replayed).toEqual([{ kind: 'close', code: 1013, reason: 'connection setup buffer overflow' }]);
  });
});

describe('bufferWebsocketEvents — after attach nothing is buffered at all', () => {
  test('post-attach frames go straight through, however many there are', () => {
    const { onOverflow, count } = overflowCounter();
    const buffer = bufferWebsocketEvents({ maxFrames: 2, maxBytes: 8 }, onOverflow);
    const { listeners, replayed } = recorder();
    buffer.attach(listeners);
    for (let frame = 0; frame < 100; frame++) buffer.onMessage(`frame-${frame}`);
    expect(replayed.length).toBe(100);
    expect(count()).toBe(0);
  });
});

/* --------------------------- through the adapter --------------------------- */

/** The `ws`-package surface, reduced to what `websocketPackageAdapter` uses. */
function fakePackageSocket() {
  const handlers: Record<string, (...args: never[]) => void> = {};
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  const socket = {
    send: () => {},
    close: (code?: number, reason?: string) => { closeCalls.push({ code, reason }); },
    on: (event: string, listener: (...args: never[]) => void) => { handlers[event] = listener; },
    readyState: 1,
  } as unknown as WebsocketPackageSocket;
  const deliver = (data: unknown, isBinary = false): void => {
    (handlers['message'] as unknown as (data: unknown, isBinary: boolean) => void)(data, isBinary);
  };
  return { socket, closeCalls, deliver };
}

describe('websocketPackageAdapter — the bound reaches the socket (#717)', () => {
  test('the route limits are honoured and overflow closes the socket with 1013', () => {
    const { socket, closeCalls, deliver } = fakePackageSocket();
    websocketPackageAdapter(socket, { preAttachBuffer: { maxFrames: 2, maxBytes: 1_000_000 } });
    deliver('one');
    deliver('two');
    expect(closeCalls).toEqual([]);
    deliver('three');
    expect(closeCalls).toEqual([{ code: 1013, reason: 'connection setup buffer overflow' }]);
  });

  test('an adapter built without a policy still gets a bound, not none', () => {
    // The fallback is the point: forgetting to pass the route's numbers costs
    // accuracy, never the guarantee.  An unbounded buffer is the defect.
    const { socket, closeCalls, deliver } = fakePackageSocket();
    websocketPackageAdapter(socket);
    for (let frame = 0; frame <= DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_FRAMES; frame++) deliver('x');
    expect(closeCalls).toEqual([{ code: 1013, reason: 'connection setup buffer overflow' }]);
  });

  test('the default limits are the two constants, and both are finite', () => {
    expect(DEFAULT_PRE_ATTACH_BUFFER_LIMITS).toEqual({
      maxFrames: DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_FRAMES,
      maxBytes: DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_BYTES,
    });
    expect(Number.isFinite(DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_FRAMES)).toBe(true);
    expect(Number.isFinite(DEFAULT_WEBSOCKET_MAX_PRE_ATTACH_BYTES)).toBe(true);
  });

  test('a socket whose listeners attach normally buffers nothing afterwards', () => {
    const { socket, closeCalls, deliver } = fakePackageSocket();
    const adapter = websocketPackageAdapter(socket, { preAttachBuffer: generous });
    const { listeners, replayed } = recorder();
    deliver('greeting');
    adapter.setListeners(listeners);
    for (let frame = 0; frame < 5_000; frame++) deliver('bulk');
    expect(replayed.length).toBe(5_001);
    expect(closeCalls).toEqual([]);
  });
});
