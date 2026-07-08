/**
 * Runtime-agnostic WebSocket **client** constructor selection.
 *
 * Picks the native `WebSocket` global (Bun, Deno, Node ≥ 22) when
 * available; otherwise lazy-imports the optional `ws` peer-dependency
 * (Node < 22).  Used by {@link WebsocketClientActor}.  Server-side
 * upgrades never touch this — the HTTP backends own those.
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
  /** Custom request headers — Node/`ws` only; browsers/native ignore them. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface WebsocketClientConstructor {
  create(url: string, opts?: WebsocketClientConstructorOptions): WebsocketLike;
}

/**
 * Lazy ctor — resolves once, caches the resolved factory.  Native
 * `WebSocket` first; `ws` peer-dep fallback with a clear install hint.
 */
export const websocketClientConstructor: Lazy<Promise<WebsocketClientConstructor>> = Lazy.of(async () => {
  if (typeof globalThis.WebSocket === 'function') {
    const NativeWS = globalThis.WebSocket as unknown as new (
      url: string,
      protocols?: string | ReadonlyArray<string>,
    ) => WebsocketLike;
    return {
      create: (url: string, opts?: WebsocketClientConstructorOptions): WebsocketLike =>
        new NativeWS(url, opts?.protocols),
    };
  }
  try {
    const name = 'ws';
    const mod = (await import(name)) as unknown as {
      default?: new (url: string, protocols?: string | ReadonlyArray<string>, opts?: object) => WebsocketLike;
      WebSocket?: new (url: string, protocols?: string | ReadonlyArray<string>, opts?: object) => WebsocketLike;
    };
    const Constructor = mod.WebSocket ?? mod.default;
    if (!Constructor) throw new Error('ws: no constructor exported');
    return {
      create: (url: string, opts?: WebsocketClientConstructorOptions): WebsocketLike =>
        new Constructor(url, opts?.protocols, { headers: opts?.headers }),
    };
  } catch (e) {
    throw new Error(
      'WebsocketClientActor needs either a native global `WebSocket` (Bun/Deno/Node ≥ 22) '
        + 'or the "ws" peer-dep installed.  Install it with: bun add ws\n'
        + 'Original error: '
        + (e instanceof Error ? e.message : String(e)),
    );
  }
});
