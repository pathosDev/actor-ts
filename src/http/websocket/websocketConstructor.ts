/**
 * Runtime-agnostic WebSocket **client** constructor selection.
 *
 * Uses the native `WebSocket` global, which every supported runtime
 * ships (Bun, Deno, Node).  Used by
 * {@link WebsocketClientActor}.  Server-side upgrades never touch
 * this — the HTTP backends own those.
 */
import { Lazy } from '../../util/Lazy.js';

/** Minimal surface of a client WebSocket the client actor depends on. */
export interface WebsocketLike {
  addEventListener(event: 'open' | 'close', cb: () => void): void;
  addEventListener(event: 'error', cb: (ev: unknown) => void): void;
  addEventListener(event: 'message', cb: (ev: { data: unknown }) => void): void;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  ping?(): void;
}

export interface WebsocketClientConstructorOptions {
  readonly protocols?: string | ReadonlyArray<string>;
}

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
