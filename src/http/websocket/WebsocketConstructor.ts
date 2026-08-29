/**
 * Runtime-agnostic WebSocket **client** constructor selection.
 *
 * Uses the native `WebSocket` global, which every supported runtime
 * ships (Bun, Deno, Node).  Used by
 * {@link WebsocketClientActor}.  Server-side upgrades never touch
 * this — the HTTP backends own those.
 *
 * **There is deliberately no inbound size limit here, and there is no point
 * adding one.**  The obvious reading of #750 is that
 * {@link WebsocketClientConstructorOptions} should carry `maxFrameBytes` and
 * hand it to the transport, the way the server backends hand `maxPayload` to
 * `ws`.  Measured against this repository's supported runtimes, no native
 * client `WebSocket` honours such a limit: constructing with `maxPayload`,
 * `maxPayloadLength` or `maxFrameBytes` in the options bag succeeds on Bun
 * 1.4.0, Node 26.7.0 and Deno 2.6.8, reads back `undefined` on all three, and
 * a 4 MiB frame is still delivered in full to the `message` listener.  A field
 * here would therefore configure nothing while reading, at every call site,
 * as though the socket were capped — which is exactly the trap 30ec6464
 * documents on the server side, where Bun's `ws` shim accepts `maxPayload`,
 * reports it back unchanged, and enforces nothing.
 *
 * So the client's `maxFrameBytes` is necessarily post-hoc, and what it can
 * still do is make the breach terminal rather than repeatable — see
 * `WebsocketClientActor.rejectOversizeFrame`.  Revisit this only with a live
 * enforcement test (send an over-cap frame, observe that the socket refuses
 * it); a constructor that merely accepts the option proves nothing.
 */
import { Lazy } from '../../util/Lazy.js';

/** Minimal surface of a client WebSocket the client actor depends on. */
export interface WebsocketLike {
  addEventListener(event: 'open' | 'close', listener: () => void): void;
  addEventListener(event: 'error', listener: (ev: unknown) => void): void;
  addEventListener(event: 'message', listener: (ev: { data: unknown }) => void): void;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  ping?(): void;
  /**
   * Which shape binary payloads arrive in on the `message` listener.  The
   * three supported runtimes disagree on the default — `'nodebuffer'` on Bun,
   * `'blob'` on Node and Deno — so {@link WebsocketClientActor} sets it
   * explicitly rather than inheriting one; its
   * `requestArrayBufferPayloads` reasons out why `'blob'` is not usable on a
   * synchronous inbound path.  Optional because a hand-rolled
   * `WebsocketLike` need not have the property; the assignment tolerates its
   * absence.
   */
  binaryType?: 'blob' | 'arraybuffer' | 'nodebuffer';
}

export type WebsocketClientConstructorOptions = {
  readonly protocols?: string | ReadonlyArray<string>;
};

export interface WebsocketClientConstructor {
  create(url: string, options?: WebsocketClientConstructorOptions): WebsocketLike;
}

/** Lazy ctor — resolves once, caches the resolved factory. */
export const websocketClientConstructor: Lazy<Promise<WebsocketClientConstructor>> = Lazy.of(async () => {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error(
      'WebsocketClientActor needs a native global `WebSocket` '
        + '(every supported runtime ships one: Bun, Deno, Node).',
    );
  }
  const NativeWS = globalThis.WebSocket as unknown as new (
    url: string,
    protocols?: string | ReadonlyArray<string>,
  ) => WebsocketLike;
  return {
    create: (url: string, options?: WebsocketClientConstructorOptions): WebsocketLike =>
      new NativeWS(url, options?.protocols),
  };
});
