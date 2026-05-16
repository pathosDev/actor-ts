/**
 * Server-side WebSocket actor + Bun adapter tests (#1).  We don't
 * spin up real HTTP / Bun servers — the actor's contract is "given a
 * socket conforming to `ServerWebSocketLike`, bridge it into the
 * actor system."  We exercise that contract directly with a mock
 * socket that captures registered listeners and exposes setter-like
 * methods to synthesise inbound events.
 */
import { describe, expect, test } from 'bun:test';
import { Actor } from '../../../../../src/Actor.js';
import { ActorSystem } from '../../../../../src/ActorSystem.js';
import { LogLevel, NoopLogger } from '../../../../../src/Logger.js';
import { Props } from '../../../../../src/Props.js';
import {
  ServerWebSocketActor,
  type ServerWebSocketLike,
  type WebSocketCmd,
  type WebSocketFrame,
} from '../../../../../src/io/broker/ServerWebSocketActor.js';
import {
  bunWebSocketHandlers,
  serverWebSocketActorOf,
  type BunServerWebSocketLike,
  type BunWebSocketSlot,
} from '../../../../../src/io/broker/WebSocketServerAdapters.js';

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/* --------------------------- Mocks ----------------------------- */

class MockSocket implements ServerWebSocketLike {
  readonly sent: Array<string | Uint8Array | ArrayBuffer> = [];
  closed = false;
  closedCode?: number;
  closedReason?: string;
  private messageCb: ((ev: { data: unknown }) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private errorCb: ((ev: unknown) => void) | null = null;

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (this.closed) throw new Error('send after close');
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closedCode = code;
    this.closedReason = reason;
  }
  addEventListener(event: 'message' | 'close' | 'error', cb: never): void {
    if (event === 'message') this.messageCb = cb;
    else if (event === 'close') this.closeCb = cb;
    else this.errorCb = cb;
  }
  removeEventListener(event: string): void {
    if (event === 'message') this.messageCb = null;
    else if (event === 'close') this.closeCb = null;
    else if (event === 'error') this.errorCb = null;
  }
  /* Drivers — synthesise inbound events. */
  receiveMessage(data: unknown): void { this.messageCb?.({ data }); }
  receiveClose(): void { this.closeCb?.(); }
  receiveError(ev: unknown): void { this.errorCb?.(ev); }
}

class CapturingTarget extends Actor<WebSocketFrame> {
  readonly received: WebSocketFrame[] = [];
  override onReceive(f: WebSocketFrame): void { this.received.push(f); }
}

/* ============================================================== */
/* Tests                                                          */
/* ============================================================== */

