import {
  DestroyRef,
  Injectable,
  InjectionToken,
  effect,
  inject,
  signal,
  type Signal,
} from '@angular/core';

import {
  connectTap,
  tapUrl,
  type ConnectionStatus,
  type SocketFactory,
  type StreamListener,
  type TapClient,
} from '../core/tapClient.js';
import { PAUSE_POLICIES, PauseBuffer } from '../core/timeControl.js';
import { TimeControlService } from './TimeControlService.js';
import type {
  DevToolsRequestMethod,
  DevToolsStreamId,
  DevToolsStreamPayload,
  WelcomeFrame,
} from '../../../src/devtools/protocol/index.js';

/**
 * Where the tap lives.  Overridable so a test does not have to serve one.
 */
export const TAP_URL = new InjectionToken<string>('devtools tap url', {
  providedIn: 'root',
  factory: () => tapUrl(),
});

/**
 * How the socket is built.  This is the seam #487 needs: the reconnect backoff,
 * the sequence-gap recovery and the refcounted subscribe/unsubscribe are the
 * most failure-prone logic in this UI, and until there was a way to hand it a
 * fake socket none of it could be reached from a test at all.
 */
export const TAP_SOCKET_FACTORY = new InjectionToken<SocketFactory>('devtools tap socket', {
  providedIn: 'root',
  factory: (): SocketFactory => (url) => new WebSocket(url),
});

/** One stream's subscribers, and what is being held back for them. */
type StreamEntry = {
  readonly listeners: Set<StreamListener>;
  readonly buffer: PauseBuffer;
  /** Set when a `resync` stream's deltas were discarded while paused. */
  desynchronised: boolean;
  /** Drops this service's single subscription with the client. */
  release: () => void;
};

/**
 * The one tap connection, as an injectable singleton.
 *
 * The connection logic itself is deliberately NOT rewritten here — it stays in
 * `core/tapClient.ts`, unchanged, and this wraps it.  Everything that makes
 * that file worth keeping is behaviour nothing covers yet: backoff from 500 ms
 * to 10 s, `incompatible` never retrying, re-subscribing every open stream on
 * `welcome`, treating a sequence gap as "re-subscribe for a fresh snapshot"
 * rather than rendering a diverged tree, and refcounting listeners so an idle
 * panel costs the actor system nothing.  Porting that by hand in the same
 * change that introduces the service would have made a behaviour regression
 * indistinguishable from a wiring mistake.
 *
 * What this adds is the thing the plain function could not: an injection
 * point, and with it a place to hand a fake socket in.  The signals are the
 * client's own — it produces Angular signals directly since #485, so there is
 * nothing to mirror and no second copy to fall behind.
 *
 * It is also where pausing happens (#1349).  Every panel's data passes through
 * {@link listen}, so one gate here freezes all eleven of them; the alternative
 * was the same edit in every panel, each with its own chance to get the
 * incremental-state case wrong.
 */
@Injectable({ providedIn: 'root' })
export class TapClientService {
  private readonly time = inject(TimeControlService);
  private readonly client: TapClient = connectTap(inject(TAP_URL), inject(TAP_SOCKET_FACTORY));

  /**
   * One entry per stream anyone is listening to.
   *
   * This service subscribes to the client ONCE per stream and fans out itself,
   * rather than handing every panel's listener to the client directly.  That is
   * what lets the pause buffer be per stream: with a buffer behind each
   * listener, the three panels reading `actors` would each hold their own copy
   * of the same frames and the "held" reading would be three times the truth.
   */
  private readonly streams = new Map<DevToolsStreamId, StreamEntry>();

  private readonly held = signal(0);
  private readonly dropped = signal(0);

  /** Connection state, for the header badge and the offline dialog. */
  readonly status: Signal<ConnectionStatus> = this.client.status;

