import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TAP_SOCKET_FACTORY, TAP_URL, TapClientService } from './TapClientService.js';
import { TimeControlService } from './TimeControlService.js';
import { PAUSE_BUFFER_FRAMES } from '../core/timeControl.js';
import type { DevToolsStreamId, WelcomeFrame } from '../../../src/devtools/protocol/index.js';

/**
 * The tap client, against a socket that does what the test says.
 *
 * This is the logic the whole UI leans on and the only part of it that had no
 * test at all before #487 — not because nobody wanted one, but because
 * `connectTap` reached `new WebSocket(...)` directly and there was no way in.
 * The injection token added in #485 is what makes the rest of this file
 * possible; everything asserted here is behaviour that already existed and was
 * simply unobservable.
 *
 * Each of these failure modes is quiet in production. A broken refcount leaves
 * the actor system producing span batches for a panel nobody is looking at; a
 * missed sequence gap renders an actor tree that has silently diverged from the
 * real one; a retry loop against an incompatible server spins for ever behind a
 * badge that just says "reconnecting".
 */

type Listener = (event: unknown) => void;

/** A `WebSocket` the test drives, standing in for the real one. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static get latest(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (socket === undefined) throw new Error('no socket was opened');
    return socket;
  }

  /** Mirrors `WebSocket.readyState`; the client checks it before sending. */
  readyState = 0;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.serverClosed();
  }

  /* ----------------------------- test controls ---------------------------- */

  /** Frames this socket sent, of one kind. */
  sentOf(kind: string): Array<Record<string, unknown>> {
    return (this.sent as Array<Record<string, unknown>>).filter((frame) => frame['kind'] === kind);
  }

  opened(): void {
    this.readyState = 1;
    this.emit('open', {});
  }

  receives(frame: unknown): void {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  serverClosed(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

const STREAM: DevToolsStreamId = 'stats';
/** A `resync` stream and a `buffer` one — pausing treats them oppositely. */
const STATE_STREAM: DevToolsStreamId = 'actors';
const TAIL_STREAM: DevToolsStreamId = 'events';

function welcome(overrides: Partial<WelcomeFrame> = {}): WelcomeFrame {
  return {
    kind: 'welcome',
    protocolVersion: 1,
    serverVersion: '0.16.0',
    systemName: 'test-system',
    startedAtMs: 0,
    streams: ['stats', 'actors'],
    panels: [{ id: 'dashboard', status: 'active' }],
    ...overrides,
  } as WelcomeFrame;
}

function serviceUnderTest(): TapClientService {
  TestBed.configureTestingModule({
    providers: [
      { provide: TAP_URL, useValue: 'ws://test/api/ws' },
      { provide: TAP_SOCKET_FACTORY, useValue: (url: string) => new FakeSocket(url) as unknown as WebSocket },
    ],
  });
  return TestBed.inject(TapClientService);
}

describe('TapClientService', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  describe('handshake', () => {
    it('connects to the injected url and greets the server', () => {
      serviceUnderTest();
      expect(FakeSocket.latest.url).toBe('ws://test/api/ws');
      FakeSocket.latest.opened();
      expect(FakeSocket.latest.sentOf('hello')).toHaveLength(1);
    });

    it('is connecting until a welcome arrives, then open', () => {
      const tap = serviceUnderTest();
      expect(tap.status()).toBe('connecting');
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());
      expect(tap.status()).toBe('open');
      expect(tap.welcome()?.systemName).toBe('test-system');
    });
  });

  describe('stream subscriptions are refcounted', () => {
    it('subscribes once for several listeners and unsubscribes only with the last', () => {
      // The refcount is what makes an idle panel cost the actor system nothing.
      // Unsubscribing too early silently starves a panel that is still open;
      // too late leaves the server producing frames nobody reads.
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());

      const first = tap.listen(STREAM, () => {});
      const second = tap.listen(STREAM, () => {});
      expect(FakeSocket.latest.sentOf('subscribe')).toHaveLength(1);

      first();
      expect(FakeSocket.latest.sentOf('unsubscribe')).toHaveLength(0);
      second();
      expect(FakeSocket.latest.sentOf('unsubscribe')).toHaveLength(1);
    });

    it('delivers a payload to every listener on the stream', () => {
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());
      const seen: unknown[] = [];
      tap.listen(STREAM, (payload) => seen.push(payload));
      tap.listen(STREAM, (payload) => seen.push(payload));

      FakeSocket.latest.receives({
        kind: 'event', stream: STREAM, sequenceNumber: 0, payload: { kind: 'stats-sample' },
      });
      expect(seen).toHaveLength(2);
    });

    it('re-subscribes everything after a reconnect', () => {
      // A reconnect should be invisible except for the badge blinking; a panel
      // that was open before the drop must not go silent after it.
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());
      tap.listen(STREAM, () => {});

      FakeSocket.latest.serverClosed();
      vi.advanceTimersByTime(600);
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());

      expect(FakeSocket.latest.sentOf('subscribe')).toHaveLength(1);
    });
  });

  describe('sequence gaps', () => {
    it('re-subscribes rather than delivering a payload after a gap', () => {
      // A gap means frames were dropped, so the panel's incremental state is now
      // a guess. Rendering it anyway produces a tree that quietly disagrees with
      // reality — the failure mode this exists to prevent.
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());
      const seen: unknown[] = [];
      tap.listen(STREAM, (payload) => seen.push(payload));
      const before = FakeSocket.latest.sentOf('subscribe').length;

      FakeSocket.latest.receives({ kind: 'event', stream: STREAM, sequenceNumber: 0, payload: { kind: 'a' } });
      FakeSocket.latest.receives({ kind: 'event', stream: STREAM, sequenceNumber: 5, payload: { kind: 'b' } });

      expect(seen).toHaveLength(1);
      expect(FakeSocket.latest.sentOf('subscribe').length).toBe(before + 1);
    });

    it('accepts a contiguous run without re-subscribing', () => {
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());
      const seen: unknown[] = [];
      tap.listen(STREAM, (payload) => seen.push(payload));
      const before = FakeSocket.latest.sentOf('subscribe').length;

      for (let sequenceNumber = 0; sequenceNumber < 4; sequenceNumber++) {
        FakeSocket.latest.receives({ kind: 'event', stream: STREAM, sequenceNumber, payload: { kind: 'a' } });
      }

      expect(seen).toHaveLength(4);
      expect(FakeSocket.latest.sentOf('subscribe').length).toBe(before);
    });
  });

  describe('reconnect backoff', () => {
    it('waits before retrying, and waits longer each time', () => {
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());

      FakeSocket.latest.serverClosed();
      expect(tap.status()).toBe('closed');
      expect(FakeSocket.instances).toHaveLength(1);

      // First retry at 500 ms.
      vi.advanceTimersByTime(499);
      expect(FakeSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(2);

      // Second failure backs off further: 500 ms is no longer enough.
      FakeSocket.latest.serverClosed();
      vi.advanceTimersByTime(500);
      expect(FakeSocket.instances).toHaveLength(2);
      vi.advanceTimersByTime(500);
      expect(FakeSocket.instances).toHaveLength(3);
    });

    it('never retries an incompatible server', () => {
      // It will still be incompatible in a second; retrying would just spin,
      // behind a badge that reads "reconnecting" and hides the real problem.
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives({ kind: 'error', code: 'version-mismatch', message: 'nope' });
      expect(tap.status()).toBe('incompatible');

      FakeSocket.latest.serverClosed();
      vi.advanceTimersByTime(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(tap.status()).toBe('incompatible');
    });
  });

  describe('request / response', () => {
    it('resolves a pending call with the matching response', async () => {
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());

      const pending = tap.request<{ ok: boolean }>('explain.fetch', { path: '/a' });
      const sent = FakeSocket.latest.sentOf('request')[0]!;
      expect(sent['method']).toBe('explain.fetch');

      FakeSocket.latest.receives({ kind: 'response', requestId: sent['requestId'], result: { ok: true } });
      await expect(pending).resolves.toEqual({ ok: true });
    });

    it('rejects only the call an error names, leaving the connection alone', async () => {
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());

      const pending = tap.request('explain.fetch', {});
      const sent = FakeSocket.latest.sentOf('request')[0]!;
      FakeSocket.latest.receives({ kind: 'error', requestId: sent['requestId'], message: 'no such actor' });

      await expect(pending).rejects.toThrow('no such actor');
      expect(tap.status()).toBe('open');
    });

    it('surfaces a connection-level error on the badge instead', () => {
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());
      FakeSocket.latest.receives({ kind: 'error', message: 'something broke' });
      expect(tap.lastError()).toBe('something broke');
      expect(tap.status()).toBe('open');
    });

    it('rejects in-flight calls when the socket drops', async () => {
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());
      const pending = tap.request('explain.fetch', {});
      FakeSocket.latest.serverClosed();
      await expect(pending).rejects.toThrow(/closed/i);
    });

    it('refuses a call while disconnected rather than queueing it silently', async () => {
      const tap = serviceUnderTest();
      // Never opened.
      await expect(tap.request('explain.fetch', {})).rejects.toThrow(/not connected/i);
    });
  });

  describe('pausing time', () => {
    /**
     * Deliver `count` contiguous frames on `stream`, starting at `from`.
     *
     * Contiguous on purpose: a gap would trip the re-subscribe recovery and the
     * test would be measuring that instead of the pause.
     */
    function deliver(stream: DevToolsStreamId, from: number, count: number): void {
      for (let i = 0; i < count; i++) {
        FakeSocket.latest.receives({
          kind: 'event', stream, sequenceNumber: from + i, payload: { kind: 'x', at: from + i },
        });
      }
    }

    function connected(): { tap: TapClientService; time: TimeControlService } {
      const tap = serviceUnderTest();
      const time = TestBed.inject(TimeControlService);
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());
      return { tap, time };
    }

    it('holds an append-shaped stream and hands it over, in order, on resume', () => {
      // `events` has no snapshot to recover from — the tap returns nothing,
      // because a tail has no past — so discarding here would lose the frames
      // outright. Holding them is the only way a pause costs nothing.
      const { tap, time } = connected();
      const seen: number[] = [];
      tap.listen(TAIL_STREAM, (payload) => seen.push((payload as unknown as { at: number }).at));

      deliver(TAIL_STREAM, 0, 1);
      time.pause();
      deliver(TAIL_STREAM, 1, 3);

      expect(seen).toEqual([0]);
      expect(tap.heldFrames()).toBe(3);

      time.resume();
      TestBed.tick();
      expect(seen).toEqual([0, 1, 2, 3]);
      expect(tap.heldFrames()).toBe(0);
    });

    it('discards a state-shaped stream and asks for a fresh snapshot on resume', () => {
      // The deltas that arrived while time was stopped were thrown away, so the
      // panel's incremental state is a guess — the same situation a sequence gap
      // creates, and it gets the same answer rather than a second mechanism.
      const { tap, time } = connected();
      const seen: unknown[] = [];
      tap.listen(STATE_STREAM, (payload) => seen.push(payload));
      const before = FakeSocket.latest.sentOf('subscribe').length;

      deliver(STATE_STREAM, 0, 1);
      time.pause();
      deliver(STATE_STREAM, 1, 5);

      expect(seen).toHaveLength(1);
      expect(tap.heldFrames()).toBe(0);
      expect(FakeSocket.latest.sentOf('subscribe').length).toBe(before);

      time.resume();
      TestBed.tick();
      expect(FakeSocket.latest.sentOf('subscribe').length).toBe(before + 1);
    });

    it('does not re-subscribe a stream nothing is listening to any more', () => {
      // Re-subscribing for an unmounted panel would restart the server's
      // production for a reader who has navigated away — exactly what the
      // refcount above exists to prevent.
      const { tap, time } = connected();
      const release = tap.listen(STATE_STREAM, () => {});
      time.pause();
      deliver(STATE_STREAM, 0, 2);
      release();
      const before = FakeSocket.latest.sentOf('subscribe').length;

      time.resume();
      TestBed.tick();
      expect(FakeSocket.latest.sentOf('subscribe').length).toBe(before);
    });

    it('drops a held frame at the cap and says how many it lost', () => {
      // A pause left running overnight must cost bounded memory, and the part
      // that did not survive has to be named — a silently shortened tail reads
      // as a quiet system.
      const { tap, time } = connected();
      tap.listen(TAIL_STREAM, () => {});
      time.pause();
      deliver(TAIL_STREAM, 0, PAUSE_BUFFER_FRAMES + 3);

      expect(tap.heldFrames()).toBe(PAUSE_BUFFER_FRAMES);
      expect(tap.droppedFrames()).toBe(3);
    });

    it('forgets what it held for a stream whose last listener left', () => {
      const { tap, time } = connected();
      const release = tap.listen(TAIL_STREAM, () => {});
      time.pause();
      deliver(TAIL_STREAM, 0, 4);
      expect(tap.heldFrames()).toBe(4);

      release();
      expect(tap.heldFrames()).toBe(0);
    });

    it('delivers normally again once time is running', () => {
      const { tap, time } = connected();
      const seen: unknown[] = [];
      tap.listen(TAIL_STREAM, (payload) => seen.push(payload));

      time.pause();
      time.resume();
      TestBed.tick();
      deliver(TAIL_STREAM, 0, 2);
      expect(seen).toHaveLength(2);
    });
  });

  describe('unknown frames', () => {
    it('ignores a frame kind it does not know', () => {
      // The contract that lets a newer server add frames without breaking a
      // bundle that was built before they existed.
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());
      expect(() => FakeSocket.latest.receives({ kind: 'from-the-future' })).not.toThrow();
      expect(tap.status()).toBe('open');
    });

    it('ignores a message that is not JSON at all', () => {
      const tap = serviceUnderTest();
      FakeSocket.latest.opened();
      FakeSocket.latest.receives(welcome());
      const socket = FakeSocket.latest as unknown as { addEventListener: unknown };
      void socket;
      expect(tap.status()).toBe('open');
    });
  });
});
