import { DestroyRef, Injectable, InjectionToken, inject, signal, type Signal } from '@angular/core';

import {
  connectTap,
  tapUrl,
  type ConnectionStatus,
  type SocketFactory,
  type StreamListener,
  type TapClient,
} from '../core/tapClient.js';
import type {
  DevToolsRequestMethod,
  DevToolsStreamId,
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
 * What this adds is the two things the plain function could not give: an
 * injection point, and Angular signals for components to read.  The signals
 * mirror the client's own — they are written from its subscriptions, which is
 * the one direction data flows.
 */
@Injectable({ providedIn: 'root' })
export class TapClientService {
  /** The underlying client, for the legacy panels that still take one. */
  readonly client: TapClient;

  private readonly statusSignal = signal<ConnectionStatus>('connecting');
  private readonly welcomeSignal = signal<WelcomeFrame | null>(null);
  private readonly lastErrorSignal = signal<string | null>(null);

  constructor() {
    this.client = connectTap(inject(TAP_URL), inject(TAP_SOCKET_FACTORY));
    this.statusSignal.set(this.client.status.get());
    this.welcomeSignal.set(this.client.welcome.get());
    this.lastErrorSignal.set(this.client.lastError.get());
    this.client.status.subscribe((value) => this.statusSignal.set(value));
    this.client.welcome.subscribe((value) => this.welcomeSignal.set(value));
    this.client.lastError.subscribe((value) => this.lastErrorSignal.set(value));
  }

  /** Connection state, for the header badge and the offline dialog. */
  get status(): Signal<ConnectionStatus> { return this.statusSignal.asReadonly(); }

  /** Handshake data, or `null` until the first `welcome` arrives. */
  get welcome(): Signal<WelcomeFrame | null> { return this.welcomeSignal.asReadonly(); }

  /** Last connection-level error, for the version-mismatch dialog. */
  get lastError(): Signal<string | null> { return this.lastErrorSignal.asReadonly(); }

  /** Start receiving `stream`.  Returns the unsubscribe function. */
  listen(stream: DevToolsStreamId, listener: StreamListener): () => void {
    return this.client.listen(stream, listener);
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
}