describe('ServerWebSocketActor — inbound', () => {
  test('forwards text frames to the target', async () => {
    const sys = ActorSystem.create('sws-text', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const target = new CapturingTarget();
      const targetRef = sys.spawn(Props.create(() => target), 'target');
      const sock = new MockSocket();
      sys.spawn(Props.create(() => new ServerWebSocketActor(sock, { target: targetRef })), 'ws');
      await sleep(20);

      sock.receiveMessage('hello');
      await sleep(20);
      expect(target.received).toEqual([{ kind: 'text', data: 'hello' }]);
    } finally {
      await sys.terminate();
    }
  });

  test('forwards binary frames as Uint8Array regardless of inbound type', async () => {
    const sys = ActorSystem.create('sws-binary', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const target = new CapturingTarget();
      const targetRef = sys.spawn(Props.create(() => target), 'target');
      const sock = new MockSocket();
      sys.spawn(Props.create(() => new ServerWebSocketActor(sock, { target: targetRef })), 'ws');
      await sleep(20);

      // Plain Uint8Array.
      sock.receiveMessage(new Uint8Array([1, 2, 3]));
      // ArrayBuffer.
      const ab = new ArrayBuffer(4);
      new Uint8Array(ab).set([4, 5, 6, 7]);
      sock.receiveMessage(ab);
      // Array of buffers (ws-lib fragmented message).
      sock.receiveMessage([new Uint8Array([8, 9]), new Uint8Array([10])]);
      await sleep(30);

      expect(target.received).toHaveLength(3);
      expect((target.received[0] as { data: Uint8Array }).data).toEqual(new Uint8Array([1, 2, 3]));
      expect((target.received[1] as { data: Uint8Array }).data).toEqual(new Uint8Array([4, 5, 6, 7]));
      expect((target.received[2] as { data: Uint8Array }).data).toEqual(new Uint8Array([8, 9, 10]));
    } finally {
      await sys.terminate();
    }
  });

  test('socket close stops the actor by default; further sends do not reach the socket', async () => {
    const sys = ActorSystem.create('sws-close', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const sock = new MockSocket();
      const ref = sys.spawn(Props.create(() => new ServerWebSocketActor(sock)), 'ws');
      await sleep(20);

      // Pre-close: send works.
      ref.tell({ kind: 'sendText', data: 'before' });
      await sleep(20);
      expect(sock.sent).toEqual(['before']);

      // The peer closes the socket — synthesise the event.
      sock.receiveClose();
      await sleep(40);

      // Tell after close lands in dead letters once the actor has
      // stopped — at minimum the mock's send path mustn't be hit.
      ref.tell({ kind: 'sendText', data: 'after-stop' } as WebSocketCmd);
      await sleep(20);
      expect(sock.sent).toEqual(['before']);
    } finally {
      await sys.terminate();
    }
  });

  test('stopOnSocketClose=false keeps the actor alive after socket close', async () => {
    const sys = ActorSystem.create('sws-keep', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const sock = new MockSocket();
      const ref = sys.spawn(
        Props.create(() => new ServerWebSocketActor(sock, { stopOnSocketClose: false })),
        'ws',
      );
      await sleep(20);
      sock.receiveClose();
      await sleep(40);
      // Sends after close are debug-logged but don't crash.
      ref.tell({ kind: 'sendText', data: 'still-here' });
      await sleep(20);
      // The mock raises on send-after-close — we should NOT have
      // attempted a send (the actor checks `closed` first).
      expect(sock.sent).toEqual([]);
    } finally {
      await sys.terminate();
    }
  });

  test('onError callback is invoked when the socket errors', async () => {
    const sys = ActorSystem.create('sws-err', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const seen: Error[] = [];
      const sock = new MockSocket();
      sys.spawn(
        Props.create(() => new ServerWebSocketActor(sock, {
          onError: (err) => seen.push(err),
          stopOnSocketClose: false,
        })),
        'ws',
      );
      await sleep(20);
      sock.receiveError(new Error('boom'));
      await sleep(20);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.message).toBe('boom');
    } finally {
      await sys.terminate();
    }
  });
});

describe('ServerWebSocketActor — outbound', () => {
  test('send / sendText / sendBinary all reach the socket', async () => {
    const sys = ActorSystem.create('sws-out', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const sock = new MockSocket();
      const ref = sys.spawn(Props.create(() => new ServerWebSocketActor(sock)), 'ws');
      await sleep(20);

      ref.tell({ kind: 'sendText', data: 'hi' });
      ref.tell({ kind: 'sendBinary', data: new Uint8Array([1, 2]) });
      ref.tell({ kind: 'send', frame: { kind: 'text', data: 'wrapped' } });
      ref.tell({ kind: 'send', frame: { kind: 'binary', data: new Uint8Array([3]) } });
      await sleep(40);

      expect(sock.sent).toEqual([
        'hi',
        new Uint8Array([1, 2]),
        'wrapped',
        new Uint8Array([3]),
      ]);
    } finally {
      await sys.terminate();
    }
  });
});

/* ----------------------- serverWebSocketActorOf ----------------------- */

describe('serverWebSocketActorOf — convenience spawn', () => {
  test('returns an actor ref bound to the supplied socket', async () => {
    const sys = ActorSystem.create('sws-of', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const target = new CapturingTarget();
      const targetRef = sys.spawn(Props.create(() => target), 'target');
      const sock = new MockSocket();
      const ref = serverWebSocketActorOf(sys, sock, { target: targetRef, name: 'conn-1' });
      await sleep(20);
      ref.tell({ kind: 'sendText', data: 'pong' });
      await sleep(20);
      expect(sock.sent).toEqual(['pong']);
    } finally {
      await sys.terminate();
    }
  });
});

/* ---------------------------- bunWebSocketHandlers ---------------------------- */

