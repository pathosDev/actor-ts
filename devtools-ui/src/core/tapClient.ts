/**
 * The one WebSocket every panel shares.
 *
 * Multiplexing matters here: panels come and go as the developer
 * clicks around, and a socket per panel would mean a reconnect (and a
 * fresh snapshot) on every switch.  Instead the client keeps one
 * connection, tracks which streams have listeners, and subscribes and
 * unsubscribes on the server as panels mount and unmount — so the
 * dashboard alone never makes the actor system produce span batches.
 */
import { match } from 'ts-pattern';
import { signal, type ReadonlySignal } from './signal.js';
import {
  DEVTOOLS_PROTOCOL_VERSION,
  helloFrame,
  type DevToolsRequestMethod,
  type DevToolsServerFrame,
  type DevToolsStreamId,
  type DevToolsStreamPayload,
  type ErrorFrame,
  type EventFrame,
  type ResponseFrame,
  type WelcomeFrame,
} from '../../../src/devtools/protocol/index.js';

/** Connection state, surfaced in the header badge. */
export type ConnectionStatus = 'connecting' | 'open' | 'closed' | 'incompatible';

/** Listener for one stream's payloads. */
export type StreamListener = (payload: DevToolsStreamPayload) => void;

export interface TapClient {
  readonly status: ReadonlySignal<ConnectionStatus>;
  /** Handshake data, or `null` until the first `welcome` arrives. */
  readonly welcome: ReadonlySignal<WelcomeFrame | null>;
  /** Last connection-level error message, for the incompatible banner. */
  readonly lastError: ReadonlySignal<string | null>;
  /** Start receiving `stream`.  Returns the unsubscribe function. */
  listen(stream: DevToolsStreamId, listener: StreamListener): () => void;
  /** Invoke a pull method. */
  request<T>(method: DevToolsRequestMethod, parameters?: unknown): Promise<T>;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export function connectTap(url: string): TapClient {
  const status = signal<ConnectionStatus>('connecting');
  const welcome = signal<WelcomeFrame | null>(null);
  const lastError = signal<string | null>(null);

  const listeners = new Map<DevToolsStreamId, Set<StreamListener>>();
  /** Next expected sequence number per stream; `null` means "accept anything". */
  const expected = new Map<DevToolsStreamId, number | null>();
  const pending = new Map<number, PendingRequest>();

  let socket: WebSocket | null = null;
  let nextRequestId = 1;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function send(frame: unknown): void {
    if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  function subscribeOnServer(stream: DevToolsStreamId): void {
    expected.set(stream, null);
    send({ kind: 'subscribe', stream });
  }

  function open(): void {
    status.set('connecting');
    const next = new WebSocket(url);
    socket = next;

    next.addEventListener('open', () => send(helloFrame('devtools-ui')));
    next.addEventListener('message', (event) => {
      let frame: DevToolsServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as DevToolsServerFrame;
      } catch {
        return;
      }
      handle(frame);
    });
    next.addEventListener('close', () => {
      socket = null;
      failPending(new Error('DevTools connection closed'));
      // An incompatible server will still be incompatible in a second;
      // retrying would just spin.  Every other close is transient (the
      // system restarted, the laptop slept) and worth retrying.
      if (status.get() === 'incompatible') return;
      status.set('closed');
      scheduleReconnect();
    });
    next.addEventListener('error', () => {
      /* the close handler runs next and owns the reconnect */
    });
  }

  function handle(frame: DevToolsServerFrame): void {
    // `.otherwise`, not `.exhaustive`: ignoring unknown frame kinds is the
    // contract that lets a newer server add frames without breaking this
    // bundle, so the fallback is deliberate rather than a missing arm.
    match(frame)
      .with({ kind: 'welcome' }, (f) => onWelcome(f))
      .with({ kind: 'event' }, (f) => onEvent(f))
      .with({ kind: 'response' }, (f) => onResponse(f))
      .with({ kind: 'error' }, (f) => onError(f))
      .otherwise(() => onUnknownFrame());
  }

  function onWelcome(frame: WelcomeFrame): void {
    reconnectAttempt = 0;
    welcome.set(frame);
    lastError.set(null);
    status.set('open');
    // Re-subscribe everything a panel had open before the drop, so
    // a reconnect is invisible except for the badge blinking.
    for (const stream of listeners.keys()) subscribeOnServer(stream);
  }

  function onEvent(frame: EventFrame): void {
    deliverStreamEvent(frame.stream, frame.sequenceNumber, frame.payload);
  }

  function onResponse(frame: ResponseFrame): void {
    const request = pending.get(frame.requestId);
    pending.delete(frame.requestId);
    request?.resolve(frame.result);
  }

  /**
   * An error carrying a requestId belongs to one in-flight call and only
   * rejects that promise; a bare error is connection-level and surfaces on
   * the status badge instead.
   */
  function onError(frame: ErrorFrame): void {
    if (frame.requestId !== undefined) {
      const request = pending.get(frame.requestId);
      pending.delete(frame.requestId);
      request?.reject(new Error(frame.message));
      return;
    }
    lastError.set(frame.message);
    if (frame.code === 'version-mismatch') status.set('incompatible');
  }

  function onUnknownFrame(): void {}

  function deliverStreamEvent(
    stream: DevToolsStreamId,
    sequenceNumber: number,
    payload: DevToolsStreamPayload,
  ): void {
    const want = expected.get(stream);
    if (want !== null && want !== undefined && sequenceNumber !== want) {
      // A gap means frames were dropped, so the panel's incremental
      // state is now a guess.  Re-subscribe for a fresh snapshot rather
      // than render a tree that quietly disagrees with reality.
      subscribeOnServer(stream);
      return;
    }
    expected.set(stream, sequenceNumber + 1);
    const streamListeners = listeners.get(stream);
    if (streamListeners) for (const listener of [...streamListeners]) listener(payload);
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function failPending(error: Error): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  open();

  return {
    status: { get: status.get, subscribe: status.subscribe },
    welcome: { get: welcome.get, subscribe: welcome.subscribe },
    lastError: { get: lastError.get, subscribe: lastError.subscribe },

    listen(stream: DevToolsStreamId, listener: StreamListener): () => void {
      let streamListeners = listeners.get(stream);
      if (streamListeners === undefined) {
        streamListeners = new Set();
        listeners.set(stream, streamListeners);
        if (status.get() === 'open') subscribeOnServer(stream);
      }
      streamListeners.add(listener);
      return () => {
        streamListeners.delete(listener);
        if (streamListeners.size > 0) return;
        listeners.delete(stream);
        expected.delete(stream);
        send({ kind: 'unsubscribe', stream });
      };
    },

    request<T>(method: DevToolsRequestMethod, parameters?: unknown): Promise<T> {
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('DevTools is not connected'));
      }
      const requestId = nextRequestId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
        send({ kind: 'request', requestId, method, parameters });
      });
    },
  };
}

/** WebSocket URL of the tap, derived from where the UI was served. */
export function tapUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/ws`;
}

export { DEVTOOLS_PROTOCOL_VERSION };
