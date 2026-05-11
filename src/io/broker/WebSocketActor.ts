import type { Config } from '../../config/Config.js';
import type { ActorRef } from '../../ActorRef.js';
import { Lazy } from '../../util/Lazy.js';
import { BrokerActor, type OutboundEnvelope } from './BrokerActor.js';
import type { BrokerCommonSettings } from './BrokerSettings.js';

/** WebSocket message — frames are either text or binary. */
export type WebSocketFrame =
  | { readonly kind: 'text'; readonly data: string }
  | { readonly kind: 'binary'; readonly data: Uint8Array };

export interface WebSocketActorSettings extends BrokerCommonSettings {
  /** WebSocket URL (`ws://...` or `wss://...`). */
  readonly url?: string;
  /** Subprotocols negotiated with the server. */
  readonly protocols?: string | ReadonlyArray<string>;
  /** Custom request headers (Node only — browsers ignore these). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Subscriber that receives every inbound frame.  Required. */
  readonly target?: ActorRef<WebSocketFrame>;
  /** Send a ping every `pingIntervalMs` to keep the connection alive.  Default: disabled. */
  readonly pingIntervalMs?: number;
  /**
   * Maximum allowed size of a single inbound frame, in bytes.
   * Frames larger than this are dropped (logged at warn level)
   * without being forwarded to `target`.  Default: 1 MiB.
   *
   * **Why this exists (security):** a malicious (or compromised) WS
   * peer can send arbitrarily-large frames.  Without a cap, the
   * actor's mailbox grows unbounded if `target` consumes slowly —
   * one 100-MiB frame plus a stalled consumer exhausts the process.
   * Set to `Infinity` to disable (not recommended for public-facing
   * endpoints); raise the cap if you legitimately need bigger
   * frames (audio/video streams).
   */
  readonly maxInboundFrameBytes?: number;
}

export type WebSocketCmd =
  | { readonly kind: 'send'; readonly frame: WebSocketFrame }
  | { readonly kind: 'sendText'; readonly data: string }
  | { readonly kind: 'sendBinary'; readonly data: Uint8Array };

/**
 * WebSocket-client actor.  Picks up the native `WebSocket` API on
 * Bun + Deno; on Node, lazy-imports the `ws` peer-dep.  Either way
 * inbound text/binary frames are routed to `target`; outbound is the
 * standard `enqueueOutbound` path so messages buffered while
 * disconnected are resent after reconnect.
 *
 * Server-side WebSocket upgrades (Hono/Fastify integration) are out of
 * scope for v1 — those need access to the underlying HTTP request,
 * which is backend-specific.
 */
export class WebSocketActor extends BrokerActor<WebSocketActorSettings, WebSocketCmd, WebSocketFrame> {
  private socket: WebSocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(settings: Partial<WebSocketActorSettings> = {}) { super(settings); }