  /** Handshake data, or `null` until the first `welcome` arrives. */
  readonly welcome: Signal<WelcomeFrame | null> = this.client.welcome;

  /** Last connection-level error, for the version-mismatch dialog. */
  readonly lastError: Signal<string | null> = this.client.lastError;

  /** Frames waiting to be delivered when time starts again. */
  readonly heldFrames: Signal<number> = this.held.asReadonly();

  /** Frames a pause buffer's cap threw away.  Never silently zero. */
  readonly droppedFrames: Signal<number> = this.dropped.asReadonly();

  constructor() {
    // Runs once on construction with time running, where it is a no-op, and
    // then on every transition.  Only the resuming edge has anything to do.
    effect(() => {
      if (this.time.paused()) return;
      this.releaseHeld();
    });
  }

  /** Start receiving `stream`.  Returns the unsubscribe function. */
  listen(stream: DevToolsStreamId, listener: StreamListener): () => void {
    const entry = this.entryFor(stream);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size > 0) return;
      // Nothing reads this stream any more, so what was held for it is not
      // owed to anybody — and holding it would deliver a paused panel's
      // backlog to whatever mounts next.
      this.streams.delete(stream);
      entry.buffer.clear();
      entry.release();
      this.recount();
    };
  }

  /**
   * Listen for as long as `destroyRef` lives.
   *
   * The refcount is what makes an unmounted panel stop costing the actor system
   * anything, so the unsubscribe is not optional bookkeeping — a panel that
   * forgets it leaves the server producing span batches nobody reads.  Tying it
   * to the component's own lifetime removes the chance to forget.
   */
  listenUntilDestroyed(
    stream: DevToolsStreamId,
    listener: StreamListener,
    destroyRef: DestroyRef,
  ): void {
    destroyRef.onDestroy(this.listen(stream, listener));
  }

  /** Invoke a pull method over the same socket. */
  request<T>(method: DevToolsRequestMethod, parameters?: unknown): Promise<T> {
    return this.client.request<T>(method, parameters);
  }

  private entryFor(stream: DevToolsStreamId): StreamEntry {
    const existing = this.streams.get(stream);
    if (existing !== undefined) return existing;
    const created: StreamEntry = {
      listeners: new Set(),
      buffer: new PauseBuffer(),
      desynchronised: false,
      release: () => {},
    };
    this.streams.set(stream, created);
    created.release = this.client.listen(stream, (payload) => {
      if (!this.time.paused()) {
        this.fanOut(created, payload);
        return;
      }
      // Time is stopped.  An append-shaped stream is the content — hold it.
      // A state-shaped one is a delta whose snapshot will say the same thing
      // more accurately in a moment, so drop it and remember to ask.
      if (PAUSE_POLICIES[stream] === 'buffer') created.buffer.push(payload);
      else created.desynchronised = true;
      this.recount();
    });
    return created;
  }

  private fanOut(entry: StreamEntry, payload: DevToolsStreamPayload): void {
    for (const listener of [...entry.listeners]) listener(payload);
  }

  /**
   * Time started again: hand over what was held, then ask for the truth.
   *
   * The two happen in one pass because a stream has exactly one policy — it
   * either buffered or it desynchronised, never both.  Ordering across streams
   * does not matter either: `resubscribe` only sends a frame, and the snapshot
   * it asks for cannot arrive before this synchronous loop has finished.
   */
  private releaseHeld(): void {
    for (const [stream, entry] of this.streams) {
      for (const payload of entry.buffer.drain()) this.fanOut(entry, payload);
      if (!entry.desynchronised) continue;
      entry.desynchronised = false;
      this.client.resubscribe(stream);
    }
    this.recount();
  }

  private recount(): void {
    let held = 0;
    let dropped = 0;
    for (const entry of this.streams.values()) {
      held += entry.buffer.size;
      dropped += entry.buffer.dropped;
    }
    this.held.set(held);
    this.dropped.set(dropped);
  }
}