class MockBunWs implements BunServerWebSocketLike<unknown> {
  data: unknown = undefined;
  readonly sent: Array<string | Uint8Array | ArrayBuffer> = [];
  closed = false;
  send(data: string | Uint8Array | ArrayBuffer): number {
    this.sent.push(data);
    return data.length ?? 0;
  }
  close(_code?: number, _reason?: string): void { this.closed = true; }
}

describe('bunWebSocketHandlers — Bun.serve adapter', () => {
  test('open() spawns an actor; message() forwards inbound; close() stops the actor', async () => {
    const sys = ActorSystem.create('sws-bun', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const target = new CapturingTarget();
      const targetRef = sys.spawn(Props.create(() => target), 'target');

      const onOpenObservations: string[] = [];
      const onCloseObservations: string[] = [];
      const handlers = bunWebSocketHandlers(sys, {
        target: targetRef,
        onOpen: (_ws, ref) => { onOpenObservations.push(`open:${ref.path.toString()}`); },
        onClose: (_ws, _ref, code, reason) => { onCloseObservations.push(`close:${code}:${reason}`); },
      });

      // Simulate a Bun connection lifecycle.
      const ws = new MockBunWs();
      handlers.open(ws);
      await sleep(20);
      expect(onOpenObservations).toHaveLength(1);
      expect(ws.data).toBeDefined();
      const slot = ws.data as BunWebSocketSlot<unknown>;
      expect(slot.ref).toBeDefined();
      expect(slot.bridge).toBeDefined();

      // Inbound text + binary.
      handlers.message(ws as BunServerWebSocketLike<BunWebSocketSlot<unknown>>, 'hello');
      handlers.message(ws as BunServerWebSocketLike<BunWebSocketSlot<unknown>>,
        Buffer.from([0x01, 0x02]) as never);
      await sleep(40);
      expect(target.received).toHaveLength(2);
      expect(target.received[0]).toEqual({ kind: 'text', data: 'hello' });
      expect((target.received[1] as { kind: string; data: Uint8Array }).kind).toBe('binary');

      // Outbound from the actor.
      slot.ref.tell({ kind: 'sendText', data: 'pong' });
      await sleep(20);
      expect(ws.sent).toEqual(['pong']);

      // Close.
      handlers.close(ws as BunServerWebSocketLike<BunWebSocketSlot<unknown>>, 1000, 'bye');
      await sleep(40);
      expect(onCloseObservations).toEqual(['close:1000:bye']);
    } finally {
      await sys.terminate();
    }
  });

  test('preserves user-supplied data on ws.data under .user', async () => {
    const sys = ActorSystem.create('sws-bun-data', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const handlers = bunWebSocketHandlers<{ userId: string }>(sys, {});
      const ws = new MockBunWs() as unknown as BunServerWebSocketLike<{ userId: string }>;
      ws.data = { userId: 'alice' };

      handlers.open(ws);
      await sleep(20);

      const slot = ws.data as unknown as BunWebSocketSlot<{ userId: string }>;
      expect(slot.user).toEqual({ userId: 'alice' });
      expect(slot.ref).toBeDefined();
    } finally {
      await sys.terminate();
    }
  });

  test('actor name defaults to a sequential counter; actorName option overrides', async () => {
    const sys = ActorSystem.create('sws-bun-name', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const names: string[] = [];
      const counter = { n: 0 };
      const handlers = bunWebSocketHandlers(sys, {
        onOpen: (_ws, ref) => { names.push(ref.path.toString()); },
        actorName: () => `conn-${++counter.n}`,
      });
      handlers.open(new MockBunWs());
      handlers.open(new MockBunWs());
      await sleep(40);
      expect(names.map((p) => p.split('/').pop())).toEqual(['conn-1', 'conn-2']);
    } finally {
      await sys.terminate();
    }
  });

  test('drain() is a documented no-op (backpressure hook unused at v1)', () => {
    const sys = ActorSystem.create('sws-bun-drain', { logger: new NoopLogger(), logLevel: LogLevel.Off });
    try {
      const handlers = bunWebSocketHandlers(sys);
      // Just shouldn't throw — there's no observable side effect.
      expect(() => handlers.drain(new MockBunWs() as never)).not.toThrow();
    } finally {
      void sys.terminate();
    }
  });
});