  protected configKey(): string { return 'actor-ts.io.broker.websocket'; }
  protected builtInDefaults(): Partial<WebSocketActorSettings> { return {}; }
  protected readSettingsFromConfig(c: Config): Partial<WebSocketActorSettings> {
    const out: { -readonly [K in keyof WebSocketActorSettings]?: WebSocketActorSettings[K] } = {};
    if (c.hasPath('url')) out.url = c.getString('url');
    if (c.hasPath('protocols')) out.protocols = c.getStringList('protocols');
    if (c.hasPath('pingIntervalMs')) out.pingIntervalMs = c.getDuration('pingIntervalMs');
    if (c.hasPath('headers')) {
      const obj = c.getObject('headers');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') headers[k] = v;
      }
      out.headers = headers;
    }
    return out;
  }
  protected requiredSettings(): ReadonlyArray<keyof WebSocketActorSettings> {
    return ['url', 'target'];
  }
  protected endpointLabel(): string { return this.settings.url ?? '<unknown>'; }

  protected async connectImpl(): Promise<void> {
    const ctor = await wsCtorLazy.get();
    const ws = ctor.create(this.settings.url!, {
      protocols: this.settings.protocols,
      headers: this.settings.headers,
    });
    return new Promise<void>((resolve, reject) => {
      let done = false;
      ws.addEventListener('open', () => {
        if (done) return;
        done = true;
        this.socket = ws;
        ws.addEventListener('message', (ev: { data: unknown }) => {
          this.handleMessage(ev.data);
        });
        ws.addEventListener('close', () => this.handleConnectionLost(new Error('websocket closed')));
        ws.addEventListener('error', (_ev) => this.handleConnectionLost(new Error('websocket error')));
        if (this.settings.pingIntervalMs && this.settings.pingIntervalMs > 0) {
          this.pingTimer = setInterval(() => {
            try { ws.ping?.(); } catch { /* ignore */ }
          }, this.settings.pingIntervalMs);
        }
        resolve();
      });
      ws.addEventListener('error', (_ev) => {
        if (done) return;
        done = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('websocket connect error'));
      });
    });
  }

  protected async disconnectImpl(): Promise<void> {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (!this.socket) return;
    const sock = this.socket;
    this.socket = null;
    try { sock.close(); } catch { /* ignore */ }
  }

  protected async dispatchOutgoing(env: OutboundEnvelope<WebSocketFrame>): Promise<void> {
    if (!this.socket) throw new Error('WebSocketActor: not open');
    const f = env.payload;
    if (f.kind === 'text') this.socket.send(f.data);
    else this.socket.send(f.data);
  }

  override onReceive(cmd: WebSocketCmd): void {
    if (cmd.kind === 'send') this.enqueueOutbound(cmd.frame);
    else if (cmd.kind === 'sendText') this.enqueueOutbound({ kind: 'text', data: cmd.data });
    else this.enqueueOutbound({ kind: 'binary', data: cmd.data });
  }

  /* ------------------------------ inbound ----------------------------- */

  private handleMessage(data: unknown): void {
    const target = this.settings.target;
    if (!target) return;
    const cap = this.settings.maxInboundFrameBytes ?? DEFAULT_WS_MAX_INBOUND_FRAME_BYTES;
    if (typeof data === 'string') {
      // For text, use byte length (UTF-8 worst case is 4× char count
      // but most messages are ASCII-heavy; checking utf8 byte length
      // is the precise measure for "memory consumed").
      const size = utf8ByteLength(data);
      if (size > cap) {
        this.log.warn(
          `WebSocketActor: dropped oversize inbound text frame (${size} > maxInboundFrameBytes ${cap}) ` +
          `from ${this.settings.url}`,
        );
        return;
      }
      target.tell({ kind: 'text', data });
      return;
    }
    if (data instanceof ArrayBuffer) {
      if (data.byteLength > cap) {
        this.log.warn(
          `WebSocketActor: dropped oversize inbound binary frame (${data.byteLength} > maxInboundFrameBytes ${cap}) ` +
          `from ${this.settings.url}`,
        );
        return;
      }
      target.tell({ kind: 'binary', data: new Uint8Array(data) });
      return;
    }
    if (data instanceof Uint8Array) {
      if (data.byteLength > cap) {
        this.log.warn(
          `WebSocketActor: dropped oversize inbound binary frame (${data.byteLength} > maxInboundFrameBytes ${cap}) ` +
          `from ${this.settings.url}`,
        );
        return;
      }
      target.tell({ kind: 'binary', data });
      return;
    }
    // ws-lib delivers Buffer; coerce.
    if (data && typeof (data as { byteLength?: number }).byteLength === 'number') {
      const bl = (data as { byteLength: number }).byteLength;
      if (bl > cap) {
        this.log.warn(
          `WebSocketActor: dropped oversize inbound binary frame (${bl} > maxInboundFrameBytes ${cap}) ` +
          `from ${this.settings.url}`,
        );
        return;
      }
      const u8 = new Uint8Array(data as ArrayBufferLike);
      target.tell({ kind: 'binary', data: u8 });
      return;
    }
    this.log.warn(`WebSocketActor: unrecognised inbound frame type (${typeof data})`);
  }
}

/** Default cap on a single inbound WebSocket frame — 1 MiB. */
export const DEFAULT_WS_MAX_INBOUND_FRAME_BYTES = 1 * 1024 * 1024;

function utf8ByteLength(s: string): number {
  // TextEncoder's encode allocates a Uint8Array, which we'd discard;
  // for the size check alone, hand-roll the UTF-8 byte count.  Saves
  // an allocation in the common case (small messages well under cap).
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) {
      // Surrogate pair → 4-byte sequence; skip the low surrogate.
      bytes += 4; i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/* ----------------------------- internals -------------------------------- */

interface WebSocketLike {
  addEventListener(event: 'open' | 'close', cb: () => void): void;
  addEventListener(event: 'error', cb: (ev: unknown) => void): void;
  addEventListener(event: 'message', cb: (ev: { data: unknown }) => void): void;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  ping?(): void;
}

interface WsCtor {
  create(url: string, opts?: { protocols?: string | ReadonlyArray<string>; headers?: Readonly<Record<string, string>> }): WebSocketLike;
}

/**
 * Lazy ctor — picks the native `WebSocket` (Bun, Deno, modern Node 22+)
 * if available; otherwise lazy-imports the `ws` peer-dep.
 */
const wsCtorLazy: Lazy<Promise<WsCtor>> = Lazy.of(async () => {
  if (typeof globalThis.WebSocket === 'function') {
    const NativeWS = globalThis.WebSocket as unknown as new (
      url: string, protocols?: string | ReadonlyArray<string>,
    ) => WebSocketLike;
    return {
      create: (url: string, opts?: { protocols?: string | ReadonlyArray<string> }): WebSocketLike =>
        new NativeWS(url, opts?.protocols),
    };
  }
  try {
    const name = 'ws';
    const mod = await import(name) as unknown as {
      default?: new (url: string, protocols?: string | ReadonlyArray<string>, opts?: object) => WebSocketLike;
      WebSocket?: new (url: string, protocols?: string | ReadonlyArray<string>, opts?: object) => WebSocketLike;
    };
    const Ctor = mod.WebSocket ?? mod.default;
    if (!Ctor) throw new Error('ws: no constructor exported');
    return {
      create: (
        url: string,
        opts?: { protocols?: string | ReadonlyArray<string>; headers?: Readonly<Record<string, string>> },
      ): WebSocketLike => new Ctor(url, opts?.protocols, { headers: opts?.headers }),
    };
  } catch (e) {
    throw new Error(
      'WebSocketActor needs either a native global `WebSocket` (Bun/Deno/Node ≥22) '
      + 'or the "ws" peer-dep installed.  npm install ws\n'
      + 'Original error: ' + (e instanceof Error ? e.message : String(e)),
    );
  }
});
